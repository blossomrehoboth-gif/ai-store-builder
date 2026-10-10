// tracking.js - pulls CJ order status + tracking numbers into your orders.
// Hook up in server.js with ONE line:  require('./tracking')(app, auth, db);
module.exports = function registerTracking(app, auth, db) {
  const { requireUser, requireCjKey } = auth;
  const cjApi = require('./cj').cj;

  // GET or POST /api/orders/refresh-tracking  (GET lets you test it by opening the address in your browser)
  // Looks at every order of yours that was sent to CJ and saves its status and tracking number.
  const refresh = async (req, res) => {
    try {
      const orders = await db.getOrders(req.user.id);
      const sent = orders.filter((o) => o.cjOrderId && !o.fulfilled).slice(0, 15);
      const out = [];
      for (const o of sent) {
        try {
          const path = `/shopping/order/getOrderDetail?orderId=${encodeURIComponent(o.cjOrderId)}`;
          let j = await cjApi(req.cjKey, path);
          if (j && j.success === false && String(j.code) === '1600200') {
            // CJ said "too many requests" - wait a bit and try once more
            await new Promise((ok) => setTimeout(ok, 3000));
            j = await cjApi(req.cjKey, path);
          }
          if (req.query.raw) { out.push({ orderId: o.orderId, cjOrderId: o.cjOrderId, raw: j }); continue; }
          if (!j || !j.data) {
            out.push({ orderId: o.orderId, orderNumber: o.orderNumber, error: 'CJ did not return order data: ' + (j && j.message ? j.message : 'no message') });
            continue;
          }
          const d = j.data;
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
  };
  app.get('/api/orders/refresh-tracking', requireUser, requireCjKey, refresh);
  app.post('/api/orders/refresh-tracking', requireUser, requireCjKey, refresh);
};
