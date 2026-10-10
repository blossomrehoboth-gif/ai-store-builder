// mailer.js - sends alert emails through Resend over HTTPS.
// (Render's free plan blocks Gmail/SMTP, but normal HTTPS works fine.)
// Render environment variables:
//   RESEND_API_KEY  - your key from resend.com
//   ALERT_EMAIL     - the email address you signed up to Resend with
// Safe by design: on any problem it logs and returns false. It never crashes the app.
async function sendAlert(subject, text) {
  try {
    const key = process.env.RESEND_API_KEY;
    const to = process.env.ALERT_EMAIL;
    if (!key || !to) {
      console.error('Alert email skipped: RESEND_API_KEY / ALERT_EMAIL not set.');
      return false;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000); // never hang the page
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AI Store Builder <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      console.error('Alert email failed:', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Alert email failed:', e.message || e);
    return false;
  }
}
module.exports = { sendAlert };
