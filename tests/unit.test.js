'use strict';
// Pure-logic tests: no database, no network. Run with: npm test
const assert = require('assert');
const crypto = require('crypto');
const { normMobile, validPin, validateCustomer } = require('../api/_lib/validate');
const { unitPrice, shippingFor, couponDiscount, computeTotals } = require('../api/_lib/pricing');
const { verifyPaymentSignature, verifyWebhookSignature } = require('../api/_lib/razorpay');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('mobile numbers: valid forms accepted', () => {
  for (const v of ['9876543210', '+91 98765 43210', '919876543210', '09876543210', '98765-43210', '6000000000']) assert.strictEqual(normMobile(v) !== null, true, v);
  assert.strictEqual(normMobile('+91 98765 43210'), '9876543210');
});
t('mobile numbers: invalid forms rejected', () => {
  for (const v of ['5876543210', '987654321', '98765432100', 'abcdefghij', '', null, '12345', '+1 9876543210']) assert.strictEqual(normMobile(v), null, String(v));
});
t('PIN codes', () => {
  assert.ok(validPin('712123')); assert.ok(validPin('110001'));
  for (const v of ['012345', '71212', '7121234', 'abcdef', '']) assert.ok(!validPin(v), v);
});
t('customer validation reports every bad field', () => {
  assert.throws(() => validateCustomer({}), (e) => !!(e.status === 400 && e.extra.fields.name && e.extra.fields.mobile && e.extra.fields.pincode && e.extra.fields.state));
  const ok = validateCustomer({ name: 'Asha Roy', mobile: '+91 9876543210', address: '12 Station Road, Bandel', city: 'Bandel', state: 'West Bengal', pincode: '712123', email: '' });
  assert.strictEqual(ok.mobile, '9876543210');
  assert.throws(() => validateCustomer({ name: 'A B', mobile: '9876543210', address: '12 Station Road', city: 'X Y', state: 'Narnia', pincode: '712123' }), (e) => !!e.extra.fields.state);
  assert.throws(() => validateCustomer({ name: 'A B', mobile: '9876543210', address: '12 Station Road', city: 'X Y', state: 'Goa', pincode: '712123', email: 'not-an-email' }), (e) => !!e.extra.fields.email);
});
t('sale price is used only when lower', () => {
  assert.strictEqual(unitPrice({ price_paise: 12000, sale_price_paise: null }), 12000);
  assert.strictEqual(unitPrice({ price_paise: 12000, sale_price_paise: 9000 }), 9000);
  assert.strictEqual(unitPrice({ price_paise: 12000, sale_price_paise: 12000 }), 12000);
});
const ship = { standard_fee_paise: 4000, free_threshold_paise: 50000, state_fees: { 'West Bengal': 2500 } };
t('shipping: standard, state override, free threshold', () => {
  assert.strictEqual(shippingFor(ship, 10000, 'Goa'), 4000);
  assert.strictEqual(shippingFor(ship, 10000, 'West Bengal'), 2500);
  assert.strictEqual(shippingFor(ship, 50000, 'Goa'), 0);
  assert.strictEqual(shippingFor(ship, 49999, 'Goa'), 4000);
  assert.strictEqual(shippingFor({ ...ship, free_threshold_paise: null }, 9999999, 'Goa'), 4000);
});
t('totals add up in whole paise', () => {
  const r = computeTotals({ lines: [{ unit: 12000, qty: 2 }, { unit: 5000, qty: 1 }], shipping: ship, state: 'Goa', discount: 0 });
  assert.deepStrictEqual(r, { subtotal: 29000, discount: 0, shipping: 4000, total: 33000 });
});
t('discount can never push the order below zero', () => {
  const r = computeTotals({ lines: [{ unit: 5000, qty: 1 }], shipping: { standard_fee_paise: 0, free_threshold_paise: null, state_fees: {} }, state: 'Goa', discount: 999999 });
  assert.strictEqual(r.total, 0);
});
t('coupons: percent, flat, min order, expiry, usage limit, inactive', () => {
  const base = { active: true, kind: 'percent', value: 10, min_paise: 0, max_uses: null, used_count: 0, expires_at: null };
  assert.strictEqual(couponDiscount(base, 25050).discount, 2505);
  assert.strictEqual(couponDiscount({ ...base, kind: 'flat', value: 5000 }, 3000).discount, 3000);
  assert.strictEqual(couponDiscount({ ...base, min_paise: 20000 }, 10000).ok, false);
  assert.strictEqual(couponDiscount({ ...base, expires_at: '2020-01-01' }, 10000).ok, false);
  assert.strictEqual(couponDiscount({ ...base, max_uses: 3, used_count: 3 }, 10000).ok, false);
  assert.strictEqual(couponDiscount({ ...base, active: false }, 10000).ok, false);
  assert.strictEqual(couponDiscount(null, 10000).ok, false);
});
t('payment signature: right one passes, any tampering fails', () => {
  const secret = 'topsecret';
  const sig = crypto.createHmac('sha256', secret).update('order_ABC123|pay_XYZ789').digest('hex');
  assert.ok(verifyPaymentSignature('order_ABC123', 'pay_XYZ789', sig, secret));
  assert.ok(!verifyPaymentSignature('order_ABC123', 'pay_OTHER00', sig, secret));
  assert.ok(!verifyPaymentSignature('order_OTHER0', 'pay_XYZ789', sig, secret));
  assert.ok(!verifyPaymentSignature('order_ABC123', 'pay_XYZ789', sig, 'wrong'));
  assert.ok(!verifyPaymentSignature('order_ABC123', 'pay_XYZ789', sig.slice(0, 10), secret));
  assert.ok(!verifyPaymentSignature('order_ABC123', 'pay_XYZ789', '', secret));
});
t('webhook signature: must match the exact body bytes', () => {
  const body = '{"event":"payment.captured"}';
  const sig = crypto.createHmac('sha256', 'wh').update(body).digest('hex');
  assert.ok(verifyWebhookSignature(body, sig, 'wh'));
  assert.ok(!verifyWebhookSignature(body + ' ', sig, 'wh'));
  assert.ok(!verifyWebhookSignature(body, sig, 'other'));
  assert.ok(!verifyWebhookSignature(body, undefined, 'wh'));
});

console.log('\n' + n + ' unit tests passed');
