// Postgres storage for AI Store Builder.
// Uses its own table names (sb_...) so it never clashes with older tables.
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const poolConfig = { connectionString: url };
// If the URL has no sslmode setting, turn SSL on for any remote database.
if (!/sslmode=/.test(url)) {
  const hostPart = (url.split('@')[1] || '').split('/')[0].split(':')[0];
  const remote = hostPart.includes('.') && !/^(localhost|127\.0\.0\.1)$/.test(hostPart);
  if (remote) poolConfig.ssl = { rejectUnauthorized: false };
}
const pool = new Pool(poolConfig);

const q = (text, params) => pool.query(text, params);

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS sb_users (
    id SERIAL PRIMARY KEY,
    google_sub TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    cj_api_key_enc TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sb_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES sb_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sb_shops (
    shop TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    user_id INTEGER REFERENCES sb_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sb_product_map (
    shopify_product_id TEXT PRIMARY KEY,
    shop TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sb_orders (
    order_id TEXT PRIMARY KEY,
    shop TEXT NOT NULL,
    order_number TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    customer_name TEXT,
    address JSONB,
    line_items JSONB,
    fulfilled BOOLEAN NOT NULL DEFAULT false,
    total_price NUMERIC,
    currency TEXT,
    cj_order_id TEXT,
    auto_order_results JSONB
  )`);
  // Expiring Shopify tokens (required for new public apps): the access token lasts
  // about an hour and is renewed with a refresh token.
  await q('ALTER TABLE sb_shops ADD COLUMN IF NOT EXISTS refresh_token TEXT');
  await q('ALTER TABLE sb_shops ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ');
  await q('ALTER TABLE sb_shops ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ');
  await q('CREATE INDEX IF NOT EXISTS sb_orders_shop_idx ON sb_orders (shop)');
  await q('CREATE INDEX IF NOT EXISTS sb_product_map_shop_idx ON sb_product_map (shop)');
  console.log('Database tables ready.');
}

// ---------- users & sessions ----------
async function upsertGoogleUser({ sub, email, name }) {
  const r = await q(
    `INSERT INTO sb_users (google_sub, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING id, email, name`,
    [sub, email, name || null]
  );
  return r.rows[0];
}

async function createSession(tokenHash, userId) {
  await q(
    `INSERT INTO sb_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [tokenHash, userId]
  );
  // Tidy up expired sessions now and then.
  await q('DELETE FROM sb_sessions WHERE expires_at < now()');
}

async function getSessionUser(tokenHash) {
  const r = await q(
    `SELECT u.id, u.email, u.name, (u.cj_api_key_enc IS NOT NULL AND u.cj_api_key_enc <> '') AS has_cj_key
     FROM sb_sessions s JOIN sb_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash]
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { id: row.id, email: row.email, name: row.name, hasCjKey: !!row.has_cj_key };
}

async function deleteSession(tokenHash) {
  await q('DELETE FROM sb_sessions WHERE token_hash = $1', [tokenHash]);
}

async function getUserCjKeyEnc(userId) {
  const r = await q('SELECT cj_api_key_enc FROM sb_users WHERE id = $1', [userId]);
  return r.rows[0]?.cj_api_key_enc || null;
}

async function setUserCjKey(userId, encrypted) {
  await q('UPDATE sb_users SET cj_api_key_enc = $2 WHERE id = $1', [userId, encrypted]);
}

// ---------- shops ----------
// tokenInfo (optional): { refreshToken, expiresIn, refreshExpiresIn } straight from Shopify.
// Without it the token is treated as a non-expiring one (stores connected through the old app).
async function setShopToken(shop, token, userId, tokenInfo) {
  const info = tokenInfo || {};
  const secs = (n) => (n ? new Date(Date.now() + Number(n) * 1000) : null);
  await q(
    `INSERT INTO sb_shops (shop, access_token, user_id, refresh_token, token_expires_at, refresh_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (shop) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           user_id = COALESCE(EXCLUDED.user_id, sb_shops.user_id),
           refresh_token = EXCLUDED.refresh_token,
           token_expires_at = EXCLUDED.token_expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at`,
    [shop, token, userId || null, info.refreshToken || null, secs(info.expiresIn), secs(info.refreshExpiresIn)]
  );
}

// ----- keeping the Shopify token fresh -----
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // renew when under 5 minutes are left
const refreshLocks = new Map(); // shop -> in-flight refresh (so two requests never refresh at once)

function refreshShopToken(shop) {
  if (refreshLocks.has(shop)) return refreshLocks.get(shop);
  const p = (async () => {
    try {
      // Read again: another request may have renewed it a moment ago.
      const r = await q('SELECT * FROM sb_shops WHERE shop = $1', [shop]);
      const row = r.rows[0];
      if (!row) return null;
      if (!row.token_expires_at) return row.access_token;
      if (new Date(row.token_expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) return row.access_token;

      const refreshGone = row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() <= Date.now();
      if (!row.refresh_token || refreshGone) {
        console.error(`Shopify refresh token for ${shop} is missing or expired. The store must be reconnected.`);
        return null;
      }

      const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.SHOPIFY_API_KEY,
          client_secret: process.env.SHOPIFY_API_SECRET,
          grant_type: 'refresh_token',
          refresh_token: row.refresh_token,
        }),
      });
      const d = await resp.json().catch(() => ({}));
      if (!d.access_token) {
        console.error(`Shopify token refresh failed for ${shop}:`, d.error || resp.status);
        return null;
      }
      const secs = (n) => (n ? new Date(Date.now() + Number(n) * 1000) : null);
      await q(
        `UPDATE sb_shops
            SET access_token = $2, refresh_token = $3, token_expires_at = $4, refresh_expires_at = $5
          WHERE shop = $1`,
        [shop, d.access_token, d.refresh_token || row.refresh_token, secs(d.expires_in), secs(d.refresh_token_expires_in) || row.refresh_expires_at]
      );
      return d.access_token;
    } finally {
      refreshLocks.delete(shop);
    }
  })();
  refreshLocks.set(shop, p);
  return p;
}

// Returns a token that works right now (renewing it first if needed), or null.
async function validToken(row) {
  if (!row) return null;
  if (!row.token_expires_at) return row.access_token; // non-expiring token
  if (new Date(row.token_expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) return row.access_token;
  return refreshShopToken(row.shop);
}

async function getShopToken(shop) {
  const r = await q('SELECT * FROM sb_shops WHERE shop = $1', [shop]);
  return validToken(r.rows[0]);
}

async function getShopTokenForUser(shop, userId) {
  const r = await q('SELECT * FROM sb_shops WHERE shop = $1 AND user_id = $2', [shop, userId]);
  return validToken(r.rows[0]);
}

async function getShopsForUser(userId) {
  const r = await q('SELECT shop FROM sb_shops WHERE user_id = $1 ORDER BY created_at', [userId]);
  return r.rows.map((x) => x.shop);
}

async function getShopOwnerKey(shop) {
  const r = await q(
    `SELECT s.user_id, u.cj_api_key_enc
     FROM sb_shops s LEFT JOIN sb_users u ON u.id = s.user_id
     WHERE s.shop = $1`,
    [shop]
  );
  if (!r.rows[0]) return null;
  return { userId: r.rows[0].user_id, cjApiKeyEnc: r.rows[0].cj_api_key_enc || null };
}

// ---------- product mappings ----------
async function setProductMapping(shopifyProductId, info) {
  await q(
    `INSERT INTO sb_product_map (shopify_product_id, shop, data)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (shopify_product_id) DO UPDATE SET shop = EXCLUDED.shop, data = EXCLUDED.data`,
    [String(shopifyProductId), info.shop, JSON.stringify(info)]
  );
}

async function getProductMapping(shopifyProductId) {
  const r = await q('SELECT data FROM sb_product_map WHERE shopify_product_id = $1', [String(shopifyProductId)]);
  return r.rows[0]?.data || null;
}

// Returns [[shopifyProductId, info], ...] for the stores this user owns.
async function getAllProductMappings(userId) {
  const r = await q(
    `SELECT p.shopify_product_id, p.data
     FROM sb_product_map p JOIN sb_shops s ON s.shop = p.shop
     WHERE s.user_id = $1`,
    [userId]
  );
  return r.rows.map((x) => [x.shopify_product_id, x.data]);
}

// ---------- scheduled price checks (all shops) ----------
// Used by the new daily cron route (server.js) + priceCheckJob.js.
// Not used anywhere else — the manual "Check prices" button still uses
// getAllProductMappings(userId) above, unchanged.
async function getAllShops() {
  const r = await q('SELECT shop FROM sb_shops ORDER BY created_at');
  return r.rows.map((x) => x.shop);
}

async function getProductMappingsForShop(shop) {
  const r = await q('SELECT shopify_product_id, data FROM sb_product_map WHERE shop = $1', [shop]);
  return r.rows.map((x) => [x.shopify_product_id, x.data]);
}

// ---------- orders ----------
function rowToOrder(r) {
  return {
    shop: r.shop,
    orderId: r.order_id,
    orderNumber: r.order_number,
    receivedAt: new Date(r.received_at).toISOString(),
    customerName: r.customer_name,
    address: r.address || null,
    lineItems: r.line_items || [],
    fulfilled: !!r.fulfilled,
    totalPrice: r.total_price != null ? Number(r.total_price) : null,
    currency: r.currency || null,
    cjOrderId: r.cj_order_id || null,
    autoOrderResults: r.auto_order_results || undefined,
  };
}

async function insertOrder(o) {
  await q(
    `INSERT INTO sb_orders
       (order_id, shop, order_number, received_at, customer_name, address, line_items,
        fulfilled, total_price, currency)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
     ON CONFLICT (order_id) DO NOTHING`,
    [
      String(o.orderId),
      o.shop,
      o.orderNumber != null ? String(o.orderNumber) : null,
      o.receivedAt || new Date().toISOString(),
      o.customerName || null,
      JSON.stringify(o.address || null),
      JSON.stringify(o.lineItems || []),
      !!o.fulfilled,
      o.totalPrice != null ? o.totalPrice : null,
      o.currency || null,
    ]
  );
}

// Newest first, only for stores this user owns.
async function getOrders(userId) {
  const r = await q(
    `SELECT o.* FROM sb_orders o JOIN sb_shops s ON s.shop = o.shop
     WHERE s.user_id = $1
     ORDER BY o.received_at DESC`,
    [userId]
  );
  return r.rows.map(rowToOrder);
}

async function getOrderById(orderId) {
  const r = await q('SELECT * FROM sb_orders WHERE order_id = $1', [String(orderId)]);
  return r.rows[0] ? rowToOrder(r.rows[0]) : null;
}

async function orderBelongsToUser(orderId, userId) {
  const r = await q(
    `SELECT 1 FROM sb_orders o JOIN sb_shops s ON s.shop = o.shop
     WHERE o.order_id = $1 AND s.user_id = $2`,
    [String(orderId), userId]
  );
  return r.rows.length > 0;
}

// Update any of: fulfilled, cjOrderId, autoOrderResults.
async function updateOrder(orderId, fields) {
  const sets = [];
  const vals = [String(orderId)];
  if ('fulfilled' in fields) { vals.push(!!fields.fulfilled); sets.push(`fulfilled = $${vals.length}`); }
  if ('cjOrderId' in fields) { vals.push(fields.cjOrderId != null ? String(fields.cjOrderId) : null); sets.push(`cj_order_id = $${vals.length}`); }
  if ('autoOrderResults' in fields) { vals.push(JSON.stringify(fields.autoOrderResults)); sets.push(`auto_order_results = $${vals.length}::jsonb`); }
  if (!sets.length) return;
  await q(`UPDATE sb_orders SET ${sets.join(', ')} WHERE order_id = $1`, vals);
}

// ---------- privacy (GDPR) ----------
// Blank the customer's name and address on the orders Shopify lists.
async function redactCustomerOrders(shop, orderIds) {
  const ids = (orderIds || []).map(String);
  if (!ids.length) return;
  await q(
    `UPDATE sb_orders SET customer_name = 'Redacted', address = NULL
     WHERE shop = $1 AND order_id = ANY($2::text[])`,
    [shop, ids]
  );
}

// Delete everything we hold for a store that uninstalled the app.
async function deleteShopData(shop) {
  await q('DELETE FROM sb_orders WHERE shop = $1', [shop]);
  await q('DELETE FROM sb_product_map WHERE shop = $1', [shop]);
  await q('DELETE FROM sb_shops WHERE shop = $1', [shop]);
}

module.exports = {
  initDb,
  upsertGoogleUser,
  createSession,
  getSessionUser,
  deleteSession,
  getUserCjKeyEnc,
  setUserCjKey,
  setShopToken,
  getShopToken,
  getShopTokenForUser,
  getShopsForUser,
  getShopOwnerKey,
  setProductMapping,
  getProductMapping,
  getAllProductMappings,
  getAllShops,
  getProductMappingsForShop,
  insertOrder,
  getOrders,
  getOrderById,
  orderBelongsToUser,
  updateOrder,
  redactCustomerOrders,
  deleteShopData,
};
