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

app.get('/api/aliexpress-search', async (req, res) => {
  try {
    const q = req.query.q || 'phone charger';
    const url = `https://aliexpress-datahub.p.rapidapi.com/item_search_2?q=${encodeURIComponent(q)}&page=1&sort=default`;

    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': process.env.ALIEXPRESS_API_KEY,
        'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
      },
    });

    if (!response.ok) {
      return res.json({ items: [] });
    }

    const data = await response.json();

    if (data?.result?.status?.data === 'error') {
      return res.json({ items: [] });
    }

    const items = parseAliItems(data);
    return res.json({ items });
  } catch (err) {
    res.json({ items: [] });
  }
});
// ---------- end AliExpress product search ----------

app.listen(PORT, () => {
  console.log(`Store Builder running at http://localhost:${PORT}`);
});
