// cj.js — CJ Dropshipping integration (multi-user: every call uses the key of the
// user who owns the store / is logged in, never a shared one).
const db = require('./db');
const { requireUser, requireCjKey, cjKeyForShop, encrypt, keyMode, isAdmin } = require('./auth');
const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

// CJ limits token requests (1 per 5 min per account), so cache one token per API key.
const tokenCache = new Map(); // apiKey -> { token, expires }

async function getCjToken(apiKey) {
  if (!apiKey) throw new Error('No CJ API key available.');
  const cached = tokenCache.get(apiKey);
  if (cached && Date.now() < cached.expires) return cached.token;
  const r = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  const json = await r.json();
  if (!json.data?.accessToken) {
    throw new Error(`CJ login failed: ${json.message || r.status}`);
  }
  tokenCache.set(apiKey, { token: json.data.accessToken, expires: Date.now() + 14 * 24 * 60 * 60 * 1000 }); // lasts 15 days
  return json.data.accessToken;
}

// CJ allows ~1 request/second per key. All sellers may share one key, so every
// request waits for its turn instead of failing with "too many requests".
const nextSlot = new Map(); // apiKey -> earliest time the next request may start
async function throttle(apiKey) {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(apiKey) || 0);
  nextSlot.set(apiKey, at + 1100);
  if (at > now) await sleep(at - now);
}

async function cj(apiKey, path, method = 'GET', body, retried = false) {
  await throttle(apiKey);
  const token = await getCjToken(apiKey);
  const r = await fetch(`${CJ_BASE}${path}`, {
    method,
    headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  // CJ allows about 1 request/second; wait and retry once if we hit the limit.
  if (!retried && (r.status === 429 || json.code === 1600200)) {
    await sleep(1500);
    return cj(apiKey, path, method, body, true);
  }
  return json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Product data helpers (replace the old AliExpress API) ----------
// CJ's price is YOUR COST. The price shown/published to Shopify is cost x markup.
// Change the markup with the CJ_MARKUP env var (default 2.5).
const MARKUP = Number(process.env.CJ_MARKUP || 2.5);

function firstNumber(v) {
  const m = String(v ?? '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function retailPrice(cost) {
  if (cost == null || !Number.isFinite(cost)) return null;
  return Math.max(0.99, Math.ceil(cost * MARKUP) - 0.01); // e.g. 7.20 -> 17.99
}

function parseImages(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try { return JSON.parse(t).filter(Boolean); } catch (e) {}
    }
    if (t) return [t];
  }
  return [];
}

// One CJ product with its default (first) variant. The vid is what CJ needs
// to place an order, so it is what gets saved as the Shopify SKU on publish.
async function getCjProduct(apiKey, pid) {
  const json = await cj(apiKey, `/product/query?pid=${encodeURIComponent(pid)}`);
  const d = json.data;
  if (!d) return null;
  const variants = (d.variants || []).map((v) => ({
    vid: v.vid,
    name: v.variantNameEn || v.variantKey || null,
    sku: v.variantSku || null,
    cost: firstNumber(v.variantSellPrice),
    image: v.variantImage || null,
  }));
  const def = variants[0] || null;
  const cost = def?.cost ?? firstNumber(d.sellPrice);
  const images = parseImages(d.productImage);
  return {
    pid: d.pid || pid,
    title: d.productNameEn || null,
    image: images[0] || def?.image || null,
    images: images.slice(0, 6),
    cost,
    price: retailPrice(cost),
    vid: def?.vid || null,
    variants,
  };
}

// Total units CJ reports for a variant, or null if the lookup fails.
async function getCjStock(apiKey, vid) {
  try {
    const json = await cj(apiKey, `/product/stock/queryByVid?vid=${encodeURIComponent(vid)}`);
    if (!Array.isArray(json.data)) return null;
    return json.data.reduce(
      (sum, w) => sum + (Number(w.totalInventory ?? (Number(w.cjInventory || 0) + Number(w.factoryInventory || 0))) || 0),
      0
    );
  } catch (e) {
    return null;
  }
}
// ---------- end product data helpers ----------

// Places a CJ order for one incoming order object (mutates it in place
// with cjOrderId / autoOrderResults, same fields the orders.html page
// already knows how to display). Used both automatically (right after
// the Shopify webhook fires) and manually via the retry route below.
async function autoOrderWithCj(order) {
  if (order.cjOrderId) return { ok: false, error: `Already sent to CJ: ${order.cjOrderId}` };
  if (order.cjInFlight) return { ok: false, error: 'Already in progress.' };
  order.cjInFlight = true;

  const fail = async (message) => {
    order.autoOrderResults = [{ title: 'CJ order', success: false, message }];
    await db.updateOrder(order.orderId, { autoOrderResults: order.autoOrderResults });
    console.error(`CJ auto-order failed for order #${order.orderNumber}: ${message}`);
    return { ok: false, error: message };
  };

  try {
    const apiKey = await cjKeyForShop(order.shop);
    if (!apiKey) return await fail("No CJ API key on file for this store's owner. Add it on the Account page, then retry.");

    const a = order.address;
    if (!a) return await fail('No shipping address on this order.');

    // The CJ variant ID (vid) must be saved as the SKU of the Shopify product.
    const missing = (order.lineItems || []).filter((li) => !li.sku);
    if (missing.length || !(order.lineItems || []).length) {
      return await fail(
        'Missing CJ vid (set it as the SKU in Shopify) for: ' +
          missing.map((li) => li.title).join(', ')
      );
    }
    const products = order.lineItems.map((li) => ({ vid: li.sku, quantity: li.quantity }));

    // Pick the cheapest shipping option for this destination.
    const freight = await cj(apiKey, '/logistic/freightCalculate', 'POST', {
      startCountryCode: process.env.CJ_FROM_COUNTRY || 'CN',
      endCountryCode: a.country_code,
      products,
    });
    const options = Array.isArray(freight.data) ? freight.data : [];
    options.sort((x, y) => Number(x.logisticPrice) - Number(y.logisticPrice));
    if (!options.length) return await fail(`CJ shipping lookup failed: ${freight.message || 'no options'}`);

    const json = await cj(apiKey, '/shopping/order/createOrderV2', 'POST', {
      orderNumber: String(order.orderNumber),
      shippingCountryCode: a.country_code,
      shippingCountry: a.country,
      shippingProvince: a.province,
      shippingCity: a.city,
      shippingAddress: a.address1,
      shippingAddress2: a.address2 || '',
      shippingCustomerName: order.customerName,
      shippingZip: a.zip,
      shippingPhone: a.phone || '',
      logisticName: options[0].logisticName,
      fromCountryCode: process.env.CJ_FROM_COUNTRY || 'CN',
      payType: Number(process.env.CJ_PAY_TYPE || 3), // 3 = create only, 2 = auto-pay
      products,
    });

    if (json.result === true || json.code === 200) {
      order.cjOrderId = json.data?.orderId || json.data?.orderNum || 'created';
      order.autoOrderResults = [
        { title: 'CJ order', success: true, message: `Created CJ order ${order.cjOrderId}` },
      ];
      await db.updateOrder(order.orderId, { cjOrderId: order.cjOrderId, autoOrderResults: order.autoOrderResults });
      console.log(`CJ auto-order placed for order #${order.orderNumber}: ${order.cjOrderId}`);
      return { ok: true, cj: json };
    }
    return await fail(`CJ error: ${json.message || JSON.stringify(json)}`);
  } catch (e) {
    return await fail(`Error: ${e.message || e}`);
  } finally {
    order.cjInFlight = false;
  }
}

module.exports = function registerCj(app) {
  // Save (or replace) the logged-in user's own CJ API key. It is checked with CJ
  // first, then stored encrypted.
  app.post('/api/account/cj-key', requireUser, async (req, res) => {
    try {
      if (keyMode() === 'shared') {
        return res.status(400).json({ error: 'Not needed: this site uses a shared CJ account.' });
      }
      const apiKey = String(req.body?.apiKey || '').trim();
      if (!apiKey) return res.status(400).json({ error: 'Paste your CJ API key.' });
      try {
        await getCjToken(apiKey); // proves CJ accepts it
      } catch (e) {
        return res.status(400).json({ error: 'CJ did not accept that key. Check it and try again.' });
      }
      let encrypted;
      try {
        encrypted = encrypt(apiKey);
      } catch (e) {
        console.error(e.message);
        return res.status(500).json({ error: 'The server is missing APP_SECRET, so keys cannot be stored safely yet.' });
      }
      await db.setUserCjKey(req.user.id, encrypted);
      res.json({ ok: true });
    } catch (e) {
      console.error('Saving CJ key failed:', e);
      res.status(500).json({ error: 'Could not save the key.' });
    }
  });

  // Search CJ for products (replaces /api/aliexpress-search).
  // Returns {items:[{itemId(pid), title, image, price(retail), cost}]}.
  app.get('/api/cj-search', requireUser, requireCjKey, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ items: [] });
      const list = await cj(req.cjKey, `/product/list?pageNum=1&pageSize=8&productNameEn=${encodeURIComponent(q)}`);
      const items = (list.data?.list || [])
        .map((p) => {
          const cost = firstNumber(p.sellPrice);
          return {
            itemId: p.pid,
            title: p.productNameEn || null,
            image: parseImages(p.productImage)[0] || null,
            cost,
            price: retailPrice(cost),
            originalPrice: null,
            rating: null, // CJ doesn't provide ratings or sales counts
            sold: null,
          };
        })
        .filter((it) => it.itemId);
      res.json({ items });
    } catch (e) {
      console.error('CJ search failed:', e);
      res.json({ items: [] });
    }
  });

  // One specific CJ product (used when the seller pastes a CJ link).
  app.get('/api/cj-item/:pid', requireUser, requireCjKey, async (req, res) => {
    try {
      const item = await getCjProduct(req.cjKey, req.params.pid);
      if (!item) return res.json({ ok: false, reason: 'not-found' });
      res.json({
        ok: true,
        item: {
          itemId: item.pid,
          title: item.title,
          image: item.image,
          images: item.images,
          cost: item.cost,
          price: item.price,
          originalPrice: null,
          rating: null,
          sold: null,
        },
      });
    } catch (e) {
      console.error('CJ item lookup failed:', e);
      res.json({ ok: false, reason: 'exception' });
    }
  });

  // Quick connection test: open /api/cj/balance in your browser.
  app.get('/api/cj/balance', requireUser, requireCjKey, async (req, res) => {
    try {
      // With one shared key, the balance is the owner's money: admins only.
      if (keyMode() === 'shared' && !isAdmin(req.user.email)) {
        return res.status(403).json({ error: 'Not allowed.' });
      }
      res.json(await cj(req.cjKey, '/shopping/pay/getBalance'));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // NEW: search CJ by product name and list each match with its variants.
  // Open in your browser: /api/cj/search?q=phone case
  // Copy the "vid" of the variant you want and paste it as the SKU in Shopify.
  app.get('/api/cj/search', requireUser, requireCjKey, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'Add ?q=product name to the address.' });

      const list = await cj(req.cjKey, `/product/list?pageNum=1&pageSize=5&productNameEn=${encodeURIComponent(q)}`);
      const found = (list.data?.list || []).slice(0, 3);
      if (!found.length) {
        return res.json({ message: 'No CJ products found. Try fewer or different words.', raw: list.message || null });
      }

      const results = [];
      for (const p of found) {
        const detail = await cj(req.cjKey, `/product/query?pid=${encodeURIComponent(p.pid)}`);
        const variants = (detail.data?.variants || []).map((v) => ({
          vid: v.vid,
          name: v.variantNameEn || v.variantKey,
          sku: v.variantSku,
          price: v.variantSellPrice,
        }));
        results.push({
          pid: p.pid,
          name: p.productNameEn,
          image: p.productImage,
          price: p.sellPrice,
          variants,
        });
      }
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // NEW: save a CJ vid as the SKU on a Shopify product, no copy/paste in Shopify.
  // Open in your browser:
  //   /api/cj/set-sku?shop=YOUR-STORE.myshopify.com&title=AptCell&vid=1234567890
  // "title" only needs to be part of the Shopify product title.
  app.get('/api/cj/set-sku', requireUser, async (req, res) => {
    try {
      const shop = String(req.query.shop || '').trim();
      const title = String(req.query.title || '').trim().toLowerCase();
      const vid = String(req.query.vid || '').trim();
      if (!shop || !title || !vid) {
        return res.status(400).json({ error: 'Needs shop, title and vid in the address.' });
      }
      const token = await db.getShopTokenForUser(shop, req.user.id);
      if (!token) return res.status(404).json({ error: 'That store is not connected to your account.' });

      const base = `https://${shop}/admin/api/2024-10`;
      const headers = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token };

      const pr = await fetch(`${base}/products.json?limit=250&fields=id,title,variants`, { headers });
      const pj = await pr.json();
      const match = (pj.products || []).find((p) => p.title.toLowerCase().includes(title));
      if (!match) return res.status(404).json({ error: 'No Shopify product title contains that text.' });

      const updated = [];
      for (const v of match.variants || []) {
        const ur = await fetch(`${base}/variants/${v.id}.json`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ variant: { id: v.id, sku: vid } }),
        });
        const uj = await ur.json();
        updated.push({ variantId: v.id, ok: ur.ok, sku: uj.variant?.sku, error: uj.errors || null });
      }
      res.json({ product: match.title, updated });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Look up a CJ product's variants (to find each vid).
  // pid is in the CJ product page URL.
  app.get('/api/cj/product/:pid', requireUser, requireCjKey, async (req, res) => {
    try {
      const json = await cj(req.cjKey, `/product/query?pid=${encodeURIComponent(req.params.pid)}`);
      res.json(json.data?.variants ?? json);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Kept as a manual retry option (e.g. if the automatic attempt failed
  // because a SKU/vid was missing at the time). Not used by any button
  // in orders.html anymore — orders are sent to CJ automatically.
  app.post('/api/orders/:orderId/auto-order', requireUser, async (req, res) => {
    if (!(await db.orderBelongsToUser(req.params.orderId, req.user.id))) {
      return res.status(404).json({ ok: false, error: 'Order not found.' });
    }
    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });
    // Allow retrying a previously failed attempt.
    if (order.cjOrderId) return res.json({ ok: false, error: `Already sent to CJ: ${order.cjOrderId}` });
    const result = await autoOrderWithCj(order);
    res.json(result);
  });
};

module.exports.autoOrderWithCj = autoOrderWithCj;
module.exports.cj = cj;
module.exports.getCjProduct = getCjProduct;
module.exports.getCjStock = getCjStock;
module.exports.retailPrice = retailPrice;
module.exports.sleep = sleep;
