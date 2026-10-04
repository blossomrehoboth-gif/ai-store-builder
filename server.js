// server.js — AI Store Builder backend
//
// Takes { product, audience, tone } from the frontend, asks Groq for a
// store concept (name, tagline, spotlight product page content, sample
// products, ad line), and returns it as JSON. Also handles the Shopify
// app install (OAuth) so a seller can connect their real store.
//
// Persistent data (connected shops, AliExpress<->Shopify product
// mappings, incoming orders) now lives in Postgres via db.js, so it
// survives server restarts/redeploys instead of resetting each time.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { renderTemplate } = require('./templater');
const db = require('./db');

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
const SHOPIFY_SCOPES = 'read_products,write_products';
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

    await db.setShopToken(shop, data.access_token);
    console.log('Connected shop:', shop);
    res.redirect(`/?shop=${encodeURIComponent(shop)}&connected=1`);
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
        const mapped = await db.getAliMapping(`gid://shopify/Product/${li.product_id}`);
        return {
          title: li.title,
          quantity: li.quantity,
          sku: li.sku || null,
          aliItemId: mapped?.aliItemId || null,
          aliLink: mapped?.aliItemId ? `https://www.aliexpress.com/item/${mapped.aliItemId}.html` : null,
          aliImage: mapped?.aliImage || null,
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

// ---------- Price & inventory monitoring ----------
// Manual-trigger only (you tap a button) — not on a timer, since
// checking many products automatically would burn through the
// AliExpress API quota fast.
app.post('/api/check-prices', async (req, res) => {
  try {
    const results = [];
    const entries = await db.getAllAliMappings();

    for (const [shopifyProductId, info] of entries) {
      const token = await db.getShopToken(info.shop);
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
        await db.setAliMapping(shopifyProductId, info);
        results.push({ title: info.title, ok: true, changed: false, inStock });
        continue;
      }

      const priceChanged = Math.abs(newAliPrice - info.lastKnownAliPrice) > 0.01;
      if (priceChanged && info.variantId && info.shopifyPrice != null) {
        // Keep the same markup: shift Shopify's price by the same
        // dollar amount the AliExpress price moved.
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

        const oldAliPrice = info.lastKnownAliPrice;
        info.shopifyPrice = newShopifyPrice;
        info.lastKnownAliPrice = newAliPrice;
        await db.setAliMapping(shopifyProductId, info);
        results.push({ title: info.title, ok: true, changed: true, oldAliPrice, newAliPrice, newShopifyPrice, inStock });
      } else {
        await db.setAliMapping(shopifyProductId, info);
        results.push({ title: info.title, ok: true, changed: false, inStock });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking prices.' });
  }
});

app.get('/api/price-status', async (req, res) => {
  const entries = await db.getAllAliMappings();
  const items = entries.map(([shopifyProductId, info]) => ({ shopifyProductId, ...info }));
  res.json({ items });
});
// ---------- end price & inventory monitoring ----------

app.get('/api/orders', async (req, res) => {
  res.json({ orders: await db.getOrders() });
});

app.post('/api/orders/:orderId/fulfilled', async (req, res) => {
  const order = await db.getOrderById(req.params.orderId);
  if (order) await db.updateOrder(req.params.orderId, { fulfilled: true });
  res.json({ ok: !!order });
});
// ---------- end order fulfillment ----------
require('./cj')(app); // CJ Dropshipping: balance/product-lookup routes + manual retry route

// ---------- Publish generated concept to Shopify ----------
app.post('/api/publish', async (req, res) => {
  try {
    const { shop, concept } = req.body;
    if (!validShop(shop)) {
      return res.status(400).json({ error: 'Invalid shop.' });
    }
    const token = await db.getShopToken(shop);
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

    // Find the "Online Store" sales channel once, so every product
    // created below can actually be published to it — by default a
    // product created via the API is DRAFT and invisible to shoppers
    // until it's explicitly published to a channel.
    let onlineStorePublicationId = null;
    try {
      const pubData = await shopifyGraphQL(
        `query { publications(first: 10) { edges { node { id name } } } }`,
        {}
      );
      const pub = pubData?.data?.publications?.edges?.find(
        (e) => e.node.name === 'Online Store'
      );
      onlineStorePublicationId = pub?.node?.id || null;
    } catch (e) {
      console.error('Could not look up Online Store publication:', e);
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
            status: 'ACTIVE',
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

      // Make it actually visible to shoppers on the storefront, not
      // just present in the admin.
      if (product?.id && onlineStorePublicationId) {
        const publishData = await shopifyGraphQL(
          `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
              userErrors { field message }
            }
          }`,
          {
            id: product.id,
            input: [{ publicationId: onlineStorePublicationId }],
          }
        );
        const publishErrors = publishData?.data?.publishablePublish?.userErrors;
        if (publishErrors && publishErrors.length) {
          console.error('Could not publish to Online Store:', publishErrors);
        }
      }

      if (product?.id && p.aliItemId) {
        await db.setAliMapping(product.id, {
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

    // Make sure this shop is set up to notify us the moment a real
    // order comes in, so fulfillment info shows up automatically.
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
// Uses item_search_2 (confirmed working) and pulls real structured data
// per listing: photo, price, original price, star rating, and units sold
// — not just a bag of image URLs. Any listing missing a field just omits
// that field; the frontend fills in an AI-written fallback for price.
function parseAliItems(data) {
  const list = data?.result?.resultList || [];
  return list
    .map((entry) => {
      const item = entry?.item || entry;
      if (!item?.itemId) return null;

      const def = item?.sku?.def || {};
      const rating = def.averageStarRate != null ? parseFloat(def.averageStarRate) : null;
      const promotionPrice = def.promotionPrice != null ? parseFloat(def.promotionPrice) : null;
      const listPrice = def.price != null ? parseFloat(def.price) : null;
      const sold = item.sales != null ? parseInt(String(item.sales).replace(/[^0-9]/g, ''), 10) : null;

      let image = item.image;
      if (typeof image === 'string' && image.startsWith('//')) image = 'https:' + image;

      return {
        itemId: item.itemId,
        title: item.title || null,
        image: image || null,
        price: promotionPrice ?? listPrice ?? null,
        originalPrice: listPrice ?? null,
        rating: isNaN(rating) ? null : rating,
        sold: isNaN(sold) ? null : sold,
      };
    })
    .filter(Boolean);
}

// Fetches ONE specific AliExpress product (used when the seller pastes
// a product link instead of a niche word). Never invents data — any
// field we can't find comes back null.
// Follows AliExpress short/campaign links (only AliExpress hosts) to
// find the numeric product ID inside.
app.get('/api/resolve-ali-link', async (req, res) => {
  try {
    let url = String(req.query.url || '');
    const okHost = (u) => {
      try { return /(^|\.)aliexpress\.(com|us|ru)$/i.test(new URL(u).hostname); } catch (e) { return false; }
    };
    const pats = [
      /item\/(\d{8,})/i,
      /[?&](?:itemId|productId|productIds|item_id)=(\d{8,})/i,
      /x_object_id(?:%3A|:)(\d{8,})/i,
      /\/(\d{13,})\.html/i,
    ];
    const findId = (t) => {
      for (const p of pats) { const m = String(t).match(p); if (m) return m[1]; }
      return null;
    };
    if (!okHost(url)) return res.json({ ok: false });
    let id = findId(url);
    if (id) return res.json({ ok: true, itemId: id });

    for (let hop = 0; hop < 5; hop++) {
      const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        url = new URL(loc, url).toString();
        if (!okHost(url)) break;
        id = findId(url);
        if (id) return res.json({ ok: true, itemId: id });
        continue;
      }
      id = findId((await r.text()).slice(0, 300000));
      return res.json(id ? { ok: true, itemId: id } : { ok: false });
    }
    res.json({ ok: false });
  } catch (err) {
    res.json({ ok: false });
  }
});

// Last-resort fallback: recursively search the raw item object for
// anything that looks like an image URL, in case the normal
// item.images / item.image fields are empty for this listing.
function findAnyImageUrl(obj, depth) {
  if (depth > 4 || obj == null) return null;
  if (typeof obj === 'string') {
    if (/^(https?:)?\/\/.+\.(jpg|jpeg|png|webp)/i.test(obj)) {
      return obj.startsWith('//') ? 'https:' + obj : obj;
    }
    return null;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const found = findAnyImageUrl(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const found = findAnyImageUrl(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

app.get('/api/aliexpress-item/:itemId', async (req, res) => {
  try {
    const itemId = String(req.params.itemId).replace(/\D/g, '');
    if (!itemId) return res.json({ ok: false, reason: 'bad-id' });

    // Some products only exist in certain regional catalogs, so try a
    // few variations before giving up (each failed try is logged).
    const attempts = [
      `item_detail?itemId=${itemId}&region=US&currency=USD&locale=en_US`,
      `item_detail?itemId=${itemId}`,
      `item_detail?itemId=${itemId}&region=NG&currency=USD&locale=en_US`,
      `item_detail_6?itemId=${itemId}&region=US&currency=USD&locale=en_US`,
      `item_detail_6?itemId=${itemId}`,
    ];
    let data = null;
    for (const path of attempts) {
      const response = await fetch(`https://aliexpress-datahub.p.rapidapi.com/${path}`, {
        headers: {
          'x-rapidapi-key': process.env.ALIEXPRESS_API_KEY,
          'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
        },
      });
      const d = await response.json();
      if (d?.result?.item) { data = d; console.log(`AliExpress item ${itemId} found via ${path.split('?')[0]} (${path.includes('region') ? path.match(/region=(\w+)/)[1] : 'no region'})`); break; }
      console.log(`AliExpress item ${itemId} try "${path}" -> ${JSON.stringify(d?.result?.status?.msg || d?.message || d).slice(0, 160)}`);
    }
    if (!data) {
      return res.json({ ok: false, reason: 'not-found' });
    }

    const item = data?.result?.item;
    if (!item) {
      console.log(`AliExpress item ${itemId} -> no item. Result keys:`, Object.keys(data?.result || {}));
      return res.json({ ok: false, reason: 'no-item' });
    }

    const fixUrl = (u) => (typeof u === 'string' ? (u.startsWith('//') ? 'https:' + u : u) : null);
    let images = (Array.isArray(item.images) ? item.images : []).map(fixUrl).filter(Boolean);
    if (images.length === 0) {
      const one = fixUrl(item.image) || findAnyImageUrl(item, 0);
      if (one) images = [one];
    }

    const def = item?.sku?.def || {};
    const promo = def.promotionPrice != null ? parseFloat(def.promotionPrice) : null;
    const list = def.price != null ? parseFloat(def.price) : null;
    const ratingRaw = item.averageStarRate ?? item.reviews?.averageStar ?? item.reviews?.averageStarRate ?? null;
    const rating = ratingRaw != null ? parseFloat(ratingRaw) : null;
    const sold = item.sales != null ? parseInt(String(item.sales).replace(/[^0-9]/g, ''), 10) : null;

    console.log(`AliExpress item ${itemId} -> ${images.length} photos, price ${promo ?? list}, rating ${rating}. Item keys:`, Object.keys(item));

    return res.json({
      ok: true,
      item: {
        itemId,
        title: item.title || null,
        image: images[0] || null,
        images: images.slice(0, 6),
        price: Number.isFinite(promo) ? promo : Number.isFinite(list) ? list : null,
        originalPrice: Number.isFinite(list) ? list : null,
        rating: Number.isFinite(rating) ? rating : null,
        sold: Number.isFinite(sold) ? sold : null,
      },
    });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, reason: 'exception' });
  }
});

// ---------- Template-based page rendering (35 design library) ----------
app.post('/api/render-template', (req, res) => {
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

app.get('/api/aliexpress-search', async (req, res) => {
  try {
    const q = req.query.q || 'phone charger';
    const debug = req.query.debug === '1';
    const url = `https://aliexpress-datahub.p.rapidapi.com/item_search_2?q=${encodeURIComponent(q)}&page=1&sort=default`;

    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': process.env.ALIEXPRESS_API_KEY,
        'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      if (debug) return res.json({ items: [], debug_stage: 'not_ok', debug_status: response.status, debug_detail: detail });
      return res.json({ items: [] });
    }

    const data = await response.json();

    if (data?.result?.status?.data === 'error') {
      if (debug) return res.json({ items: [], debug_stage: 'api_error', debug_raw: data });
      return res.json({ items: [] });
    }

    const items = parseAliItems(data);
    if (debug) return res.json({ items, debug_stage: 'ok', debug_raw_keys: Object.keys(data || {}), debug_result_list_length: (data?.result?.resultList || []).length, debug_raw_sample: data });
    return res.json({ items });
  } catch (err) {
    if (req.query.debug === '1') return res.json({ items: [], debug_stage: 'exception', debug_error: String(err) });
    res.json({ items: [] });
  }
});
// ---------- end AliExpress product search ----------

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
