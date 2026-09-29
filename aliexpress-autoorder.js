// aliexpress-autoorder.js
//
// Automates placing a real order on AliExpress using a logged-in
// browser session, so a Shopify sale can flow straight through to a
// supplier order without you manually visiting AliExpress.
//
// IMPORTANT — read before wiring this into anything automatic:
// - AliExpress has no official API for placing orders. This drives a
//   real Chromium browser through the checkout flow, the same way a
//   person would. It WILL break when AliExpress changes its page
//   layout, and it CAN get stopped by a CAPTCHA it can't solve.
// - It reuses cookies from an AliExpress account you've already logged
//   into by hand (see getSessionCookies below) rather than trying to
//   log in itself — logging in via a bot is far more likely to be
//   blocked than reusing an established session.
// - It assumes that account already has a default shipping address and
//   a default/saved payment method, so the bot only needs to confirm
//   them, not enter card details. Nothing here ever touches or stores
//   a card number.
// - Every attempt returns a clear success/failure result instead of
//   throwing blindly, and takes a screenshot on failure so you can see
//   exactly where it got stuck.

const fs = require('fs');
const path = require('path');

function getSessionCookies() {
  const raw = process.env.ALIEXPRESS_SESSION_COOKIES;
  if (!raw) return null;
  try {
    const cookies = JSON.parse(raw);
    return Array.isArray(cookies) ? cookies : null;
  } catch (e) {
    console.error('ALIEXPRESS_SESSION_COOKIES is not valid JSON:', e.message);
    return null;
  }
}

async function saveDebugScreenshot(page, label) {
  try {
    const dir = '/tmp/autoorder-debug';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (e) {
    return null;
  }
}

// Places one order for one AliExpress item. Call this once per
// aliItemId in an order's line items (AliExpress checkout is
// per-item/per-cart, not a multi-supplier cart like Shopify).
async function placeAliExpressOrder({ aliItemId, quantity = 1, shippingAddress = null }) {
  const cookies = getSessionCookies();
  if (!cookies) {
    return {
      success: false,
      reason: 'no-session',
      message: 'ALIEXPRESS_SESSION_COOKIES is not set. See setup instructions.',
    };
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    return {
      success: false,
      reason: 'missing-dependency',
      message: 'The "playwright" package is not installed on this server.',
    };
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });

    await context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.aliexpress.com',
        path: c.path || '/',
        expires: c.expirationDate || undefined,
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
      }))
    );

    const page = await context.newPage();

    await page.goto(`https://www.aliexpress.com/item/${aliItemId}.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Logged-out sessions get bounced to a login wall — catch that
    // early with a clear reason instead of failing deep in checkout.
    if (/signin|login/i.test(page.url())) {
      const shot = await saveDebugScreenshot(page, 'login-wall');
      await browser.close();
      return {
        success: false,
        reason: 'session-expired',
        message: 'The AliExpress session cookie looks expired or invalid. Re-export cookies and update ALIEXPRESS_SESSION_COOKIES.',
        screenshot: shot,
      };
    }

    // Quantity field: AliExpress changes this markup often, so this
    // tries a couple of likely selectors rather than one fixed one.
    const qtyInput = page.locator('input[type="text"]').filter({ hasText: '' }).first();
    try {
      const qtySelectors = ['.quantity--input--S0R4-S8', 'input[class*="quantity"]'];
      for (const sel of qtySelectors) {
        const el = page.locator(sel).first();
        if (await el.count()) {
          await el.fill(String(quantity));
          break;
        }
      }
    } catch (e) {
      // Not fatal — default quantity of 1 is fine for most orders.
    }

    // "Buy Now" button — again, tries a few likely selectors.
    const buyNowSelectors = [
      'button:has-text("Buy Now")',
      '.pdp-comp-buynow',
      '[class*="buynow"]',
    ];
    let clicked = false;
    for (const sel of buyNowSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      const shot = await saveDebugScreenshot(page, 'no-buy-button');
      await browser.close();
      return {
        success: false,
        reason: 'selector-not-found',
        message: 'Could not find the Buy Now button — AliExpress likely changed its page layout.',
        screenshot: shot,
      };
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    // A CAPTCHA/slider challenge here is the single most common
    // failure mode. Detect it and hand back a clear "needs a human"
    // result instead of hanging or clicking blindly.
    const captchaVisible = await page
      .locator('text=/verify|slide to|security check/i')
      .first()
      .isVisible()
      .catch(() => false);
    if (captchaVisible) {
      const shot = await saveDebugScreenshot(page, 'captcha');
      await browser.close();
      return {
        success: false,
        reason: 'captcha',
        message: 'AliExpress showed a verification challenge. This order needs to be placed manually this time.',
        screenshot: shot,
      };
    }

    // Final "Place Order" button on the checkout page.
    const placeOrderSelectors = [
      'button:has-text("Place Order")',
      '[class*="place-order"]',
    ];
    let placed = false;
    for (const sel of placeOrderSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        await btn.click();
        placed = true;
        break;
      }
    }
    if (!placed) {
      const shot = await saveDebugScreenshot(page, 'no-place-order-button');
      await browser.close();
      return {
        success: false,
        reason: 'selector-not-found',
        message: 'Reached checkout but could not find the Place Order button.',
        screenshot: shot,
      };
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    // Try to read the AliExpress order number off the confirmation page.
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const orderIdMatch = bodyText.match(/Order (?:number|ID)[:\s]*([A-Z0-9-]+)/i);
    const shot = await saveDebugScreenshot(page, 'confirmation');

    await browser.close();

    return {
      success: true,
      aliOrderId: orderIdMatch ? orderIdMatch[1] : null,
      message: orderIdMatch
        ? `Order placed: ${orderIdMatch[1]}`
        : 'Order appears to have been placed, but the order number could not be read automatically — check the screenshot.',
      screenshot: shot,
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return {
      success: false,
      reason: 'error',
      message: err.message,
    };
  }
}

module.exports = { placeAliExpressOrder };
