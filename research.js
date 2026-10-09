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
};
