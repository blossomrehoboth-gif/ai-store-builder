// Erases shoppers' personal details from old orders.
// Every day (and once shortly after the app starts) it blanks the shopper's name and
// delivery address on any order received more than RETENTION_DAYS ago.
// The order number, items and totals stay, because they are not personal data.
//
// RETENTION_DAYS can be changed in Render (default 180). Set it to 0 to turn this off.

const { Pool } = require('pg');

const DAYS = Number(process.env.RETENTION_DAYS === undefined ? 180 : process.env.RETENTION_DAYS);

function makePool() {
  const url = process.env.DATABASE_URL || '';
  const cfg = { connectionString: url, max: 1 };
  // Same SSL rule as db.js: turn SSL on for any remote database that does not set sslmode itself.
  if (!/sslmode=/.test(url)) {
    const hostPart = (url.split('@')[1] || '').split('/')[0].split(':')[0];
    const remote = hostPart.includes('.') && !/^(localhost|127\.0\.0\.1)$/.test(hostPart);
    if (remote) cfg.ssl = { rejectUnauthorized: false };
  }
  return new Pool(cfg);
}

async function eraseOldOrderDetails(pool) {
  const r = await pool.query(
    `UPDATE sb_orders
        SET customer_name = 'Redacted', address = NULL
      WHERE received_at < now() - ($1::int * interval '1 day')
        AND (address IS NOT NULL OR customer_name IS DISTINCT FROM 'Redacted')`,
    [DAYS]
  );
  if (r.rowCount) console.log(`Retention: erased shopper details on ${r.rowCount} order(s) older than ${DAYS} days.`);
  return r.rowCount;
}

function startRetention() {
  if (!(DAYS > 0)) {
    console.log('Retention job is off (RETENTION_DAYS is 0).');
    return;
  }
  const pool = makePool();
  const run = () => eraseOldOrderDetails(pool).catch((e) => console.error('Retention job failed:', e.message));
  setTimeout(run, 60 * 1000).unref();                 // shortly after start-up
  setInterval(run, 24 * 60 * 60 * 1000).unref();      // then once a day
  console.log(`Retention job on: shopper details are erased ${DAYS} days after an order.`);
}

module.exports = { startRetention, eraseOldOrderDetails };
