'use strict';
const { route, json, jsonBody, rateLimit, HttpError } = require('./_lib/http');
const { db } = require('./_lib/db');
const { safeEqual } = require('./_lib/razorpay');

// The customer closed the payment window without paying. Marks the attempt "Cancelled"
// (only if it is still pending) so the dashboard shows the truth. They can retry any time.
module.exports = route(['POST'], async (req, res) => {
  rateLimit(req, 'cancel-payment', 40, 10 * 60 * 1000);
  const b = await jsonBody(req);
  const orderNo = String(b.orderNo || '').trim().toUpperCase();
  const token = String(b.token || '');
  if (!/^TLA-\d{4}-\d{5,}$/.test(orderNo) || !token) throw new HttpError(400, 'Invalid request.');

  const supa = db();
  const { data: o } = await supa.from('orders').select('id,public_token').eq('order_no', orderNo).maybeSingle();
  if (!o || !safeEqual(token, o.public_token)) throw new HttpError(404, 'Order not found.');

  const now = new Date().toISOString();
  await supa.from('orders').update({ payment_status: 'Cancelled', updated_at: now }).eq('id', o.id).eq('payment_status', 'Pending');
  await supa.from('payments').update({ status: 'Cancelled', updated_at: now }).eq('order_id', o.id).eq('status', 'Pending');
  json(res, 200, { ok: true });
});
