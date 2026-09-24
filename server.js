// server.js — AI Store Builder backend
//
// Takes { product, audience, tone } from the frontend, asks Groq for a
// store concept (name, tagline, hero copy, sample products, ad line),
// and returns it as JSON. Also handles the Shopify app install (OAuth)
// so a seller can connect their real store.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

    const prompt = `You are building marketing copy and a storefront concept for a dropshipping seller.

Product or niche: ${product}
Target audience: ${audience}
Brand tone: ${tone}

Return ONLY a JSON object, with no markdown fences and no commentary, matching exactly this shape:
{
  "storeName": "short brandable store name, 1-3 words",
  "domainHint": "storename.com style lowercase slug, no spaces",
  "tagline": "one line, under 8 words",
  "heroHeadline": "a punchy headline for the store's hero section, under 12 words",
  "brandStory": "two sentences about why this store exists, written in the given tone",
  "accentColor": "a single hex color that fits the tone and product, e.g. #7A5CFA",
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
        max_tokens: 1000,
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

    // Some models add reasoning text before/after the JSON object.
    // Fall back to grabbing just the {...} portion if a direct parse fails.
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

// Temporary in-memory storage (a database comes later)
const shopTokens = new Map();
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

    // Shopify's install link lands here without a code: start the login
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
      // 1. Create the product (title + description)
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

      // 2. Set the price on the product's default variant
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

      results.push({ name: p.name, ok: true, id: product?.id });
    }

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong publishing to Shopify.' });
  }
});
// ---------- end publish ----------

// ---------- AliExpress product lookup ----------
// Pulls product data via a third-party RapidAPI service (aliexpress-datahub),
// not an official AliExpress API. Returns a clean { title, price, images }
// shape instead of the raw provider response.
function requireAliexpressKey(res) {
  const key = process.env.ALIEXPRESS_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Server is missing ALIEXPRESS_API_KEY.' });
    return null;
  }
  return key;
}

// Pull a usable image list out of whatever shape the provider sends back.
function extractImages(item) {
  const raw =
    item?.item?.images ||
    item?.images ||
    item?.item?.image ||
    item?.item?.itemImages ||
    [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map(String);
}

function extractTitle(item) {
  return item?.item?.title || item?.title || item?.item?.subject || null;
}

function extractPrice(item) {
  const price =
    item?.item?.sku?.def?.promotionPrice ||
    item?.item?.sku?.def?.price ||
    item?.item?.price ||
    item?.price ||
    null;
  return price ? String(price) : null;
}

app.get('/api/aliexpress/:itemId', async (req, res) => {
  const key = requireAliexpressKey(res);
  if (!key) return;

  try {
    const { itemId } = req.params;
    const url = `https://aliexpress-datahub.p.rapidapi.com/item_detail_6?itemId=${itemId}&region=US&currency=USD&locale=en_US`;

    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'AliExpress lookup failed.' });
    }

    const data = await response.json();
    const title = extractTitle(data.result || data);
    const price = extractPrice(data.result || data);
    const images = extractImages(data.result || data);

    if (!title && images.length === 0) {
      return res.status(502).json({ error: 'Could not read product details for that item.' });
    }

    res.json({ itemId, title, price, images });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch product from AliExpress.', detail: String(err) });
  }
});
// ---------- end AliExpress product lookup ----------

// ---------- AliExpress product search ----------
app.get('/api/aliexpress-search', async (req, res) => {
  const key = requireAliexpressKey(res);
  if (!key) return;

  try {
    const q = req.query.q || 'phone charger';
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
        title: extractTitle(item),
        price: extractPrice(item),
        images: extractImages(item),
      };
    });

    res.json({ query: q, items });
  } catch (err) {
    res.status(500).json({ error: 'Search failed.', detail: String(err) });
  }
});
// ---------- end AliExpress product search ----------

app.listen(PORT, () => {
  console.log(`Store Builder running at http://localhost:${PORT}`);
});
