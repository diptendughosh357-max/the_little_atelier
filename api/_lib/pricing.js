'use strict';
// All price maths lives here. Every value is an integer number of paise.
// The server is the only place that decides what a customer owes.

function unitPrice(p) {
  return p.sale_price_paise != null && p.sale_price_paise < p.price_paise ? p.sale_price_paise : p.price_paise;
}

// Shipping rule: free above the threshold (after discount); else a per-state fee if set; else the standard fee.
function shippingFor(shipping, amountAfterDiscount, state) {
  if (shipping.free_threshold_paise != null && amountAfterDiscount >= shipping.free_threshold_paise) return 0;
  const sf = shipping.state_fees || {};
  if (state && Object.prototype.hasOwnProperty.call(sf, state)) return sf[state];
  return shipping.standard_fee_paise;
}

// Returns { ok, discount, reason }.
function couponDiscount(coupon, subtotal, now) {
  now = now || new Date();
  if (!coupon || !coupon.active) return { ok: false, discount: 0, reason: 'This coupon is not valid.' };
  if (coupon.expires_at && new Date(coupon.expires_at) < now) return { ok: false, discount: 0, reason: 'This coupon has expired.' };
  if (coupon.max_uses != null && coupon.used_count >= coupon.max_uses) return { ok: false, discount: 0, reason: 'This coupon has been fully used.' };
  if (subtotal < (coupon.min_paise || 0)) {
    return { ok: false, discount: 0, reason: 'Add items worth Rs ' + Math.ceil((coupon.min_paise - subtotal) / 100) + ' more to use this coupon.' };
  }
  let d = coupon.kind === 'percent' ? Math.floor((subtotal * Math.min(coupon.value, 100)) / 100) : coupon.value;
  d = Math.max(0, Math.min(d, subtotal));
  return { ok: true, discount: d, reason: '' };
}

// lines: [{ unit, qty }]
function computeTotals({ lines, shipping, state, discount }) {
  const subtotal = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  const disc = Math.max(0, Math.min(discount || 0, subtotal));
  const ship = shippingFor(shipping, subtotal - disc, state);
  return { subtotal, discount: disc, shipping: ship, total: subtotal - disc + ship };
}

module.exports = { unitPrice, shippingFor, couponDiscount, computeTotals };
