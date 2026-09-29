// server.js — AI Store Builder backend
//
// Takes { product, audience, tone } from the frontend, asks Groq for a
// store concept (name, tagline, spotlight product page content, sample
// products, ad line), and returns it as JSON. Also handles the Shopify
// app install (OAuth) so a seller can connect their real store.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { placeAliExpressOrder } = require('./aliexpress-autoorder');

const app = express();
app.use((req, res, next) => {
  if (req.path === '/webhooks/orders-create') return next();
  express.json()(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// Clean URL for the orders page (the file itself is public/orders.html).
app.get('/orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'orders.html'));
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

app.post('/api/generate', async (req, res) => {
  try {
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
  "adLine": "one short ad headline for a social ad, under 10 words"
}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        max_tokens: 1800,
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
const SHOPIFY_SCOPES = 'read_products,write_products';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

const shopTokens = new Map();
// Shopify product id -> { aliItemId, aliImage, title } so a real order
// can be matched back to the exact AliExpress listing to fulfill.
const productAliMap = new Map();
// In-memory list of orders seen via webhook, newest first.
const incomingOrders = [];
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

app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!validShop(shop)) return res.status(400).send('Invalid shop.');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, shop);
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

    if (!code) return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);

    if (!validHmac(req.query)) return res.status(400).send('Invalid signature.');
    if (pendingStates.get(state) !== shop) return res.status(400).send('Invalid state.');
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

    shopTokens.set(shop, data.access_token);
    console.log('Connected shop:', shop);
    res.redirect(`/?shop=${encodeURIComponent(shop)}&connected=1`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
});
// ---------- end Shopify install / OAuth ----------

// ---------- Order fulfillment ----------
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

function validWebhookHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch (e) {
    return false;
  }
}

app.post('/webhooks/orders-create', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    if (!validWebhookHmac(req.body, hmac)) {
      return res.status(401).send('Invalid signature.');
    }
    const shop = req.get('X-Shopify-Shop-Domain');
    const order = JSON.parse(req.body.toString('utf8'));

    const lineItems = (order.line_items || []).map((li) => {
      const mapped = productAliMap.get(`gid://shopify/Product/${li.product_id}`);
      return {
        title: li.title,
        quantity: li.quantity,
        aliItemId: mapped?.aliItemId || null,
        aliLink: mapped?.aliItemId ? `https://www.aliexpress.com/item/${mapped.aliItemId}.html` : null,
        aliImage: mapped?.aliImage || null,
      };
    });

    incomingOrders.unshift({
      shop,
      orderId: order.id,
      orderNumber: order.order_number || order.name,
      receivedAt: new Date().toISOString(),
      customerName: [order.shipping_address?.first_name, order.shipping_address?.last_name].filter(Boolean).join(' ') || order.customer?.first_name || 'Customer',
      address: order.shipping_address || null,
      lineItems,
      fulfilled: false,
    });
    if (incomingOrders.length > 200) incomingOrders.length = 200;

    console.log(`New order #${order.order_number} from ${shop} — ${lineItems.length} item(s)`);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook handling error:', err);
    res.status(200).send('ok');
  }
});

// ---------- Price & inventory monitoring ----------
app.post('/api/check-prices', async (req, res) => {
  try {
    const results = [];
    const entries = [...productAliMap.entries()];

    for (const [shopifyProductId, info] of entries) {
      const token = shopTokens.get(info.shop);
      if (!token) {
        results.push({ title: info.title, ok: false, reason: 'shop-not-connected' });
        continue;
      }

      const url = `https://aliexpress-datahub.p.rapidapi.com/item_detail?itemId=${info.aliItemId}&region=US&currency=USD&locale=en_US`;
      const r = await fetch(url, {
        headers: {
          'x-rapidapi-key': process.env.ALIEXPRESS_API_KEY,
          'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
        },
      });
      const data = await r.json();
      const item = data?.result?.item;
      if (!item) {
        results.push({ title: info.title, ok: false, reason: 'not-found' });
        continue;
      }

      const def = item?.sku?.def || {};
      const newAliPrice = def.promotionPrice != null ? parseFloat(def.promotionPrice) : def.price != null ? parseFloat(def.price) : null;
      const inStock = item.inventory != null ? item.inventory > 0 : (item.quantity != null ? item.quantity > 0 : null);

      info.lastCheckedAt = new Date().toISOString();
      info.inStock = inStock;

      if (newAliPrice == null || info.lastKnownAliPrice == null) {
        info.lastKnownAliPrice = newAliPrice;
        results.push({ title: info.title, ok: true, changed: false, inStock });
        continue;
      }

      const priceChanged = Math.abs(newAliPrice - info.lastKnownAliPrice) > 0.01;
      if (priceChanged && info.variantId && info.shopifyPrice != null) {
        const delta = newAliPrice - info.lastKnownAliPrice;
        const newShopifyPrice = Math.max(0.01, info.shopifyPrice + delta);

        const graphqlUrl = `https://${info.shop}/admin/api/2024-10/graphql.json`;
        await fetch(graphqlUrl, {
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

        info.shopifyPrice = newShopifyPrice;
        info.lastKnownAliPrice = newAliPrice;
        results.push({ title: info.title, ok: true, changed: true, oldAliPrice: info.lastKnownAliPrice, newAliPrice, newShopifyPrice, inStock });
      } else {
        results.push({ title: info.title, ok: true, changed: false, inStock });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking prices.' });
  }
});

app.get('/api/price-status', (req, res) => {
  const items = [...productAliMap.entries()].map(([shopifyProductId, info]) => ({ shopifyProductId, ...info }));
  res.json({ items });
});
// ---------- end price & inventory monitoring ----------

app.get('/api/orders', (req, res) => {
  res.json({ orders: incomingOrders });
});

app.post('/api/orders/:orderId/fulfilled', (req, res) => {
  const order = incomingOrders.find((o) => String(o.orderId) === req.params.orderId);
  if (order) order.fulfilled = true;
  res.json({ ok: !!order });
});
// ---------- end order fulfillment ----------

// ---------- Publish generated concept to Shopify ----------
app.post('/api/publish', async (req, res) => {
  try {
    const { shop, concept } = req.body;
    if (!validShop(shop)) {
      return res.status(400).json({ error: 'Invalid shop.' });
    }
    const token = shopTokens.get(shop);
    if (!token) {
      return res.status(401).json({ error: 'This store is not connected. Please reinstall the app.' });
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
            descriptionHtml: p.description || '',
            vendor: concept.storeName || 'AI Store Builder',
          },
        }
      );

      const createErrors = createData.data?.productCreate?.userErrors;
      if (createErrors && createErrors.length) {
        results.push({ name: p.name, ok: false, error: createErrors.map((e) => e.message).join(', ') });
        continue;
      }

      const product = createData.data?.productCreate?.product;
      const variantId = product?.variants?.edges?.[0]?.node?.id;

      if (variantId && p.price) {
        const priceNumber = String(p.price).replace(/[^0-9.]/g, '');
        await shopifyGraphQL(
          `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }`,
          {
            productId: product.id,
            variants: [{ id: variantId, price: priceNumber }],
          }
        );
      }

      if (product?.id && p.aliItemId) {
        productAliMap.set(product.id, {
          shop,
          variantId: variantId || null,
          aliItemId: p.aliItemId,
          aliImage: p.aliImage || null,
          title: p.name,
          lastKnownAliPrice: p.aliPrice != null ? p.aliPrice : null,
          shopifyPrice: p.price ? parseFloat(String(p.price).replace(/[^0-9.]/g, '')) : null,
          lastCheckedAt: null,
        });
      }

      results.push({ name: p.name, ok: true, id: product?.id });
    }

    await ensureOrderWebhook(shop, token);

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong publishing to Shopify.' });
  }
});
// ---------- end publish ----------

// ---------- AliExpress product lookup ----------
app.get('/api/aliexpress/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const key = process.env.ALIEXPRESS_API_KEY || '';

    const url = `https://aliexpress-datahub.p.rapidapi.com/item_detail?itemId=${itemId}&region=US&currency=USD&locale=en_US`;

    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
      },
    });
    const data = await response.json();

    return res.json({ debug_status: response.status, debug_key_length: key.length, debug_raw: data });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch product from AliExpress.', detail: String(err) });
  }
});
// ---------- end AliExpress product lookup ----------

// ---------- AliExpress product search ----------
app.get('/api/aliexpress-search', async (req, res) => {
  try {
    const q = req.query.q || 'phone charger';
    const key = process.env.ALIEXPRESS_API_KEY || '';
    const url = `https://aliexpress-datahub.p.rapidapi.com/item_search?q=${encodeURIComponent(q)}&page=1&sort=default`;

    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'AliExpress search failed.' });
    }

    const data = await response.json();
    const rawItems = data.result?.resultList || data.resultList || data.items || [];

    const items = rawItems.map((entry) => {
      const item = entry?.item ? entry : { item: entry };
      return {
        itemId: item.item?.itemId || entry.itemId || null,
        title: item.item?.title || entry.title || null,
        price: item.item?.sku?.def?.promotionPrice || item.item?.sku?.def?.price || null,
        images: item.item?.images || [],
      };
    });

    res.json({ query: q, items });
  } catch (err) {
    res.status(500).json({ error: 'Search failed.', detail: String(err) });
  }
});
// ---------- end AliExpress product search ----------

// ---------- Auto-order fulfillment ----------
app.get('/api/autoorder-status', (req, res) => {
  res.json({ sessionConfigured: !!process.env.ALIEXPRESS_SESSION_COOKIES });
});

app.post('/api/orders/:orderId/auto-order', async (req, res) => {
  const order = incomingOrders.find((o) => String(o.orderId) === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const results = [];
  for (const item of order.lineItems) {
    if (!item.aliItemId) {
      results.push({ title: item.title, success: false, reason: 'no-supplier-link' });
      continue;
    }
    const result = await placeAliExpressOrder({
      aliItemId: item.aliItemId,
      quantity: item.quantity,
      shippingAddress: order.address,
    });
    results.push({ title: item.title, ...result });
  }

  order.autoOrderResults = results;
  order.autoOrderAttemptedAt = new Date().toISOString();
  if (results.length > 0 && results.every((r) => r.success)) {
    order.fulfilled = true;
    order.aliOrderIds = results.map((r) => r.aliOrderId).filter(Boolean);
  }

  res.json({ results, fulfilled: order.fulfilled });
});
// ---------- end auto-order fulfillment ----------

app.listen(PORT, () => {
  console.log(`Store Builder running at http://localhost:${PORT}`);
});
