// Shopify billing: takes a percentage of each order from the seller, through Shopify.
// Nothing here runs unless BILLING_ENABLED=true is set in Render.
//
// Optional settings in Render (all have safe defaults):
//   BILLING_ENABLED  = true to turn billing on (default: off)
//   BILLING_TEST     = false to make REAL charges (default: test charges, no real money)
//   BILLING_PERCENT  = fee percentage per order (default: 5)
//   BILLING_CAP      = most a seller can be charged per 30 days, in USD (default: 100)

const API_VERSION = '2024-10';

const enabled = () => process.env.BILLING_ENABLED === 'true';
const isTest = () => process.env.BILLING_TEST !== 'false';
const percent = () => Number(process.env.BILLING_PERCENT || 5);
const cap = () => Number(process.env.BILLING_CAP || 100);

async function gql(shop, token, query, variables) {
  const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await r.json();
  if (data.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(data.errors));
  return data.data;
}

// Returns the id of the usage line item on the seller's active plan, or null if they have not approved one.
async function activeUsageLineItemId(shop, token) {
  const d = await gql(
    shop,
    token,
    `{ currentAppInstallation { activeSubscriptions { id status lineItems { id plan { pricingDetails { __typename } } } } } }`
  );
  const subs = d?.currentAppInstallation?.activeSubscriptions || [];
  for (const s of subs) {
    for (const li of s.lineItems || []) {
      if (li?.plan?.pricingDetails?.__typename === 'AppUsagePricing') return li.id;
    }
  }
  return null;
}

// Asks Shopify to show the seller an "Approve charge" screen.
// Returns the address to send the seller to, or null if there is nothing to approve.
async function startSubscription(shop, token, returnUrl) {
  if (!enabled()) return null;
  if (await activeUsageLineItemId(shop, token)) return null; // already approved
  const d = await gql(
    shop,
    token,
    `mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
      appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
        confirmationUrl
        userErrors { field message }
      }
    }`,
    {
      name: 'AI Store Builder',
      returnUrl,
      test: isTest(),
      lineItems: [
        {
          plan: {
            appUsagePricingDetails: {
              cappedAmount: { amount: cap(), currencyCode: 'USD' },
              terms: `${percent()}% of each order total, up to $${cap()} every 30 days`,
            },
          },
        },
      ],
    }
  );
  const res = d?.appSubscriptionCreate;
  if (res?.userErrors?.length) throw new Error('appSubscriptionCreate: ' + JSON.stringify(res.userErrors));
  return res?.confirmationUrl || null;
}

// Adds the fee for one order to the seller's Shopify bill. Never throws.
// The idempotency key means a repeated webhook can never charge the same order twice.
async function chargeOrder(shop, token, order) {
  try {
    if (!enabled()) return;
    if (order.totalPrice == null || !(order.totalPrice > 0)) return;
    if ((order.currency || 'USD').toUpperCase() !== 'USD') {
      console.error(`Billing: order #${order.orderNumber} on ${shop} not charged (currency ${order.currency}, only USD is supported so far).`);
      return;
    }
    const fee = Math.round(order.totalPrice * percent()) / 100; // percent of total, to cents
    if (fee < 0.01) return;

    const lineItemId = await activeUsageLineItemId(shop, token);
    if (!lineItemId) {
      console.error(`Billing: ${shop} has not approved a plan, order #${order.orderNumber} not charged.`);
      return;
    }
    const d = await gql(
      shop,
      token,
      `mutation appUsageRecordCreate($id: ID!, $price: MoneyInput!, $description: String!, $key: String) {
        appUsageRecordCreate(subscriptionLineItemId: $id, price: $price, description: $description, idempotencyKey: $key) {
          appUsageRecord { id }
          userErrors { field message }
        }
      }`,
      {
        id: lineItemId,
        price: { amount: fee.toFixed(2), currencyCode: 'USD' },
        description: `${percent()}% fee on order #${order.orderNumber}`,
        key: `order-${order.orderId}`,
      }
    );
    const errs = d?.appUsageRecordCreate?.userErrors;
    if (errs && errs.length) console.error(`Billing: order #${order.orderNumber} on ${shop}:`, errs);
    else console.log(`Billing: charged $${fee.toFixed(2)} to ${shop} for order #${order.orderNumber}`);
  } catch (err) {
    console.error(`Billing failed for order #${order && order.orderNumber} on ${shop}:`, err);
  }
}

module.exports = { startSubscription, chargeOrder, enabled };
