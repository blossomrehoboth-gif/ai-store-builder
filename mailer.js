// mailer.js - sends alert emails through Gmail (Nodemailer).
// Needs two Render environment variables: GMAIL_USER and GMAIL_APP_PASSWORD.
// Optional: ALERT_EMAIL (where alerts go; defaults to GMAIL_USER).
// Safe by design: if anything is missing or fails, it logs and returns
// false. It never crashes the app.
async function sendAlert(subject, text) {
  try {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) {
      console.error('Alert email skipped: GMAIL_USER / GMAIL_APP_PASSWORD not set.');
      return false;
    }
    const nodemailer = require('nodemailer'); // loaded lazily so a missing package can't crash startup
    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass: pass.replace(/\s+/g, '') },
    });
    await transport.sendMail({
      from: `AI Store Builder <${user}>`,
      to: process.env.ALERT_EMAIL || user,
      subject,
      text,
    });
    return true;
  } catch (e) {
    console.error('Alert email failed:', e.message || e);
    return false;
  }
}
module.exports = { sendAlert };
