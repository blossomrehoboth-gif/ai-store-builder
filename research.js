// research.js - CJ Dropshipping product research (v1)
// Hook up in server.js with ONE line:  require('./research')(app);
const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

let token = null;
let tokenExpires = 0;

// CJ only allows 1 token request per 5 minutes, so cache it.
async function getToken() {
  if (token && Date.now() < tokenExpires) return token;
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
  token = json.data.accessToken;
  tokenExpires = Date.now() + 14 * 24 * 60 * 60 * 1000;
  return token;
}

// CJ prices can be a number or a range like "2.5 -- 4.1". Use the low end.
function num(v) {
  const m = String(v ?? '').match(/[\d.]+/);
  return m ? parseFloat(m[0]) : 0;
}

// Simple 0-100 score: popularity + price in a good dropshipping range.
function score(p) {
  const cost = num(p.sellPrice);
  const listed = num(p.listedNum);
  let s = 0;
  s += Math.min(listed / 500, 1) * 50;            // more sellers listing it = proven
  if (cost >= 3 && cost <= 25) s += 35;           // room for 2.5-3x markup
  else if (cost > 25 && cost <= 60) s += 20;
  else if (cost > 0) s += 8;
  if (p.productImage) s += 15;
  return Math.round(s);
}

async function searchCj(q) {
  const t = await getToken();
  const url =
    `${CJ_BASE}/product/list?productNameEn=${encodeURIComponent(q)}` +
    `&pageNum=1&pageSize=20`;
  const r = await fetch(url, { headers: { 'CJ-Access-Token': t } });
  const json = await r.json();
  return (json.data?.list || []).map((p) => ({
    pid: p.pid,
    name: p.productNameEn || p.productName,
    image: p.productImage,
    cost: num(p.sellPrice),
    suggestedPrice: Math.round(num(p.sellPrice) * 2.8 * 100) / 100,
    category: p.categoryName,
    listedBySellers: num(p.listedNum),
    score: score(p),
    niche: q,
  }));
}

// Niches that tend to produce impulse-buy products. Edit freely.
const NICHES = [
  'pet', 'posture', 'led light', 'car organizer', 'kitchen gadget',
  'massage', 'phone holder', 'fitness band',
];
let winnersCache = { at: 0, data: null };

module.exports = function registerResearch(app) {
  // Finds winners automatically: scans the niches above, ranks everything.
  // Cached 6 hours so it doesn't spam CJ.
  app.get('/api/research/winners', async (req, res) => {
    try {
      if (winnersCache.data && Date.now() - winnersCache.at < 6 * 3600 * 1000) {
        return res.json(winnersCache.data);
      }
      let all = [];
      for (const n of NICHES) {
        try { all = all.concat(await searchCj(n)); } catch (e) { /* skip niche */ }
        await new Promise((ok) => setTimeout(ok, 1200)); // CJ rate limit
      }
      const seen = new Set();
      const results = all
        .filter((p) => p.pid && !seen.has(p.pid) && seen.add(p.pid))
        .sort((a, b) => b.score - a.score)
        .slice(0, 24);
      const data = { count: results.length, results };
      if (results.length) winnersCache = { at: Date.now(), data };
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Try in browser: /api/research?q=posture corrector
  // Add &raw=1 to see CJ's untouched response (useful for debugging).
  app.get('/api/research', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'Add ?q=keyword' });

      const t = await getToken();
      const url =
        `${CJ_BASE}/product/list?productNameEn=${encodeURIComponent(q)}` +
        `&pageNum=1&pageSize=20`;
      const r = await fetch(url, { headers: { 'CJ-Access-Token': t } });
      const json = await r.json();

      if (req.query.raw) return res.json(json);

      const list = json.data?.list || [];
      const results = list
        .map((p) => ({
          pid: p.pid,
          name: p.productNameEn || p.productName,
          image: p.productImage,
          cost: num(p.sellPrice),
          suggestedPrice: Math.round(num(p.sellPrice) * 2.8 * 100) / 100,
          category: p.categoryName,
          listedBySellers: num(p.listedNum),
          score: score(p),
        }))
        .sort((a, b) => b.score - a.score);

      res.json({ query: q, count: results.length, results, cjMessage: json.message });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Real profit for one product: actual CJ shipping + stock + fees.
  // /api/research/profit?pid=...&sell=35&ad=8&country=US
  app.get('/api/research/profit', async (req, res) => {
    try {
      const pid = String(req.query.pid || '');
      if (!pid) return res.status(400).json({ error: 'Missing pid' });
      const country = String(req.query.country || process.env.RESEARCH_COUNTRY || 'US').toUpperCase();
      const t = await getToken();
      const H = { 'CJ-Access-Token': t, 'Content-Type': 'application/json' };

      // 1) variants -> first variant gives us a vid and a real cost
      const pr = await fetch(`${CJ_BASE}/product/query?pid=${encodeURIComponent(pid)}`, { headers: H });
      const pj = await pr.json();
      const variants = pj.data?.variants || [];
      const v = variants[0];
      if (!v?.vid) return res.json({ ok: false, error: 'No variant found for this product.', cjMessage: pj.message });
      const cost = num(v.variantSellPrice ?? v.sellPrice ?? pj.data?.sellPrice);

      // 2) real shipping options to the destination
      await new Promise((ok) => setTimeout(ok, 1100)); // CJ rate limit
      const fr = await fetch(`${CJ_BASE}/logistic/freightCalculate`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          startCountryCode: process.env.CJ_FROM_COUNTRY || 'CN',
          endCountryCode: country,
          products: [{ quantity: 1, vid: v.vid }],
        }),
      });
      const fj = await fr.json();
      const opts = (Array.isArray(fj.data) ? fj.data : [])
        .map((o) => ({ name: o.logisticName, price: num(o.logisticPrice), days: o.logisticAging }))
        .filter((o) => o.name)
        .sort((a, b) => a.price - b.price);
      const ship = opts[0] || null;

      // 3) stock (best effort; CJ field names vary)
      await new Promise((ok) => setTimeout(ok, 1100));
      let stock = null;
      try {
        const sr = await fetch(`${CJ_BASE}/product/stock/queryByVid?vid=${encodeURIComponent(v.vid)}`, { headers: H });
        const sj = await sr.json();
        const rows = Array.isArray(sj.data) ? sj.data : [];
        if (rows.length) {
          stock = rows.reduce((n, x) => n + num(x.storageNum ?? x.totalInventoryNum ?? x.totalInventory), 0);
        }
      } catch (e) { /* leave unknown */ }

      // 4) profit math
      const sell = num(req.query.sell) || Math.round(cost * 2.8 * 100) / 100;
      const ad = req.query.ad === undefined || req.query.ad === '' ? 8 : num(req.query.ad);
      const shipping = ship ? ship.price : null;
      const fee = Math.round((sell * 0.029 + 0.3) * 100) / 100; // typical card fee
      const profit = shipping == null ? null
        : Math.round((sell - cost - shipping - fee - ad) * 100) / 100;

      res.json({
        ok: true,
        country, vid: v.vid, sell, cost, shipping, shippingMethod: ship?.name || null,
        deliveryDays: ship?.days || null, paymentFee: fee, adCost: ad,
        profit, margin: profit == null || !sell ? null : Math.round((profit / sell) * 100),
        stock, inStock: stock == null ? null : stock > 0,
        estimateNote: 'Shipping is a real CJ quote. Fee (2.9% + $0.30) and ad cost are estimates; refunds not included.',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
};
