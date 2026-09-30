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
