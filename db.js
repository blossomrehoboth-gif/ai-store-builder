// db.js — persistent storage (Postgres), replacing the old in-memory
// Maps/array so data survives server restarts and redeploys.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // needed for Railway/Render-hosted Postgres
});

// Creates the tables if they don't already exist. Safe to call every
// startup — CREATE TABLE IF NOT EXISTS is a no-op once they're there.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_ali_map (
      shopify_product_id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      variant_id TEXT,
      ali_item_id TEXT,
      ali_image TEXT,
      title TEXT,
      last_known_ali_price DOUBLE PRECISION,
      shopify_price DOUBLE PRECISION,
      last_checked_at TIMESTAMPTZ,
      in_stock BOOLEAN
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      shop TEXT,
      order_number TEXT,
      received_at TIMESTAMPTZ,
      customer_name TEXT,
      address JSONB,
      line_items JSONB,
      fulfilled BOOLEAN DEFAULT FALSE,
      cj_order_id TEXT,
      auto_order_results JSONB
    );
  `);
  console.log('Database tables ready.');
}

// ---------- shops ----------
async function getShopToken(shop) {
  const r = await pool.query('SELECT access_token FROM shops WHERE shop = $1', [shop]);
  return r.rows[0]?.access_token || null;
}

async function setShopToken(shop, token) {
  await pool.query(
    `INSERT INTO shops (shop, access_token) VALUES ($1, $2)
     ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token`,
    [shop, token]
  );
}

// ---------- product <-> AliExpress mapping ----------
async function setAliMapping(shopifyProductId, info) {
  await pool.query(
    `INSERT INTO product_ali_map
       (shopify_product_id, shop, variant_id, ali_item_id, ali_image, title, last_known_ali_price, shopify_price, last_checked_at, in_stock)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (shopify_product_id) DO UPDATE SET
       shop = EXCLUDED.shop, variant_id = EXCLUDED.variant_id, ali_item_id = EXCLUDED.ali_item_id,
       ali_image = EXCLUDED.ali_image, title = EXCLUDED.title,
       last_known_ali_price = EXCLUDED.last_known_ali_price, shopify_price = EXCLUDED.shopify_price,
       last_checked_at = EXCLUDED.last_checked_at, in_stock = EXCLUDED.in_stock`,
    [
      shopifyProductId,
      info.shop,
      info.variantId || null,
      info.aliItemId || null,
      info.aliImage || null,
      info.title || null,
      info.lastKnownAliPrice ?? null,
      info.shopifyPrice ?? null,
      info.lastCheckedAt || null,
      info.inStock ?? null,
    ]
  );
}

async function getAliMapping(shopifyProductId) {
  const r = await pool.query('SELECT * FROM product_ali_map WHERE shopify_product_id = $1', [shopifyProductId]);
  return r.rows[0] ? rowToAliInfo(r.rows[0]) : null;
}

async function getAllAliMappings() {
  const r = await pool.query('SELECT * FROM product_ali_map');
  return r.rows.map((row) => [row.shopify_product_id, rowToAliInfo(row)]);
}

function rowToAliInfo(row) {
  return {
    shop: row.shop,
    variantId: row.variant_id,
    aliItemId: row.ali_item_id,
    aliImage: row.ali_image,
    title: row.title,
    lastKnownAliPrice: row.last_known_ali_price,
    shopifyPrice: row.shopify_price,
    lastCheckedAt: row.last_checked_at,
    inStock: row.in_stock,
  };
}

// ---------- orders ----------
async function insertOrder(order) {
  await pool.query(
    `INSERT INTO orders (order_id, shop, order_number, received_at, customer_name, address, line_items, fulfilled, cj_order_id, auto_order_results)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (order_id) DO NOTHING`,
    [
      String(order.orderId),
      order.shop,
      String(order.orderNumber),
      order.receivedAt,
      order.customerName,
      JSON.stringify(order.address || null),
      JSON.stringify(order.lineItems || []),
      order.fulfilled || false,
      order.cjOrderId || null,
      JSON.stringify(order.autoOrderResults || null),
    ]
  );
}

async function getOrders() {
  const r = await pool.query('SELECT * FROM orders ORDER BY received_at DESC LIMIT 200');
  return r.rows.map(rowToOrder);
}

async function getOrderById(orderId) {
  const r = await pool.query('SELECT * FROM orders WHERE order_id = $1', [String(orderId)]);
  return r.rows[0] ? rowToOrder(r.rows[0]) : null;
}

async function updateOrder(orderId, patch) {
  const current = await getOrderById(orderId);
  if (!current) return;
  const merged = { ...current, ...patch };
  await pool.query(
    `UPDATE orders SET fulfilled = $2, cj_order_id = $3, auto_order_results = $4 WHERE order_id = $1`,
    [String(orderId), merged.fulfilled, merged.cjOrderId, JSON.stringify(merged.autoOrderResults || null)]
  );
}

function rowToOrder(row) {
  return {
    shop: row.shop,
    orderId: row.order_id,
    orderNumber: row.order_number,
    receivedAt: row.received_at,
    customerName: row.customer_name,
    address: row.address,
    lineItems: row.line_items,
    fulfilled: row.fulfilled,
    cjOrderId: row.cj_order_id,
    autoOrderResults: row.auto_order_results,
  };
}

module.exports = {
  initDb,
  getShopToken,
  setShopToken,
  setAliMapping,
  getAliMapping,
  getAllAliMappings,
  insertOrder,
  getOrders,
  getOrderById,
  updateOrder,
};
