// Sends ONLY requests to CJ Dropshipping through a proxy that has its own private IP address.
// Does nothing unless CJ_PROXY_URL is set in Render (e.g. http://user:password@host:port).
// Needs the "undici" package (add  "undici": "^6.0.0"  to package.json).

const proxyUrl = process.env.CJ_PROXY_URL;

if (proxyUrl) {
  try {
    const { ProxyAgent } = require('undici');
    const agent = new ProxyAgent(proxyUrl);
    const realFetch = global.fetch;
    global.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
        const host = new URL(url).hostname;
        if (host === 'cjdropshipping.com' || host.endsWith('.cjdropshipping.com')) {
          return realFetch(input, { ...(init || {}), dispatcher: agent });
        }
      } catch (e) {
        // fall through to a normal request
      }
      return realFetch(input, init);
    };
    console.log('CJ requests will go through the proxy (CJ_PROXY_URL is set).');
  } catch (e) {
    console.error('CJ_PROXY_URL is set but the proxy could not start (is "undici" in package.json?):', e.message);
  }
}
