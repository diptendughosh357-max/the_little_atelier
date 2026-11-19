'use strict';
const { route, json, rateLimit, HttpError } = require('./_lib/http');
const { db } = require('./_lib/db');
const { normMobile } = require('./_lib/validate');
const { safeEqual } = require('./_lib/razorpay');

const NOT_FOUND = 'We could not find an order with those details.';

// GET /api/order-details?order=TLA-2026-00001&token=...   (private link)
// GET /api/order-details?order=TLA-2026-00001&mobile=98xxxxxxxx
// An order ID alone never reveals anything. Wrong guesses all get the same answer.
module.exports = route(['GET'], async (req, res) => {
  rateLimit(req, 'order-details', 40, 10 * 60 * 1000);
  const q = req.query || {};
  const orderNo = String(q.order || '').trim().toUpperCase();
  const token = String(q.token || '');
  const mobile = normMobile(q.mobile || '');
  if (!/^TLA-\d{4}-\d{5,}$/.test(orderNo) || (!token && !mobile)) throw new HttpError(404, NOT_FOUND);

  const supa = db();
  const { data: o } = await supa.from('orders').select('*').eq('order_no', orderNo).maybeSingle();

  // Always run a comparison so "not found" and "wrong secret" take about the same time.
  const okToken = token ? safeEqual(token, o ? o.public_token : 'x'.repeat(32)) : false;
  const okMobile = mobile ? safeEqual(mobile, o ? o.mobile : '0000000000') : false;
  if (!o || !(okToken || okMobile)) throw new HttpError(404, NOT_FOUND);

  const { data: items } = await supa.from('order_items')
    .select('name,variant_label,unit_price_paise,qty,line_total_paise').eq('order_id', o.id);

  // Only customer-safe fields. Internal notes and flags are never sent.
  json(res, 200, {
    orderNo: o.order_no,
    createdAt: o.created_at,
    orderStatus: o.order_status,
    paymentStatus: o.payment_status,
    paymentMethod: o.payment_method,
    paymentRef: o.payment_ref,
    paidAt: o.paid_at,
    customerName: o.customer_name,
    address: { line: o.address, landmark: o.landmark, city: o.city, state: o.state, pincode: o.pincode },
    items: (items || []).map((i) => ({ name: i.name, variant: i.variant_label, unit: i.unit_price_paise, qty: i.qty, total: i.line_total_paise })),
    totals: { subtotal: o.subtotal_paise, shipping: o.shipping_paise, discount: o.discount_paise, total: o.total_paise },
    tracking: o.tracking_number || o.tracking_url ? { carrier: o.tracking_carrier, number: o.tracking_number, url: o.tracking_url } : null
  });
});
