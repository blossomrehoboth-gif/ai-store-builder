// tracking.js - pulls CJ order status + tracking numbers into your orders.
// Hook up in server.js with ONE line:  require('./tracking')(app, auth, db);
module.exports = function registerTracking(app, auth, db) {
  const { requireUser, requireCjKey } = auth;
  const cjApi = require('./cj').cj;

  // POST /api/orders/refresh-tracking
  // Looks at every order of yours that was sent to CJ and saves its status and tracking number.
  app.post('/api/orders/refresh-tracking', requireUser, requireCjKey, async (req, res) => {
    try {
      const orders = await db.getOrders(req.user.id);
      const sent = orders.filter((o) => o.cjOrderId && !o.fulfilled).slice(0, 15);
      const out = [];
      for (const o of sent) {
        try {
          const j = await cjApi(
            req.cjKey,
            `/shopping/order/getOrderDetail?orderId=${encodeURIComponent(o.cjOrderId)}`
          );
          const d = j?.data || {};
          const tracking = d.trackNumber || d.trackingNumber || null;
          const carrier = d.logisticName || d.logistic || null;
          const status = d.orderStatus || d.status || null;
          await db.updateOrder(o.orderId, {
            trackingNumber: tracking,
            carrier,
            cjStatus: status,
          });
          out.push({ orderId: o.orderId, orderNumber: o.orderNumber, status, tracking, carrier });
        } catch (e) {
          out.push({ orderId: o.orderId, orderNumber: o.orderNumber, error: String(e.message || e) });
        }
        await new Promise((ok) => setTimeout(ok, 1100)); // CJ rate limit
      }
      res.json({ checked: out.length, results: out });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
};
