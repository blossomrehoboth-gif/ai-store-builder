// server.js — AI Store Builder backend
//
// Takes { product, audience, tone } from the frontend, asks Groq for a
// single-product storefront concept in a Shopify-style landing page
// format (price + discount, bundle tiers, benefit checklist, urgency
// banner, testimonial), and returns it as JSON. The Groq API key stays
// server-side only.

const express = require('express');
const path = require('path');
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

    const prompt = `You are building a single-product landing page for a dropshipping store, in the style of a high-converting Shopify product page (think: bold benefit checklist, tiered bundle pricing with a "most popular" option, urgency banner, a customer testimonial, and a money-back guarantee).

Product or niche: ${product}
Target audience: ${audience}
Brand tone: ${tone}

Return ONLY a JSON object, with no markdown fences and no commentary, matching exactly this shape:
{
  "storeName": "short brandable store name, 1-3 words",
  "domainHint": "storename.com style lowercase slug, no spaces",
  "accentColor": "a single hex color that fits the tone and product, e.g. #1D4ED8",
  "imageQuery": "2-4 word plain-English search term for a photo of this exact product, e.g. 'wireless earbuds case'",
  "productName": "the flagship product's name, under 6 words",
  "productTagline": "one bold marketing line about the product, under 16 words, in the style of 'The #1 alternative for people who are done with X'",
  "rating": "a number between 4.5 and 5.0, one decimal, as a string, e.g. '4.8'",
  "reviewsLine": "short social proof line, e.g. 'Trusted by 50,000+ customers'",
  "price": "price like $59.90",
  "originalPrice": "a higher price like $79.90",
  "discountPercent": "like 25%",
  "benefits": ["short benefit phrase", "short benefit phrase", "short benefit phrase", "short benefit phrase"],
  "bundleOffers": [
    {"label": "1 ITEM", "price": "price like $59.90", "originalPrice": "higher price", "note": "e.g. 25% OFF", "popular": false},
    {"label": "BUY 2 GET 1 FREE", "price": "price", "originalPrice": "higher price", "note": "e.g. 50% OFF + FREE Shipping", "popular": true},
    {"label": "BUY 3 GET 2 FREE", "price": "price", "originalPrice": "higher price", "note": "e.g. 57% OFF + FREE Gift", "popular": false}
  ],
  "urgencyText": "short urgency line, e.g. 'Offer ending soon — Limited stock'",
  "guarantee": "e.g. '30-Day Money-Back Guarantee'",
  "testimonial": {"name": "First name + last initial", "rating": 5, "quote": "a short, specific, believable customer quote, under 25 words"},
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
        max_tokens: 1500,
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

app.listen(PORT, () => {
  console.log(`Store Builder running at http://localhost:${PORT}`);
});
