// cj.js — CJ Dropshipping integration
const db = require('./db');
const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

let cjToken = null;
let cjTokenExpires = 0;

// CJ limits token requests (1 per 5 min), so cache the token.
async function getCjToken() {
  if (cjToken && Date.now() < cjTokenExpires) return cjToken;
  const apiKey = process.env.CJ_API_KEY;
  if (!apiKey) throw new Error('CJ_API_KEY is not set on the server.');
  const r = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  const json = await r.json();
  if (!json.data?.accessToken) {
    throw new Error(`CJ login failed: ${json.message || r.status}`);
  }
  cjToken = json.data.accessToken;
  cjTokenExpires = Date.now() + 14 * 24 * 60 * 60 * 1000; // token lasts 15 days
  return cjToken;
}

async function cj(path, method = 'GET', body) {
  const token = await getCjToken();
  const r = await fetch(`${CJ_BASE}${path}`, {
    method,
    headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// Searches CJ's catalog by keyword. Returns structured items in the
// same shape the frontend already expects from AliExpress search, so
// script.js barely has to change. Debug-logs the raw shape on first
// use since this endpoint's exact fields haven't been confirmed yet.
async function searchCjProducts(keyword) {
  const json = await cj(`/product/listV2?keyWord=${encodeURIComponent(keyword)}&page=1&size=10`);
  const rawList = json?.data?.content?.[0]?.productList || json?.data?.content || json?.data?.list || [];
  if (rawList.length > 0) {
    console.log('[CJ DEBUG] First raw search item:', JSON.stringify(rawList[0]).slice(0, 500));
  } else {
    console.log('[CJ DEBUG] No items found for keyword:', keyword, '| raw response:', JSON.stringify(json).slice(0, 300));
  }

  return rawList.map((item) => {
    const pid = item.pid || item.id || null;
    const image = item.bigImage || item.productImage || item.productImageSet?.[0] || null;
    const priceRaw = item.sellPrice ?? item.price ?? null;
    const price = priceRaw != null ? parseFloat(priceRaw) : null;
    return {
      pid,
      itemId: pid, // alias so existing frontend code (expects itemId) keeps working
      name: item.productNameEn || item.productName || null,
      image,
      price: Number.isFinite(price) ? price : null,
      rating: null, // CJ search doesn't return a rating in this endpoint
      sold: null,
    };
  }).filter((p) => p.pid);
}

// Fetches one product's full detail, including its variant ID (vid) —
// required so Shopify's SKU can be set to something autoOrderWithCj
// can actually use. Logs the raw shape on first use for the same
// reason as above.
async function getCjProductDetail(pid) {
  const json = await cj(`/product/query?pid=${encodeURIComponent(pid)}`);
  const p = json?.data;
  if (p) {
    console.log('[CJ DEBUG] Product detail raw:', JSON.stringify(p).slice(0, 500));
  }
  const variants = p?.variants || p?.productSkuList || [];
  const firstVariant = variants[0] || {};
  return {
    pid,
    vid: firstVariant.vid || firstVariant.variantId || p?.vid || null,
    name: p?.productNameEn || p?.productName || null,
    image: p?.bigImage || p?.productImage || p?.productImageSet?.[0] || firstVariant.variantImage || null,
    price: firstVariant.variantSellPrice != null ? parseFloat(firstVariant.variantSellPrice) : (p?.sellPrice != null ? parseFloat(p.sellPrice) : null),
  };
}

// Places a CJ order for one incoming order object (mutates it in place
// with cjOrderId / autoOrderResults, same fields the orders.html page
// already knows how to display). Used both automatically (right after
// the Shopify webhook fires) and manually via the retry route below.
async function autoOrderWithCj(order) {
  if (order.cjOrderId) return { ok: false, error: `Already sent to CJ: ${order.cjOrderId}` };
  if (order.cjInFlight) return { ok: false, error: 'Already in progress.' };

  // Safety switch for testing: set CJ_DRY_RUN=true in Render's
  // environment variables to log what WOULD have been ordered,
  // without actually spending any real CJ balance. Remove/set to
  // false when you're ready to go live for real.
  if (String(process.env.CJ_DRY_RUN).toLowerCase() === 'true') {
    console.log(`[CJ DRY RUN] Would place a real CJ order for order #${order.orderNumber}:`, JSON.stringify(order.lineItems));
    order.autoOrderResults = [{ title: 'CJ order (DRY RUN)', success: true, message: 'Dry run only — no real order placed.' }];
    await db.updateOrder(order.orderId, { autoOrderResults: order.autoOrderResults });
    return { ok: true, dryRun: true };
  }

  order.cjInFlight = true;

  const fail = async (message) => {
    order.autoOrderResults = [{ title: 'CJ order', success: false, message }];
    await db.updateOrder(order.orderId, { autoOrderResults: order.autoOrderResults });
    console.error(`CJ auto-order failed for order #${order.orderNumber}: ${message}`);
    return { ok: false, error: message };
  };

  try {
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
    const freight = await cj('/logistic/freightCalculate', 'POST', {
      startCountryCode: process.env.CJ_FROM_COUNTRY || 'CN',
      endCountryCode: a.country_code,
      products,
    });
    const options = Array.isArray(freight.data) ? freight.data : [];
    options.sort((x, y) => Number(x.logisticPrice) - Number(y.logisticPrice));
    if (!options.length) return await fail(`CJ shipping lookup failed: ${freight.message || 'no options'}`);

    const json = await cj('/shopping/order/createOrderV2', 'POST', {
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
  // Quick connection test: open /api/cj/balance in your browser.
  app.get('/api/cj/balance', async (req, res) => {
    try {
      res.json(await cj('/shopping/pay/getBalance'));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Real product search — replaces AliExpress search as the main
  // source of store content.
  app.get('/api/cj-search', async (req, res) => {
    try {
      const q = req.query.q || 'phone';
      const items = await searchCjProducts(q);
      res.json({ items });
    } catch (e) {
      console.error('CJ search error:', e);
      res.json({ items: [] });
    }
  });

  // Fetch one product's detail including its variant ID (vid) — this
  // is what gets saved into Shopify's SKU field at publish time.
  app.get('/api/cj-detail/:pid', async (req, res) => {
    try {
      const detail = await getCjProductDetail(req.params.pid);
      res.json({ ok: true, ...detail });
    } catch (e) {
      console.error('CJ detail error:', e);
      res.json({ ok: false });
    }
  });

  // Look up a CJ product's variants (to find each vid).
  // pid is in the CJ product page URL.
  app.get('/api/cj/product/:pid', async (req, res) => {
    try {
      const json = await cj(`/product/query?pid=${encodeURIComponent(req.params.pid)}`);
      res.json(json.data?.variants ?? json);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Kept as a manual retry option (e.g. if the automatic attempt failed
  // because a SKU/vid was missing at the time). Not used by any button
  // in orders.html anymore — orders are sent to CJ automatically.
  app.post('/api/orders/:orderId/auto-order', async (req, res) => {
    const order = await db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });
    // Allow retrying a previously failed attempt.
    if (order.cjOrderId) return res.json({ ok: false, error: `Already sent to CJ: ${order.cjOrderId}` });
    const result = await autoOrderWithCj(order);
    res.json(result);
  });
};

module.exports.autoOrderWithCj = autoOrderWithCj;
module.exports.searchCjProducts = searchCjProducts;
module.exports.getCjProductDetail = getCjProductDetail;
