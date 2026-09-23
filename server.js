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
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Groq API error:', detail);
      return res.status(502).json({ error: 'The AI request failed.', detail });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    const cleaned = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse the AI response as JSON.' });
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
    res.send(`Connected to ${shop}! You can close this page.`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
});
// ---------- end Shopify install / OAuth ----------

app.listen(PORT, () => {
  console.log(`Store Builder running at http://localhost:${PORT}`);
});
