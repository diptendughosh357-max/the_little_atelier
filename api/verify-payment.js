'use strict';
const { route, json, jsonBody, rateLimit, HttpError } = require('./_lib/http');
const { db } = require('./_lib/db');
const rzp = require('./_lib/razorpay');
const { markPaymentFailed } = require('./_lib/payments');

// Called by the browser after Razorpay Checkout finishes. The browser's word is NOT trusted:
// 1) the signature must match, 2) we ask Razorpay directly for the payment's real status,
// 3) the database function re-checks the amount. Only then is the order marked paid.
module.exports = route(['POST'], async (req, res) => {
  rateLimit(req, 'verify-payment', 60, 10 * 60 * 1000);
  const b = await jsonBody(req);
  const oid = String(b.razorpay_order_id || '');
  const pid = String(b.razorpay_payment_id || '');
  const sig = String(b.razorpay_signature || '');
  if (!/^order_[A-Za-z0-9]{6,40}$/.test(oid) || !/^pay_[A-Za-z0-9]{6,40}$/.test(pid) || !/^[A-Fa-f0-9]{64}$/.test(sig)) {
    throw new HttpError(400, 'Invalid payment details.');
  }

  const { secret } = rzp.keys();
  if (!rzp.verifyPaymentSignature(oid, pid, sig.toLowerCase(), secret)) {
    throw new HttpError(400, 'Payment could not be verified.');
  }

  let payment = await rzp.api('GET', '/payments/' + pid);
  if (payment.order_id !== oid) throw new HttpError(400, 'Payment does not belong to this order.');

  if (payment.status === 'authorized') {
    try {
      await rzp.api('POST', '/payments/' + pid + '/capture', { amount: payment.amount, currency: payment.currency });
    } catch (e) { /* may already be auto-captured; re-read below */ }
    payment = await rzp.api('GET', '/payments/' + pid);
  }

  if (payment.status === 'failed') {
    await markPaymentFailed(db(), oid, payment.error_description || 'Payment failed');
    return json(res, 200, { status: 'failed' });
  }
  if (payment.status !== 'captured') return json(res, 200, { status: 'pending' });
  if (payment.currency !== 'INR') throw new HttpError(400, 'Unexpected payment currency.');

  const { data, error } = await db().rpc('confirm_payment', {
    p_razorpay_order_id: oid, p_payment_id: pid, p_method: payment.method || null,
    p_amount: payment.amount, p_source: 'signature'
  });
  if (error) throw error;
  if (!data || data.result === 'not_found') throw new HttpError(404, 'Order not found for this payment.');
  if (data.result === 'amount_mismatch') throw new HttpError(409, 'The paid amount does not match the order. Please contact us on WhatsApp.');
  json(res, 200, { status: 'paid', orderNo: data.order_no });
});
