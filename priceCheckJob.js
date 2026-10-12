// priceCheckJob.js — runs the same price/stock check as the manual
// "Check prices" button on the orders page, but for one shop at a time
// with no browser request involved. Used by the daily scheduled route
// added in server.js. Does not touch /api/check-prices at all — this
// is a separate, parallel path that happens to do the same work.
const db = require('./db');
const auth = require('./auth');
const { getCjProduct, getCjStock } = require('./cj');

async function runPriceCheckForShop(shop) {
  const results = [];
  const token = await db.getShopToken(shop);
  if (!token) return { shop, ok: false, reason: 'shop-not-connected', results };

  const cjKey = await auth.cjKeyForShop(shop);
  if (!cjKey) return { shop, ok: false, reason: 'no-cj-key', results };

  const entries = await db.getProductMappingsForShop(shop);

  for (const [shopifyProductId, info] of entries) {
    const product = info.cjPid ? await getCjProduct(cjKey, info.cjPid) : null;
    if (!product) {
      results.push({ title: info.title, ok: false, reason: 'not-found' });
      continue;
    }

    // Use the exact variant we sell, not just the default one.
    const variant = (product.variants || []).find((v) => v.vid === info.cjVid);
    const newCost = variant?.cost ?? product.cost;

    let inStock = null;
    if (info.cjVid) {
      const units = await getCjStock(cjKey, info.cjVid);
      inStock = units == null ? null : units > 0;
    }

    info.lastCheckedAt = new Date().toISOString();
    info.inStock = inStock;

    if (newCost == null || info.lastKnownCost == null) {
      info.lastKnownCost = newCost;
      await db.setProductMapping(shopifyProductId, info);
      results.push({ title: info.title, ok: true, changed: false, inStock });
      continue;
    }

    const costChanged = Math.abs(newCost - info.lastKnownCost) > 0.01;
    if (costChanged && info.variantId && info.shopifyPrice != null && info.lastKnownCost > 0) {
      // Keep the same markup: scale Shopify's price by the same ratio the cost moved.
      const newShopifyPrice = Math.max(0.01, info.shopifyPrice * (newCost / info.lastKnownCost));

      await fetch(`https://${info.shop}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({
          query: `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }`,
          variables: {
            productId: shopifyProductId,
            variants: [{ id: info.variantId, price: newShopifyPrice.toFixed(2) }],
          },
        }),
      });

      const oldCost = info.lastKnownCost;
      info.shopifyPrice = newShopifyPrice;
      info.lastKnownCost = newCost;
      await db.setProductMapping(shopifyProductId, info);
      // oldAliPrice / newAliPrice kept as key names so orders.html keeps working.
      results.push({ title: info.title, ok: true, changed: true, oldAliPrice: oldCost, newAliPrice: newCost, newShopifyPrice, inStock });
    } else {
      await db.setProductMapping(shopifyProductId, info);
      results.push({ title: info.title, ok: true, changed: false, inStock });
    }
  }

  // Email the shop's owner about anything that needs attention.
  try {
    const problems = results.filter((r) => r.ok && (r.changed || r.inStock === false));
    if (problems.length) {
      const lines = problems.map((r) => {
        const parts = [];
        if (r.changed) parts.push(`supplier price $${Number(r.oldAliPrice).toFixed(2)} -> $${Number(r.newAliPrice).toFixed(2)} (your price now $${Number(r.newShopifyPrice).toFixed(2)})`);
        if (r.inStock === false) parts.push('OUT OF STOCK at CJ');
        return `- ${r.title}: ${parts.join('; ')}`;
      });
      require('./mailer').sendAlert(
        `Daily store check (${shop}): ${problems.length} product${problems.length > 1 ? 's' : ''} need attention`,
        lines.join('\n')
      );
    }
  } catch (e) {
    console.error('Alert build failed:', e);
  }

  return { shop, ok: true, results };
}

// Runs the check for every connected shop, one after another — not in
// parallel, since CJ only allows about 1 request/second.
async function runPriceCheckForAllShops() {
  const shops = await db.getAllShops();
  const summary = [];
  for (const shop of shops) {
    try {
      summary.push(await runPriceCheckForShop(shop));
    } catch (e) {
      console.error(`Daily price check failed for ${shop}:`, e);
      summary.push({ shop, ok: false, reason: String(e.message || e) });
    }
  }
  return summary;
}

module.exports = { runPriceCheckForShop, runPriceCheckForAllShops };
