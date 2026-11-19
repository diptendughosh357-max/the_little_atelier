'use strict';
const crypto = require('crypto');
const { ConfigError } = require('./http');

function keys() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new ConfigError('Online payments are not switched on yet.');
  return { id, secret };
}

// Plain calls to the Razorpay REST API (no SDK needed). The secret never leaves the server.
async function api(method, path, body) {
  const { id, secret } = keys();
  const r = await fetch('https://api.razorpay.com/v1' + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error('Razorpay ' + r.status + ': ' + ((data.error && data.error.description) || text.slice(0, 200)));
    err.status = r.status;
    throw err;
  }
  return data;
}

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Constant-time comparison so response time does not leak how much of a guess was right.
function safeEqual(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Checkout success signature: HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET)
function verifyPaymentSignature(orderId, paymentId, signature, secret) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  return safeEqual(hmacHex(secret, orderId + '|' + paymentId), signature);
}

// Webhook signature: HMAC_SHA256(raw request body, WEBHOOK_SECRET)
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  return safeEqual(hmacHex(secret, rawBody), signature);
}

module.exports = { api, keys, hmacHex, safeEqual, verifyPaymentSignature, verifyWebhookSignature };
