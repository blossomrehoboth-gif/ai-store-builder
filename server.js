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

// Strips anything that could execute code in the browser. This is a
// hard safety floor, not a design restriction — everything else about
// the AI's HTML/CSS is left untouched.
function sanitizeAiHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

// Lets Groq design the entire visual layout for a store — real
// creative freedom on colors, structure, fonts, spacing — using the
// real product data (name, price, image, rating) we already fetched
// from AliExpress. The AI writes the HTML; it never writes the data.
app.post('/api/generate-layout', async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'Server is missing GROQ_API_KEY.' });
    }

    const { concept, products } = req.body;
    if (!concept || !Array.isArray(products)) {
      return res.status(400).json({ error: 'Missing store concept or product data.' });
    }

    const prompt = `You are a senior e-commerce web designer. Design a complete, unique storefront page layout for this brand, using ONLY the real data given below — never invent prices, ratings, or product names.

Store: ${concept.storeName}
Tagline: ${concept.tagline}
Tone: ${concept.tone || 'Premium'}
Accent color: ${concept.accentColor}

Real products (use exactly as given):
${JSON.stringify(products, null, 2)}

Design a fresh, distinctive layout — vary structure, spacing, fonts (use real Google Font names via <link> or font-family stacks), card style, and hero treatment each time you're asked. Be creative: this should not look like a generic template.

Rules:
- Return ONLY raw HTML with a <style> block inside it. No markdown fences, no commentary, no <html>/<head>/<body> tags — just the fragment to inject into a page.
- No <script> tags, no inline event handlers (onclick etc), no external JS.
- Use the exact product names, prices, images, and ratings given — do not change or invent numbers.
- Make it mobile-first and readable on a narrow phone screen (assume ~380px width).
- Include an <img> for each product using its given image URL, its name, price, and rating if present.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Groq layout API error:', detail);
      return res.status(502).json({ error: 'The AI layout request failed.' });
    }

    const data = await response.json();
    const rawHtml = data.choices?.[0]?.message?.content ?? '';
    const cleaned = rawHtml.replace(/```html|```/gi, '').trim();

    if (!cleaned) {
      return res.status(502).json({ error: 'AI returned an empty layout.' });
    }

    const safeHtml = sanitizeAiHtml(cleaned);
    const imgSrcMatches = [...safeHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    console.log('DEBUG AI layout img srcs:', imgSrcMatches);
    res.json({ html: safeHtml });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong generating the layout.' });
  }
});
// ---------- end AI-generated layout ----------


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
// Uses item_search_2 — item_search (v1) is currently unreliable on
// AliExpress's side, but item_search_2 was confirmed working.

// Region -> currency mapping used across search + region-price lookups.
const REGION_CURRENCY = {
  US: 'USD',
  EU: 'EUR',
  UK: 'GBP',
  AU: 'AUD',
};

// Digs one item's price fields out of an item_search_2 / item_detail
// result. Never invents numbers — returns null where AliExpress didn't
// give us a real value.
function extractPriceFields(item) {
  const def = item?.sku?.def || {};
  const price = def.price != null ? parseFloat(def.price) : null;
  const promotionPrice = def.promotionPrice != null ? parseFloat(def.promotionPrice) : null;
  const rating = item?.averageStarRate != null ? parseFloat(item.averageStarRate) : null;
  const soldRaw = item?.sales != null ? parseInt(String(item.sales).replace(/[^0-9]/g, ''), 10) : null;

  let discountPercent = null;
  if (Number.isFinite(price) && Number.isFinite(promotionPrice) && price > 0 && promotionPrice < price) {
    discountPercent = Math.round(((price - promotionPrice) / price) * 100);
  }

  return {
    itemId: item?.itemId || null,
    title: item?.title || null,
    image: item?.image ? (item.image.startsWith('//') ? 'https:' + item.image : item.image) : null,
    price: Number.isFinite(price) ? price : null,
    promotionPrice: Number.isFinite(promotionPrice) ? promotionPrice : null,
    discountPercent,
    rating: Number.isFinite(rating) ? rating : null,
    sold: Number.isFinite(soldRaw) ? soldRaw : null,
  };
}

app.get('/api/aliexpress-search', async (req, res) => {
  try {
    const q = req.query.q || 'phone charger';
    const region = REGION_CURRENCY[req.query.region] ? req.query.region : 'US';
    const currency = REGION_CURRENCY[region];

    const url = `https://aliexpress-datahub.p.rapidapi.com/item_search_2?q=${encodeURIComponent(q)}&page=1&sort=default&region=${region}&currency=${currency}&locale=en_US`;

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

    const rawItems = (data?.result?.resultList || []).map((r) => r.item).filter(Boolean);
    const items = rawItems.slice(0, 6).map(extractPriceFields).filter((it) => it.itemId);

    return res.json({ items, region, currency });
  } catch (err) {
    res.json({ items: [] });
  }
});

// Looks up real price for one specific AliExpress item in a given
// region, so a shopper tapping US/EU/UK/AU on a product card sees a
// real regional price, not a guess.
app.get('/api/aliexpress-region-price/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const region = REGION_CURRENCY[req.query.region] ? req.query.region : 'US';
    const currency = REGION_CURRENCY[region];

    const url = `https://aliexpress-datahub.p.rapidapi.com/item_detail?itemId=${encodeURIComponent(itemId)}&region=${region}&currency=${currency}&locale=en_US`;

    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': process.env.ALIEXPRESS_API_KEY,
        'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
      },
    });

    if (!response.ok) {
      return res.json({ ok: false });
    }

    const data = await response.json();
    const item = data?.result?.item || data?.result || null;
    if (!item || data?.result?.status?.data === 'error') {
      return res.json({ ok: false });
    }

    const priceFields = extractPriceFields(item);
    return res.json({ ok: true, region, currency, ...priceFields });
  } catch (err) {
    res.json({ ok: false });
  }
});
// Looks up real color/variant swatches for one item, if AliExpress has
// them. Returns an empty array (never invented colors) when the shape
// isn't what we expect — logs the raw sku property data once so we can
// debug via Render logs the same way we fixed the photo bug.
app.get('/api/aliexpress-colors/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const url = `https://aliexpress-datahub.p.rapidapi.com/item_detail?itemId=${encodeURIComponent(itemId)}&region=US&currency=USD&locale=en_US`;

    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': process.env.ALIEXPRESS_API_KEY,
        'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
      },
    });

    if (!response.ok) {
      return res.json({ colors: [] });
    }

    const data = await response.json();
    const item = data?.result?.item || data?.result || null;
    if (!item) {
      return res.json({ colors: [] });
    }

    const propList = item?.skuModule?.productSKUPropertyList || [];
    const colorProp = propList.find((p) =>
      /colou?r/i.test(p?.skuPropertyName || p?.skuPropertyId || '')
    );

    if (!colorProp) {
      console.log(`DEBUG no color prop for ${itemId} — skuModule keys:`, Object.keys(item?.skuModule || {}));
      return res.json({ colors: [] });
    }

    const colors = (colorProp.skuPropertyValues || [])
      .map((v) => ({
        name: v.propertyValueDisplayName || v.propertyValueName || null,
        image: v.skuPropertyImagePath
          ? v.skuPropertyImagePath.startsWith('//')
            ? 'https:' + v.skuPropertyImagePath
            : v.skuPropertyImagePath
          : null,
      }))
      .filter((c) => c.name);

    return res.json({ colors });
  } catch (err) {
    res.json({ colors: [] });
  }
});
// ---------- end AliExpress product search ----------

app.listen(PORT, () => {
  console.log(`Store Builder running at http://localhost:${PORT}`);
});
