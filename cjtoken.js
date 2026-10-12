// cjtoken.js — remembers the CJ login token in the database.
//
// CJ only allows one login (getAccessToken) every 5 minutes per account. The token
// itself lasts about 15 days, but if the app only keeps it in memory, every deploy
// or restart (and every wake-up of a free Render server) forgets it and logs in
// again. A few restarts in a row and CJ refuses, so searches and orders fail.
// Saving the token here lets restarts reuse it instead.
//
// Only a hash of the API key is stored (never the key itself).
const { Pool } = require('pg');
const crypto = require('crypto');

const url = process.env.DATABASE_URL || '';
const poolConfig = { connectionString: url, max: 2 };
if (!/sslmode=/.test(url)) {
  const hostPart = (url.split('@')[1] || '').split('/')[0].split(':')[0];
  const remote = hostPart.includes('.') && !/^(localhost|127\.0\.0\.1)$/.test(hostPart);
  if (remote) poolConfig.ssl = { rejectUnauthorized: false };
}

let pool = null;
let ready = null;
const getPool = () => pool || (pool = new Pool(poolConfig));
const hash = (apiKey) => crypto.createHash('sha256').update(apiKey).digest('hex');

function init() {
  if (!ready) {
    ready = getPool().query(
      `CREATE TABLE IF NOT EXISTS sb_cj_tokens (
         key_hash TEXT PRIMARY KEY,
         token TEXT NOT NULL,
         expires_at TIMESTAMPTZ NOT NULL
       )`
    );
  }
  return ready;
}

// A saved token that is still good for at least another hour, or null.
async function loadToken(apiKey) {
  try {
    await init();
    const r = await getPool().query(
      `SELECT token FROM sb_cj_tokens WHERE key_hash = $1 AND expires_at > now() + interval '1 hour'`,
      [hash(apiKey)]
    );
    return r.rows[0]?.token || null;
  } catch (e) {
    console.error('Could not read the saved CJ token:', e.message);
    return null;
  }
}

async function saveToken(apiKey, token, expiresAtMs) {
  try {
    await init();
    await getPool().query(
      `INSERT INTO sb_cj_tokens (key_hash, token, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (key_hash) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at`,
      [hash(apiKey), token, new Date(expiresAtMs)]
    );
  } catch (e) {
    console.error('Could not save the CJ token:', e.message);
  }
}

async function clearToken(apiKey) {
  try {
    await init();
    await getPool().query('DELETE FROM sb_cj_tokens WHERE key_hash = $1', [hash(apiKey)]);
  } catch (e) {
    console.error('Could not clear the saved CJ token:', e.message);
  }
}

module.exports = { loadToken, saveToken, clearToken };
