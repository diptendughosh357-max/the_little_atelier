'use strict';
const crypto = require('crypto');
const { route, json, rawBody, HttpError, ConfigError } = require('./_lib/http');
const { db } = require('./_lib/db');
const rzp = require('./_lib/razorpay');
const { markPaymentFailed } = require('./_lib/payments');

// Razorpay needs the exact bytes it sent in order to check the signature, so Vercel's
// automatic JSON parsing is switched off for this route.
const handler = route(['POST'], async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new ConfigError('Webhook is not configured.');

  const raw = await rawBody(req);
  const signature = String(req.headers['x-razorpay-signature'] || '');
  if (!rzp.verifyWebhookSignature(raw, signature, secret)) throw new HttpError(400, 'Invalid signature');

  let evt;
  try { evt = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'Invalid body'); }
  const eventName = String(evt.event || '');
  const eventId = String(req.headers['x-razorpay-event-id'] || crypto.createHash('sha256').update(raw).digest('hex'));
  const supa = db();

  // Razorpay may deliver the same event more than once. Skip ones we already finished.
  const { data: seen } = await supa.from('webhook_events').select('event_id').eq('event_id', eventId).maybeSingle();
  if (seen) return json(res, 200, { ok: true, duplicate: true });

  const payload = evt.payload || {};
  const pay = payload.payment && payload.payment.entity;

  if ((eventName === 'payment.captured' || eventName === 'order.paid') && pay && pay.status === 'captured') {
    if (pay.currency === 'INR') {
      // Idempotent in the database too, so a duplicate or a race with verify-payment is harmless.
      const { error } = await supa.rpc('confirm_payment', {
        p_razorpay_order_id: pay.order_id, p_payment_id: pay.id, p_method: pay.method || null,
        p_amount: pay.amount, p_source: 'webhook'
      });
      if (error) throw error; // 500 -> Razorpay will retry
    }
  } else if (eventName === 'payment.failed' && pay) {
    await markPaymentFailed(supa, pay.order_id, pay.error_description || 'Payment failed');
  } else if (eventName === 'refund.processed') {
    const rf = payload.refund && payload.refund.entity;
    if (rf && rf.payment_id) {
      const { data: p } = await supa.from('payments').select('id,order_id,amount_paise').eq('razorpay_payment_id', rf.payment_id).maybeSingle();
      if (p) {
        const now = new Date().toISOString();
        if (rf.amount >= p.amount_paise) {
          await supa.from('payments').update({ status: 'Refunded', refund_id: rf.id, updated_at: now }).eq('id', p.id);
          await supa.from('orders').update({ payment_status: 'Refunded', order_status: 'Refunded', updated_at: now }).eq('id', p.order_id);
        } else {
          await supa.from('orders').update({ notes: 'Partial refund of Rs ' + (rf.amount / 100) + ' processed (' + rf.id + ')', updated_at: now }).eq('id', p.order_id);
        }
      }
    }
  } else if (eventName === 'refund.failed') {
    const rf = payload.refund && payload.refund.entity;
    if (rf && rf.payment_id) {
      const { data: p } = await supa.from('payments').select('order_id').eq('razorpay_payment_id', rf.payment_id).maybeSingle();
      if (p) await supa.from('orders').update({ needs_attention: true, notes: 'Refund ' + rf.id + ' FAILED. Check the Razorpay dashboard.', updated_at: new Date().toISOString() }).eq('id', p.order_id);
    }
  }
  // Unknown events are acknowledged and ignored.

  await supa.from('webhook_events').insert({ event_id: eventId, event: eventName });
  json(res, 200, { ok: true });
});

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
