'use strict';

// Records a failed attempt. Never touches an order that is already paid.
// (The failed payment id is NOT stored on the payments row: a customer may retry with
// a different payment id, and the successful one must be able to claim that column.)
async function markPaymentFailed(supa, rzpOrderId, message) {
  const { data: pay } = await supa.from('payments').select('id,order_id,status').eq('razorpay_order_id', rzpOrderId).maybeSingle();
  if (!pay || pay.status === 'Successful') return false;
  const now = new Date().toISOString();
  await supa.from('payments').update({ status: 'Failed', error: String(message || 'Payment failed').slice(0, 300), updated_at: now })
    .eq('id', pay.id).neq('status', 'Successful');
  await supa.from('orders').update({ payment_status: 'Failed', updated_at: now })
    .eq('id', pay.order_id).neq('payment_status', 'Successful');
  return true;
}

module.exports = { markPaymentFailed };
