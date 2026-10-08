// auth.js — user accounts for multi-store use.
//
// - Sign in with Google ONLY (no passwords are stored or accepted).
// - Login sessions in Postgres, sent as an HttpOnly cookie.
// - Each user's CJ API key is stored ENCRYPTED (needs the APP_SECRET env var).
// - Middleware used by server.js / cj.js to make sure people only touch their own stores.

const crypto = require('crypto');
const db = require('./db');

const COOKIE = 'sid';
const SESSION_DAYS = 30;

// ---------- encrypting CJ keys at rest ----------
function secretKey() {
  const secret = process.env.APP_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  const key = secretKey();
  if (!key) throw new Error('APP_SECRET is not set on the server.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('hex')).join(':');
}

function decrypt(payload) {
  const key = secretKey();
  if (!key || !payload) return null;
  try {
    const [iv, tag, enc] = payload.split(':').map((h) => Buffer.from(h, 'hex'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// CJ key mode (env CJ_KEY_MODE):
//   "shared"   (default) every store uses the server's one CJ_API_KEY (you pay CJ for all orders)
//   "per-user" each seller adds their own CJ key on the Account page
function keyMode() {
  return String(process.env.CJ_KEY_MODE || 'shared').toLowerCase() === 'per-user' ? 'per-user' : 'shared';
}

// Admins (env ADMIN_EMAILS, comma separated) can see the shared CJ balance.
function isAdmin(email) {
  return String(process.env.ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .includes(String(email || '').toLowerCase());
}

// The CJ API key to use for a given Shopify store:
//  - store has an owner  -> that owner's own key (never anyone else's)
//  - legacy store with no owner yet -> the server's CJ_API_KEY env var
async function cjKeyForShop(shop) {
  if (keyMode() === 'shared') return process.env.CJ_API_KEY || null;
  const row = await db.getShopOwnerKey(shop);
  if (row && row.userId) return decrypt(row.cjApiKeyEnc);
  return process.env.CJ_API_KEY || null;
}

// The store's display name (e.g. "My Cool Store") from Shopify.
async function fetchShopName(shop, token) {
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-10/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    const j = await r.json();
    return j.shop?.name || null;
  } catch (e) {
    return null;
  }
}

// ---------- cookies & sessions ----------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) {}
    }
  });
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.createSession(sha256(token), userId);
  res.append(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`
  );
}

// Runs on every request: sets req.user if the visitor is logged in.
async function attachUser(req, res, next) {
  try {
    const token = parseCookies(req)[COOKIE];
    if (token) req.user = await db.getSessionUser(sha256(token));
  } catch (e) {
    console.error('Session lookup failed:', e);
  }
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api') || req.originalUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'Please log in.', needsLogin: true });
  }
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// Loads this user's CJ API key into req.cjKey (or tells them to add it).
async function requireCjKey(req, res, next) {
  try {
    if (keyMode() === 'shared') {
      if (!process.env.CJ_API_KEY) {
        console.error('CJ_API_KEY is not set on the server.');
        return res.status(500).json({ error: 'CJ is not set up on the server yet. Please contact the site owner.' });
      }
      req.cjKey = process.env.CJ_API_KEY;
      return next();
    }
    const key = decrypt(await db.getUserCjKeyEnc(req.user.id));
    if (!key) {
      return res.status(400).json({
        error: 'Add your CJ API key on the Account page first.',
        needsCjKey: true,
      });
    }
    req.cjKey = key;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Could not read your CJ key.' });
  }
}

// Pages that need a login (the API routes protect themselves).
function gatePages(req, res, next) {
  const gated = ['/', '/index.html', '/orders', '/orders.html', '/account', '/account.html', '/dashboard', '/dashboard.html'];
  if (gated.includes(req.path) && !req.user) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

// ---------- Sign in with Google ----------
// Setup (Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID, "Web application"):
//   Authorized redirect URI:  <APP_URL>/auth/google/callback
//   Env vars on the server:   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL
function googleRedirectUri() {
  return `${(process.env.APP_URL || '').replace(/\/$/, '')}/auth/google/callback`;
}

function safeNext(n) {
  const v = String(n || '');
  return v.startsWith('/') && !v.startsWith('//') ? v : '/dashboard';
}

function shortCookie(req, name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
}

function registerAuthRoutes(app) {
  // Step 1: send the visitor to Google.
  app.get('/auth/google', (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.APP_URL) {
      return res.status(500).send('Google sign-in is not set up on the server yet (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL).');
    }
    const state = crypto.randomBytes(16).toString('hex');
    res.append('Set-Cookie', shortCookie(req, 'g_state', state, 600));
    res.append('Set-Cookie', shortCookie(req, 'g_next', encodeURIComponent(safeNext(req.query.next)), 600));
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: googleRedirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // Step 2: Google sends the visitor back here with a one-time code.
  app.get('/auth/google/callback', async (req, res) => {
    const fail = (msg) => res.redirect('/login?error=' + encodeURIComponent(msg));
    try {
      if (req.query.error) return fail('Google sign-in was cancelled.');

      const cookies = parseCookies(req);
      const state = String(req.query.state || '');
      if (!state || !cookies.g_state || state !== cookies.g_state) {
        return fail('Sign-in expired. Please try again.');
      }
      const next = safeNext(cookies.g_next);

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code || ''),
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: googleRedirectUri(),
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.id_token) {
        console.error('Google token exchange failed:', tokens.error, tokens.error_description);
        return fail('Google sign-in failed. Please try again.');
      }

      // The id_token arrived straight from Google over HTTPS in exchange for our
      // one-time code, so its contents can be trusted; we still check who it is for.
      const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
      const okIssuer = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
      if (!okIssuer || claims.aud !== process.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now()) {
        return fail('Google sign-in could not be verified.');
      }
      if (!claims.email || claims.email_verified !== true) {
        return fail('Your Google email is not verified.');
      }

      const user = await db.upsertGoogleUser({
        sub: claims.sub,
        email: String(claims.email).toLowerCase(),
        name: claims.name,
      });
      await startSession(req, res, user.id);
      res.append('Set-Cookie', shortCookie(req, 'g_state', '', 0));
      res.append('Set-Cookie', shortCookie(req, 'g_next', '', 0));
      res.redirect(next);
    } catch (e) {
      console.error('Google callback failed:', e);
      fail('Something went wrong signing in. Please try again.');
    }
  });

  app.post('/api/logout', async (req, res) => {
    try {
      const token = parseCookies(req)[COOKIE];
      if (token) await db.deleteSession(sha256(token));
    } catch (e) {}
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, async (req, res) => {
    const shops = await db.getShopsForUser(req.user.id);
    // Stores connected before names were saved get their name filled in now.
    for (const s of shops) {
      if (!s.name) {
        const token = await db.getShopToken(s.shop);
        const name = token ? await fetchShopName(s.shop, token) : null;
        if (name) { s.name = name; await db.setShopName(s.shop, name); }
      }
    }
    res.json({
      email: req.user.email,
      keyMode: keyMode(),
      hasCjKey: keyMode() === 'shared' ? true : req.user.hasCjKey,
      shops,
    });
  });
}

module.exports = {
  encrypt,
  decrypt,
  cjKeyForShop,
  fetchShopName,
  keyMode,
  isAdmin,
  attachUser,
  requireUser,
  requireCjKey,
  gatePages,
  registerAuthRoutes,
};
