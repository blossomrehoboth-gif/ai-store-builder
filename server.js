// server.js — AI Store Builder backend
//
// Takes { product, audience, tone } from the frontend, asks Groq for a
// store concept (name, tagline, spotlight product page content, sample
// products, ad line), and returns it as JSON. Also handles the Shopify
// app install (OAuth) so a seller can connect their real store.
// Product data (search, photos, prices, stock) now comes from the CJ
// Dropshipping API — AliExpress is no longer used.
//
// Persistent data (connected shops, CJ<->Shopify product
// mappings, incoming orders) now lives in Postgres via db.js, so it
// survives server restarts/redeploys instead of resetting each time.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { renderTemplate } = require('./templater');
const db = require('./db');
const auth = require('./auth');
const { requireUser, requireCjKey } = auth;

const app = express();
app.set('trust proxy', 1); // behind Render's proxy: needed for HTTPS cookies and correct IPs
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) return next(); // webhooks need the raw body for signature checks
  express.json()(req, res, next);
});
app.use(auth.attachUser);   // who is logged in?
app.use(auth.gatePages);    // builder / orders / account pages need a login
app.use(express.static(path.join(__dirname, 'public')));
auth.registerAuthRoutes(app);

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/account', (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// Clean URL for the orders page (the file itself is public/orders.html).
app.get('/orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'orders.html'));
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

// Stops one account from using up the AI quota (resets on restart / each day).
const generateUsage = new Map();
function overGenerateLimit(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const rec = generateUsage.get(userId);
  const limit = Number(process.env.GENERATE_LIMIT || 30);
  if (!rec || rec.day !== day) { generateUsage.set(userId, { day, count: 1 }); return false; }
  rec.count += 1;
  return rec.count > limit;
}

app.post('/api/generate', requireUser, async (req, res) => {
  try {
    if (overGenerateLimit(req.user.id)) {
      return res.status(429).json({ error: 'Daily generation limit reached. Try again tomorrow.' });
    }
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'Server is missing GROQ_API_KEY.' });
    }

    const product = (req.body.product || '').trim();
    const audience = (req.body.audience || '').trim() || 'general online shoppers';
    const tone = (req.body.tone || '').trim() || 'Premium';

    if (!product) {
      return res.status(400).json({ error: 'A product or niche is required.' });
    }

    const prompt = `You are building a single-product landing page for a dropshipping seller, in the style of a high-converting DTC product page: big headline, feature checklist, a "why choose us" comparison table, a short usage guide, and sample customer reviews.

Product or niche: ${product}
Target audience: ${audience}
Brand tone: ${tone}

Return ONLY a JSON object, with no markdown fences and no commentary, matching exactly this shape:
{
  "storeName": "short brandable store name, 1-3 words",
  "domainHint": "storename.com style lowercase slug, no spaces",
  "tagline": "one line, under 8 words",
  "heroHeadline": "a punchy headline for the spotlight product, under 12 words",
  "brandStory": "two sentences about why this store exists, written in the given tone",
  "accentColor": "a single hex color that fits the tone and product, e.g. #7A5CFA",
  "featureChecklist": ["short benefit phrase", "short benefit phrase", "short benefit phrase", "short benefit phrase"],
  "comparisonTable": [
    {"category": "Setup", "us": "short phrase, e.g. 'No tools needed'", "them": "short phrase, e.g. 'Complicated setup'"},
    {"category": "Results", "us": "short phrase", "them": "short phrase"},
    {"category": "Durability", "us": "short phrase", "them": "short phrase"}
  ],
  "usageSteps": [
    {"title": "short step title, 2-4 words", "detail": "one sentence"},
    {"title": "short step title, 2-4 words", "detail": "one sentence"},
    {"title": "short step title, 2-4 words", "detail": "one sentence"},
    {"title": "short step title, 2-4 words", "detail": "one sentence"}
  ],
  "reviews": [
    {"name": "First name + last initial", "rating": 5, "quote": "a short, specific, believable customer quote, under 25 words"},
    {"name": "First name + last initial", "rating": 5, "quote": "a short, specific, believable customer quote, under 25 words"},
    {"name": "First name + last initial", "rating": 4, "quote": "a short, specific, believable customer quote, under 25 words"}
  ],
  "products": [
    {"name": "product name", "description": "one sentence, under 20 words", "price": "price like $24.99"},
    {"name": "product name", "description": "one sentence, under 20 words", "price": "price like $24.99"},
    {"name": "product name", "description": "one sentence, under 20 words", "price": "price like $24.99"}
  ],
  "adLine": "one short ad headline for a social ad, under 10 words",
  "announcementText": "a short urgency/shipping line for a scrolling top banner, under 8 words, e.g. 'FREE TRACKED DELIVERY \u00b7 LIMITED STOCK'",
  "faq": [
    {"question": "a real customer question about this product, under 12 words", "answer": "a clear one-sentence answer"},
    {"question": "a real customer question about this product, under 12 words", "answer": "a clear one-sentence answer"},
    {"question": "a real customer question about this product, under 12 words", "answer": "a clear one-sentence answer"},
    {"question": "a real customer question about this product, under 12 words", "answer": "a clear one-sentence answer"}
  ]
}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        max_tokens: 2800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Groq API error:', detail);
      return res.status(502).json({ error: 'The AI request failed.', detail });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    let cleaned = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          parsed = JSON.parse(cleaned.slice(start, end + 1));
        } catch (e2) {
          return res.status(502).json({ error: 'Could not parse the AI response as JSON.' });
        }
      } else {
        return res.status(502).json({ error: 'Could not parse the AI response as JSON.' });
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---------- Shopify install / OAuth ----------
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES = 'read_products,write_products,read_publications,write_publications,read_orders';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

// OAuth state only needs to survive a few seconds during the install
// flow, so this one stays in memory — nothing important is lost if it resets.
const pendingStates = new Map();

function validShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || '');
}

function validHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');
  const digest = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/auth', requireUser, (req, res) => {
  const shop = req.query.shop;
  if (!validShop(shop)) return res.status(400).send('Invalid shop.');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { shop, userId: req.user.id });
  const redirectUri = encodeURIComponent(`${APP_URL}/auth/callback`);
  res.redirect(
    `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}` +
      `&scope=${SHOPIFY_SCOPES}&redirect_uri=${redirectUri}&state=${state}`
  );
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, state } = req.query;
    if (!validShop(shop)) return res.status(400).send('Invalid shop.');

    // Shopify can open the app without an install code; send those through /auth.
    if (!code) return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);

    if (!validHmac(req.query)) return res.status(400).send('Invalid signature.');
    const pending = pendingStates.get(state);
    if (!pending || pending.shop !== shop) return res.status(400).send('Invalid state. Start again from the Account page.');
    pendingStates.delete(state);

    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });
    const data = await r.json();
    if (!data.access_token) {
      console.error('Token exchange failed:', data);
      return res.status(502).send('Could not connect to Shopify.');
    }

    // The store now belongs to the user who started the connection.
    await db.setShopToken(shop, data.access_token, pending.userId);
    console.log('Connected shop:', shop, 'for user', pending.userId);
    res.redirect(`/account?connected=${encodeURIComponent(shop)}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
});
// ---------- end Shopify install / OAuth ----------

// ---------- Order fulfillment ----------
// Registers a webhook so Shopify tells us immediately when a real
// order is placed. Safe to call every publish — Shopify just returns
// the existing one if it's already registered for this topic/address.
async function ensureOrderWebhook(shop, token) {
  try {
    const apiVersion = '2024-10';
    const address = `${APP_URL}/webhooks/orders-create`;
    const r = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({
        query: `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
            webhookSubscription { id }
            userErrors { field message }
          }
        }`,
        variables: {
          topic: 'ORDERS_CREATE',
          webhookSubscription: { callbackUrl: address, format: 'JSON' },
        },
      }),
    });
    const data = await r.json();
    const errs = data?.data?.webhookSubscriptionCreate?.userErrors;
    if (errs && errs.length && !errs.some((e) => /already/i.test(e.message))) {
      console.error('Webhook registration issue:', errs);
    }
  } catch (err) {
    console.error('Could not register order webhook:', err);
  }
}

// Verifies the request really came from Shopify, not someone else
// pretending to be Shopify.
function validWebhookHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch (e) {
    return false;
  }
}

// Shopify posts here the moment a customer completes a real order.
// Raw body is needed (not the parsed JSON) to check the signature.
app.post('/webhooks/orders-create', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    if (!validWebhookHmac(req.body, hmac)) {
      return res.status(401).send('Invalid signature.');
    }
    const shop = req.get('X-Shopify-Shop-Domain');
    const order = JSON.parse(req.body.toString('utf8'));

    const lineItems = await Promise.all(
      (order.line_items || []).map(async (li) => {
        const mapped = await db.getProductMapping(`gid://shopify/Product/${li.product_id}`);
        return {
          title: li.title,
          quantity: li.quantity,
          // Use the Shopify SKU if set, otherwise fall back to the CJ vid saved at publish time.
          sku: li.sku || mapped?.cjVid || null,
          cjPid: mapped?.cjPid || null,
          // aliLink / aliImage are kept as field names so the existing orders.html
          // keeps working; they now hold the CJ product link and photo.
          aliLink: mapped?.cjPid ? `https://cjdropshipping.com/product/p-${mapped.cjPid}.html` : null,
          aliImage: mapped?.image || null,
        };
      })
    );

    const newOrder = {
      shop,
      orderId: order.id,
      orderNumber: order.order_number || order.name,
      receivedAt: new Date().toISOString(),
      customerName: [order.shipping_address?.first_name, order.shipping_address?.last_name].filter(Boolean).join(' ') || order.customer?.first_name || 'Customer',
      address: order.shipping_address || null,
      lineItems,
      fulfilled: false,
      totalPrice: order.total_price != null ? parseFloat(order.total_price) : null,
      currency: order.currency || null,
    };
    await db.insertOrder(newOrder);

    console.log(`New order #${order.order_number} from ${shop} — ${lineItems.length} item(s)`);
    res.status(200).send('ok');

    // Fire off the CJ order right away — don't make Shopify wait for it.
    require('./cj').autoOrderWithCj(newOrder).catch((err) => {
      console.error(`CJ auto-order threw for order #${newOrder.orderNumber}:`, err);
    });
  } catch (err) {
    console.error('Webhook handling error:', err);
    res.status(200).send('ok'); // still 200 so Shopify doesn't retry forever
  }
});

// ---------- Shopify privacy (GDPR) webhooks ----------
// Shopify requires these three for every public app. Each one checks the
// signature first and answers 401 if it is not really from Shopify.
function privacyWebhook(handler) {
  return [
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      try {
        if (!validWebhookHmac(req.body, req.get('X-Shopify-Hmac-Sha256'))) {
          return res.status(401).send('Invalid signature.');
        }
        const payload = JSON.parse(req.body.toString('utf8') || '{}');
        await handler(payload);
        res.status(200).send('ok');
      } catch (err) {
        console.error('Privacy webhook error:', err);
        res.status(500).send('error');
      }
    },
  ];
}

// A customer asked to see their data. Orders are the only place we keep it
// (name, address, items), and the store owner can already see them in Shopify.
app.post('/webhooks/customers-data-request', ...privacyWebhook(async (p) => {
  console.log('Privacy: data request from', p.shop_domain, 'for customer', p.customer?.id);
}));

// A customer asked to be erased: blank their name and address on their orders.
app.post('/webhooks/customers-redact', ...privacyWebhook(async (p) => {
  await db.redactCustomerOrders(p.shop_domain, p.orders_to_redact);
  console.log('Privacy: redacted customer', p.customer?.id, 'on', p.shop_domain);
}));

// A store uninstalled the app 48 hours ago: delete everything we hold for it.
app.post('/webhooks/shop-redact', ...privacyWebhook(async (p) => {
  await db.deleteShopData(p.shop_domain);
  console.log('Privacy: deleted all data for', p.shop_domain);
}));
// ---------- end privacy webhooks ----------

// ---------- Price & inventory monitoring ----------
// Manual-trigger only (you tap a button). Checks CJ's current cost and stock
// for every published product. CJ allows ~1 request/second, so this takes
// about 2 seconds per product.
const { getCjProduct, getCjStock, sleep } = require('./cj');

app.post('/api/check-prices', requireUser, requireCjKey, async (req, res) => {
  try {
    const results = [];
    const entries = await db.getAllProductMappings(req.user.id);

    for (const [shopifyProductId, info] of entries) {
      const token = await db.getShopToken(info.shop);
      if (!token) {
        results.push({ title: info.title, ok: false, reason: 'shop-not-connected' });
        continue;
      }

      const product = info.cjPid ? await getCjProduct(req.cjKey, info.cjPid) : null;
      if (!product) {
        results.push({ title: info.title, ok: false, reason: 'not-found' });
        continue;
      }

      // Use the exact variant we sell, not just the default one.
      const variant = (product.variants || []).find((v) => v.vid === info.cjVid);
      const newCost = variant?.cost ?? product.cost;

      let inStock = null;
      if (info.cjVid) {
        const units = await getCjStock(req.cjKey, info.cjVid);
        inStock = units == null ? null : units > 0;
      }

      info.lastCheckedAt = new Date().toISOString();
      info.inStock = inStock;

      if (newCost == null || info.lastKnownCost == null) {
        info.lastKnownCost = newCost;
        await db.setProductMapping(shopifyProductId, info);
        results.push({ title: info.title, ok: true, changed: false, inStock });
        continue;
      }

      const costChanged = Math.abs(newCost - info.lastKnownCost) > 0.01;
      if (costChanged && info.variantId && info.shopifyPrice != null && info.lastKnownCost > 0) {
        // Keep the same markup: scale Shopify's price by the same ratio the cost moved.
        const newShopifyPrice = Math.max(0.01, info.shopifyPrice * (newCost / info.lastKnownCost));

        await fetch(`https://${info.shop}/admin/api/2024-10/graphql.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({
            query: `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { field message }
              }
            }`,
            variables: {
              productId: shopifyProductId,
              variants: [{ id: info.variantId, price: newShopifyPrice.toFixed(2) }],
            },
          }),
        });

        const oldCost = info.lastKnownCost;
        info.shopifyPrice = newShopifyPrice;
        info.lastKnownCost = newCost;
        await db.setProductMapping(shopifyProductId, info);
        // oldAliPrice / newAliPrice are kept as key names so the current orders.html still reads them.
        results.push({ title: info.title, ok: true, changed: true, oldAliPrice: oldCost, newAliPrice: newCost, newShopifyPrice, inStock });
      } else {
        await db.setProductMapping(shopifyProductId, info);
        results.push({ title: info.title, ok: true, changed: false, inStock });
      }
    }

    // Email me about anything that needs attention (price changed / out of stock).
    try {
      const problems = results.filter((r) => r.ok && (r.changed || r.inStock === false));
      if (problems.length) {
        const lines = problems.map((r) => {
          const parts = [];
          if (r.changed) parts.push(`supplier price $${Number(r.oldAliPrice).toFixed(2)} -> $${Number(r.newAliPrice).toFixed(2)} (your price now $${Number(r.newShopifyPrice).toFixed(2)})`);
          if (r.inStock === false) parts.push('OUT OF STOCK at CJ');
          return `- ${r.title}: ${parts.join('; ')}`;
        });
        require('./mailer').sendAlert(
          `Store alert: ${problems.length} product${problems.length > 1 ? 's' : ''} need attention`,
          lines.join('\n')
        );
      }
    } catch (e) { console.error('Alert build failed:', e); }

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking prices.' });
  }
});

app.get('/api/price-status', requireUser, async (req, res) => {
  const entries = await db.getAllProductMappings(req.user.id);
  // aliItemId / lastKnownAliPrice kept as aliases for the current orders.html.
  const items = entries.map(([shopifyProductId, info]) => ({
    shopifyProductId,
    ...info,
    aliItemId: info.cjPid,
    lastKnownAliPrice: info.lastKnownCost,
  }));
  res.json({ items });
});
// ---------- end price & inventory monitoring ----------

// ---------- Seller dashboard ----------
function orderStatus(o) {
  if (o.fulfilled) return 'fulfilled';
  if (o.cjOrderId) return 'sent';
  if (o.autoOrderResults?.[0]?.success === false) return 'failed';
  return 'processing';
}

app.get('/api/dashboard', requireUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const [shops, orders, mappings] = await Promise.all([
      db.getShopsForUser(userId),
      db.getOrders(userId),
      db.getAllProductMappings(userId),
    ]);

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const money = {}; // currency -> { total, week }
    const counts = { total: 0, week: 0, sent: 0, fulfilled: 0, failed: 0, processing: 0 };
    const perShop = Object.fromEntries(shops.map((s) => [s, { shop: s, orders: 0, products: 0, revenue: 0 }]));

    for (const o of orders) {
      const st = orderStatus(o);
      counts.total += 1;
      counts[st] += 1;
      const recent = new Date(o.receivedAt).getTime() >= weekAgo;
      if (recent) counts.week += 1;
      if (o.totalPrice != null) {
        const cur = o.currency || 'USD';
        money[cur] = money[cur] || { total: 0, week: 0 };
        money[cur].total += o.totalPrice;
        if (recent) money[cur].week += o.totalPrice;
        if (perShop[o.shop]) perShop[o.shop].revenue += o.totalPrice;
      }
      if (perShop[o.shop]) perShop[o.shop].orders += 1;
    }

    const products = mappings.map(([id, m]) => {
      if (perShop[m.shop]) perShop[m.shop].products += 1;
      return {
        title: m.title,
        shop: m.shop,
        image: m.image,
        cost: m.lastKnownCost,
        price: m.shopifyPrice,
        profit: m.lastKnownCost != null && m.shopifyPrice != null ? m.shopifyPrice - m.lastKnownCost : null,
        inStock: m.inStock,
        lastCheckedAt: m.lastCheckedAt,
      };
    });

    // CJ balance. With the shared key it is the owner's money, so only admins see it.
    const shared = auth.keyMode() === 'shared';
    let cjBalance = null;
    try {
      let key = null;
      if (shared) {
        if (auth.isAdmin(req.user.email)) key = process.env.CJ_API_KEY || null;
      } else {
        key = auth.decrypt(await db.getUserCjKeyEnc(userId));
      }
      if (key) {
        const b = await require('./cj').cj(key, '/shopping/pay/getBalance');
        const amt = b?.data?.amount ?? b?.data?.balance ?? null;
        cjBalance = amt != null ? Number(amt) : null;
      }
    } catch (e) {
      console.error('CJ balance lookup failed:', e.message || e);
    }

    res.json({
      email: req.user.email,
      keyMode: auth.keyMode(),
      hasCjKey: shared ? true : req.user.hasCjKey,
      cjBalance,
      counts,
      money,
      shops: Object.values(perShop),
      products,
      outOfStock: products.filter((p) => p.inStock === false).length,
      orders: orders.slice(0, 10).map((o) => ({
        orderId: o.orderId,
        orderNumber: o.orderNumber,
        shop: o.shop,
        receivedAt: o.receivedAt,
        customerName: o.customerName,
        status: orderStatus(o),
        message: o.autoOrderResults?.[0]?.message || null,
        total: o.totalPrice,
        currency: o.currency,
        items: (o.lineItems || []).map((li) => `${li.quantity} × ${li.title}`),
      })),
    });
  } catch (err) {
    console.error('Dashboard failed:', err);
    res.status(500).json({ error: 'Could not load the dashboard.' });
  }
});
// ---------- end seller dashboard ----------

app.get('/api/orders', requireUser, async (req, res) => {
  res.json({ orders: await db.getOrders(req.user.id) });
});

app.post('/api/orders/:orderId/fulfilled', requireUser, async (req, res) => {
  if (!(await db.orderBelongsToUser(req.params.orderId, req.user.id))) {
    return res.json({ ok: false });
  }
  await db.updateOrder(req.params.orderId, { fulfilled: true });
  res.json({ ok: true });
});
// ---------- end order fulfillment ----------
require('./cj')(app); // CJ Dropshipping: product search/lookup, balance, SKU tools, manual retry route
require('./research')(app); // CJ product research (winners finder)
require('./tracking')(app, auth, db); // CJ order status + tracking numbers

// Sends one test email so you can confirm alerts work. Open /api/test-email while logged in.
app.get('/api/test-email', requireUser, async (req, res) => {
  const ok = await require('./mailer').sendAlert('Test alert from AI Store Builder', 'If you can read this, email alerts are working.');
  res.json({ sent: ok });
});

// ---------- Publish generated concept to Shopify ----------
// Uses the REST Admin API to mark a product published — this avoids the
// GraphQL `publications` query, which regular (non-channel) custom apps
// often can't read even with the right scopes. REST's `published: true`
// does the same thing in one simple call with no extra permissions.
async function publishProductRest(shop, token, gidOrNumericId) {
  const numericId = String(gidOrNumericId).split('/').pop();
  const r = await fetch(`https://${shop}/admin/api/2024-10/products/${numericId}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ product: { id: Number(numericId), published: true } }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error(`Could not publish product ${numericId}:`, data);
  }
  return r.ok;
}

// Shows what actually exists in the shop: open /api/shop-products?shop=your-shop.myshopify.com
app.get('/api/shop-products', requireUser, async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!validShop(shop)) return res.status(400).json({ error: 'Invalid shop.' });
    const token = await db.getShopTokenForUser(shop, req.user.id);
    if (!token) return res.status(403).json({ error: 'That store is not connected to your account.' });
    const r = await fetch(
      `https://${shop}/admin/api/2024-10/products.json?limit=50&fields=id,title,status,published_at,created_at`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const data = await r.json();
    res.json({ httpStatus: r.status, products: data.products || [], raw: data.products ? undefined : data });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// New products created through the API are NOT automatically in the theme's
// "Featured products" (Home page) collection, so they never show on the homepage.
// This adds a product to the default "Home page" collection (handle: frontpage).
async function addToHomepageCollection(shop, token, gidOrNumericId) {
  try {
    const base = `https://${shop}/admin/api/2024-10`;
    const headers = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token };
    const cr = await fetch(`${base}/custom_collections.json?handle=frontpage&fields=id`, { headers });
    const cj = await cr.json();
    const collectionId = cj.custom_collections?.[0]?.id;
    if (!collectionId) return false;
    const productId = Number(String(gidOrNumericId).split('/').pop());
    const r = await fetch(`${base}/collects.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ collect: { product_id: productId, collection_id: collectionId } }),
    });
    return r.ok;
  } catch (e) {
    console.error('Could not add to Home page collection:', e);
    return false;
  }
}

function plainText(html, max) {
  const t = String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).replace(/\s\S*$/, '') + '…' : t;
}

app.post('/api/publish', requireUser, requireCjKey, async (req, res) => {
  try {
    const { shop, concept } = req.body;
    if (!validShop(shop)) {
      return res.status(400).json({ error: 'Invalid shop.' });
    }
    const token = await db.getShopTokenForUser(shop, req.user.id);
    if (!token) {
      return res.status(403).json({ error: 'That store is not connected to your account. Connect it on the Account page first.' });
    }
    if (!concept || !Array.isArray(concept.products) || concept.products.length === 0) {
      return res.status(400).json({ error: 'Missing store concept or products to publish.' });
    }

    const apiVersion = '2024-10';
    const graphqlUrl = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

    async function shopifyGraphQL(query, variables) {
      const r = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
      });
      return r.json();
    }

    const results = [];

    for (const p of concept.products) {
      const createData = await shopifyGraphQL(
        `mutation productCreate($input: ProductInput!) {
          productCreate(input: $input) {
            product {
              id
              title
              variants(first: 1) { edges { node { id } } }
            }
            userErrors { field message }
          }
        }`,
        {
          input: {
            title: p.name,
            descriptionHtml: p.description ? `<p>${p.description}</p>` : '',
            vendor: concept.storeName || 'AI Store Builder',
          },
        }
      );

      const createErrors = createData.data?.productCreate?.userErrors;
      if (createErrors && createErrors.length) {
        results.push({ name: p.name, ok: false, error: createErrors.map((e) => e.message).join(', ') });
        continue;
      }

      if (createData.errors || !createData.data?.productCreate?.product) {
        const detail = JSON.stringify(createData.errors || createData).slice(0, 300);
        console.error(`Shopify did not create "${p.name}":`, detail);
        results.push({ name: p.name, ok: false, error: `Shopify did not create it: ${detail}` });
        continue;
      }

      const product = createData.data?.productCreate?.product;
      const variantId = product?.variants?.edges?.[0]?.node?.id;

      // Look up the real CJ variant (vid) and cost for this product. The vid is
      // saved as the Shopify SKU so CJ orders work with no manual SKU step.
      let cj = null;
      if (p.cjPid) {
        try {
          cj = await getCjProduct(req.cjKey, p.cjPid);
        } catch (e) {
          console.error(`CJ lookup failed for ${p.cjPid}:`, e);
        }
      }

      let priceNumber = p.price ? parseFloat(String(p.price).replace(/[^0-9.]/g, '')) : null;
      if (cj?.price != null) priceNumber = cj.price; // always cost x markup, never below cost

      if (variantId && (priceNumber != null || cj?.vid)) {
        const variantInput = { id: variantId };
        if (priceNumber != null) variantInput.price = priceNumber.toFixed(2);
        if (cj?.vid) variantInput.inventoryItem = { sku: cj.vid };
        const upd = await shopifyGraphQL(
          `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }`,
          { productId: product.id, variants: [variantInput] }
        );
        const updErrors = upd.data?.productVariantsBulkUpdate?.userErrors;
        if (updErrors && updErrors.length) console.error('Variant update issue:', updErrors);
      }

      // Product photo from CJ.
      const imageSrc = cj?.image || p.cjImage;
      if (product?.id && imageSrc) {
        try {
          const numericId = String(product.id).split('/').pop();
          await fetch(`https://${shop}/admin/api/${apiVersion}/products/${numericId}/images.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({ image: { src: imageSrc } }),
          });
        } catch (e) {
          console.error('Could not add product image:', e);
        }
      }

      // Publishing the product alone doesn't make it visible on the
      // storefront — it has to be explicitly marked published.
      let publishedOk = false;
      if (product?.id) {
        publishedOk = await publishProductRest(shop, token, product.id);
        await addToHomepageCollection(shop, token, product.id);
      }

      if (product?.id && p.cjPid) {
        await db.setProductMapping(product.id, {
          shop,
          variantId: variantId || null,
          cjPid: p.cjPid,
          cjVid: cj?.vid || null,
          image: imageSrc || null,
          title: p.name,
          lastKnownCost: cj?.cost ?? (p.cjCost != null ? p.cjCost : null),
          shopifyPrice: priceNumber,
          lastCheckedAt: null,
        });
      }

      const warning = !publishedOk
        ? 'Created in Shopify but could not be made visible on the Online Store (check the server logs).'
        : !p.cjPid
        ? 'No CJ product linked — set a CJ vid as the SKU before orders can be sent to CJ.'
        : !cj?.vid
        ? 'Could not read the CJ variant — set the CJ vid as the SKU manually.'
        : null;
      results.push({ name: p.name, ok: true, id: product?.id, warning });
    }

    // Make sure this shop is set up to notify us the moment a real
    // order comes in, so fulfillment info shows up automatically.
    await ensureOrderWebhook(shop, token);

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong publishing to Shopify.' });
  }
});
// One-time cleanup: publish every existing product in this shop to the
// Online Store channel (fixes products created before the fix above).
// Visit this URL once in your browser: /api/publish-existing?shop=your-shop.myshopify.com
app.get('/api/publish-existing', requireUser, async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!validShop(shop)) return res.status(400).json({ error: 'Invalid shop.' });
    const token = await db.getShopTokenForUser(shop, req.user.id);
    if (!token) return res.status(403).json({ error: 'That store is not connected to your account.' });

    let count = 0;
    let pageInfo = '';
    let hasNext = true;
    while (hasNext) {
      const r = await fetch(
        `https://${shop}/admin/api/2024-10/products.json?limit=50&fields=id${pageInfo}`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const data = await r.json();
      const products = data.products || [];
      for (const p of products) {
        await publishProductRest(shop, token, p.id);
        count++;
      }

      // REST pagination: Shopify returns a Link header with a page_info
      // cursor when there's more to fetch.
      const link = r.headers.get('link') || '';
      const match = link.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      if (match) {
        pageInfo = `&page_info=${match[1]}`;
      } else {
        hasNext = false;
      }
    }

    res.json({ ok: true, publishedCount: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});
// ---------- end publish ----------

// ---------- Template-based page rendering (35 design library) ----------
app.post('/api/render-template', requireUser, (req, res) => {
  try {
    const { storeName, tagline, accentColor, products, templateChoice } = req.body;
    if (!storeName || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Missing store name or products.' });
    }
    const result = renderTemplate(storeName, tagline, accentColor, products, templateChoice);
    res.json(result);
  } catch (err) {
    console.error('Template render error:', err);
    res.status(500).json({ error: 'Could not render a template.' });
  }
});
// ---------- end template-based page rendering ----------


// Create the database tables (if they don't exist yet) before accepting traffic.
db.initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Store Builder running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Could not connect to the database on startup:', err);
    process.exit(1);
  });
