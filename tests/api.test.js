'use strict';
// End-to-end tests of the REAL route code against a REAL PostgreSQL database.
// Razorpay and Supabase Auth are replaced by mocks (we have no accounts yet).
// Run: tests/api-test.sh   (creates the database, then runs this file)
const assert = require('assert');
const crypto = require('crypto');
const { Readable } = require('stream');
const { Pool } = require('pg');

process.env.RAZORPAY_KEY_ID = 'rzp_test_mockkey';
process.env.RAZORPAY_KEY_SECRET = 'mock_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'mock_webhook_secret';
process.env.CRON_SECRET = 'mock_cron_secret';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const pool = new Pool({ host: process.env.PGHOST || '/var/tmp/pgtest', port: +(process.env.PGPORT || 54329), user: 'postgres', database: 'tla_api' });
const { fakeSupabase } = require('./fake-supabase');
const { setClient } = require('../api/_lib/db');

const USERS = { admin: { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com' }, stranger: { id: '22222222-2222-4222-8222-222222222222', email: 'x@example.com' } };
pool.query(`insert into auth.users(id,email) values ('11111111-1111-4111-8111-111111111111','owner@example.com'),('22222222-2222-4222-8222-222222222222','x@example.com') on conflict do nothing`)
  .then(() => pool.query(`insert into admin_users(user_id,email) values ('11111111-1111-4111-8111-111111111111','owner@example.com') on conflict do nothing`))
  .then(() => { global.__ready = true; });
setClient(fakeSupabase(pool, { tok_admin: USERS.admin, tok_stranger: USERS.stranger }));

// ---------- mock Razorpay + Supabase Auth ----------
const rz = { orders: [], payments: {}, refunds: [], captures: [] };
const resp = (status, obj) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj });
global.fetch = async (url, opts) => {
  const u = new URL(url); const method = (opts && opts.method) || 'GET';
  if (u.host === 'api.razorpay.com') {
    const path = u.pathname.replace('/v1', '');
    if (method === 'POST' && path === '/orders') {
      const b = JSON.parse(opts.body); const id = 'order_' + crypto.randomBytes(7).toString('hex');
      rz.orders.push({ id, ...b }); return resp(200, { id, amount: b.amount, currency: 'INR', status: 'created' });
    }
    let m = path.match(/^\/payments\/(pay_\w+)$/);
    if (method === 'GET' && m) return rz.payments[m[1]] ? resp(200, rz.payments[m[1]]) : resp(404, { error: { description: 'not found' } });
    m = path.match(/^\/payments\/(pay_\w+)\/capture$/);
    if (method === 'POST' && m) { rz.payments[m[1]].status = 'captured'; rz.captures.push(m[1]); return resp(200, rz.payments[m[1]]); }
    m = path.match(/^\/payments\/(pay_\w+)\/refund$/);
    if (method === 'POST' && m) { const b = JSON.parse(opts.body); const r = { id: 'rfnd_' + crypto.randomBytes(5).toString('hex'), payment_id: m[1], amount: b.amount, status: 'processed' }; rz.refunds.push(r); return resp(200, r); }
  }
  if (u.host === 'test.supabase.co' && u.pathname === '/auth/v1/token') {
    const b = JSON.parse(opts.body);
    if (u.searchParams.get('grant_type') === 'password') {
      if (b.email === 'owner@example.com' && b.password === 'correct-horse') return resp(200, { access_token: 'tok_admin', refresh_token: 'ref_admin', expires_in: 3600, user: USERS.admin });
      if (b.email === 'x@example.com' && b.password === 'pw-stranger') return resp(200, { access_token: 'tok_stranger', refresh_token: 'ref_s', expires_in: 3600, user: USERS.stranger });
      return resp(400, { error: 'invalid_grant' });
    }
    if (u.searchParams.get('grant_type') === 'refresh_token') {
      return b.refresh_token === 'ref_admin' ? resp(200, { access_token: 'tok_admin', refresh_token: 'ref_admin', expires_in: 3600, user: USERS.admin }) : resp(400, { error: 'invalid_grant' });
    }
  }
  throw new Error('Unexpected fetch ' + method + ' ' + url);
};

// ---------- handlers ----------
const H = {
  products: require('../api/products'), create: require('../api/create-order'), verify: require('../api/verify-payment'),
  webhook: require('../api/razorpay-webhook'), details: require('../api/order-details'), cancel: require('../api/cancel-payment'),
  cron: require('../api/cron-cleanup'), admin: require('../api/admin')
};
async function call(handler, { method = 'GET', query = {}, body, headers = {}, stream } = {}) {
  const req = stream ? Object.assign(Readable.from([Buffer.from(stream)]), { method, headers, query }) : { method, headers, query, body, socket: { remoteAddress: '1.2.3.' + Math.floor(Math.random() * 250) } };
  if (stream) req.socket = { remoteAddress: '9.9.9.9' };
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.raw = b; } };
  await handler(req, res);
  let parsed; try { parsed = JSON.parse(res.raw); } catch (e) { parsed = res.raw; }
  return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.raw };
}
const admin = (action, o = {}) => call(H.admin, { ...o, query: { action, ...(o.query || {}) }, headers: { authorization: 'Bearer tok_admin' } });

// ---------- helpers ----------
const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
const CUSTOMER = { name: 'Test Buyer', mobile: '9876543210', email: 'buyer@example.com', address: '12 Station Road, Bandel', landmark: '', city: 'Bandel', state: 'West Bengal', pincode: '712123', instructions: '' };
const newKey = () => crypto.randomBytes(12).toString('hex');
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

async function checkout(items, o = {}) {
  const key = o.key || newKey();
  const r = await call(H.create, { method: 'POST', body: { items, customer: { ...CUSTOMER, ...(o.customer || {}) }, coupon: o.coupon || '', idempotencyKey: key, ...(o.extra || {}) } });
  return { ...r, key };
}
async function placeOrder(items, o) { const r = await checkout(items, o); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); return { ...r.body, key: r.key }; }
let payN = 0;
async function payFor(o, { status = 'captured', amount, method = 'upi', mutate = {} } = {}) {
  const id = 'pay_test' + String(++payN).padStart(6, '0');
  rz.payments[id] = { id, order_id: o.razorpayOrderId, amount: amount == null ? o.amount : amount, currency: 'INR', status, method, ...mutate };
  return id;
}
const verifyBody = (o, payId, sig) => ({ razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: payId, razorpay_signature: sig || hmac(process.env.RAZORPAY_KEY_SECRET, o.razorpayOrderId + '|' + payId) });
async function payAndVerify(o, opts) { const id = await payFor(o, opts); const r = await call(H.verify, { method: 'POST', body: verifyBody(o, id) }); return { ...r, payId: id }; }
const orderRow = (no) => one('select * from orders where order_no=$1', [no]);
function webhookReq(eventName, payload, eventId) {
  const raw = JSON.stringify({ event: eventName, payload });
  return { raw, headers: { 'x-razorpay-signature': hmac(process.env.RAZORPAY_WEBHOOK_SECRET, raw), 'x-razorpay-event-id': eventId || 'evt_' + newKey() } };
}

// ---------- runner ----------
const tests = []; let failed = 0;
const it = (name, fn) => tests.push([name, fn]);

it('public catalogue: 8 products, trusted prices, colours, shipping not configured', async () => {
  const r = await call(H.products);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.products.length, 8);
  const claw = r.body.products.find((p) => p.slug === 'crochet-claw-hair-clip');
  assert.strictEqual(claw.price_paise, 12000); assert.strictEqual(claw.available, true); assert.strictEqual(claw.stock, null);
  assert.deepStrictEqual(r.body.products.find((p) => p.slug === 'crochet-flower-bun-stick').variants, ['Peach', 'Cream', 'Sky Blue']);
  assert.strictEqual(r.body.shipping.configured, false);
  assert.ok(!('id' in claw) && !('track_stock' in claw), 'internal fields must not leak');
});
it('checkout is closed until the owner saves shipping charges', async () => {
  const r = await checkout([{ slug: 'crochet-keychain', qty: 1 }]);
  assert.strictEqual(r.status, 503); assert.ok(/WhatsApp/.test(r.body.error));
  assert.strictEqual((await q('select count(*) from orders'))[0].count, '0');
  await q(`update settings set value='{"configured":true,"standard_fee_paise":4000,"free_threshold_paise":50000,"state_fees":{}}' where key='shipping'`);
});
it('bad input is rejected with clear field errors', async () => {
  let r = await checkout([{ slug: 'crochet-keychain', qty: 1 }], { customer: { mobile: '12345', pincode: '1234' } });
  assert.strictEqual(r.status, 400); assert.ok(r.body.fields.mobile && r.body.fields.pincode);
  r = await call(H.create, { method: 'POST', body: { items: [{ slug: 'crochet-keychain', qty: 1 }], customer: CUSTOMER, idempotencyKey: 'short' } });
  assert.strictEqual(r.status, 400);
  r = await checkout([{ slug: 'crochet-flower-bun-stick', qty: 1 }]); assert.strictEqual(r.status, 400); assert.ok(/colour/.test(r.body.error));
  r = await checkout([{ slug: 'crochet-flower-bun-stick', variant: 'Neon', qty: 1 }]); assert.strictEqual(r.status, 409);
  r = await checkout([{ slug: 'crochet-keychain', variant: 'Red', qty: 1 }]); assert.strictEqual(r.status, 400);
  r = await checkout([{ slug: 'no-such-thing', qty: 1 }]); assert.strictEqual(r.status, 409);
  r = await checkout([{ slug: 'crochet-keychain', qty: 0 }]); assert.strictEqual(r.status, 400);
  r = await checkout([{ slug: 'crochet-keychain', qty: 21 }]); assert.strictEqual(r.status, 400);
  r = await checkout([]); assert.strictEqual(r.status, 400);
  r = await call(H.create, { method: 'GET' }); assert.strictEqual(r.status, 405);
  assert.strictEqual((await q('select count(*) from orders'))[0].count, '0', 'no order may be created from bad input');
});
it('price tampering from the browser is ignored: server charges database prices', async () => {
  const o = await placeOrder([{ slug: 'crochet-claw-hair-clip', qty: 2, price: 1, price_paise: 1, unit: 1 }], { extra: { total: 100, amount: 100, subtotal: 1 } });
  assert.strictEqual(o.amount, 24000 + 4000);
  assert.strictEqual(rz.orders[rz.orders.length - 1].amount, 28000, 'Razorpay was asked for the real amount');
  const row = await orderRow(o.orderNo);
  assert.strictEqual(row.total_paise, 28000); assert.strictEqual(row.order_status, 'Payment Pending'); assert.strictEqual(row.payment_status, 'Pending');
  assert.ok(/^TLA-\d{4}-\d{5}$/.test(o.orderNo));
  assert.strictEqual((await one('select unit_price_paise u, qty from order_items where order_id=$1', [row.id])).u, 12000);
  assert.strictEqual(o.keyId, 'rzp_test_mockkey');
  assert.ok(!JSON.stringify(o).includes('mock_key_secret'), 'secret must never appear in a response');
});
it('shipping: free above threshold, state override, standard otherwise', async () => {
  let o = await placeOrder([{ slug: 'crochet-flower-bun-stick', variant: 'Peach', qty: 5 }]);
  assert.strictEqual(o.totals.subtotal, 75000); assert.strictEqual(o.totals.shipping, 0); assert.strictEqual(o.amount, 75000);
  await q(`update settings set value = jsonb_set(value, '{state_fees}', '{"West Bengal":2500}') where key='shipping'`);
  o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]); assert.strictEqual(o.amount, 7500);
  o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }], { customer: { state: 'Goa' } }); assert.strictEqual(o.amount, 9000);
  await q(`update settings set value = jsonb_set(value, '{state_fees}', '{}') where key='shipping'`);
});
it('double-click: same key returns the SAME order, no duplicate, no second Razorpay order', async () => {
  const key = newKey(); const items = [{ slug: 'crochet-clutcher', qty: 1 }];
  const before = rz.orders.length;
  const a = await placeOrder(items, { key }); const b = await placeOrder(items, { key });
  assert.strictEqual(a.orderNo, b.orderNo); assert.strictEqual(a.razorpayOrderId, b.razorpayOrderId);
  assert.strictEqual(rz.orders.length, before + 1);
  assert.strictEqual((await q('select count(*) from orders where idempotency_key=$1', [key]))[0].count, '1');
  const par = newKey();
  const [p1, p2] = await Promise.all([checkout(items, { key: par }), checkout(items, { key: par })]);
  assert.strictEqual(p1.status, 200); assert.strictEqual(p2.status, 200); assert.strictEqual(p1.body.orderNo, p2.body.orderNo);
  assert.strictEqual((await q('select count(*) from orders where idempotency_key=$1', [par]))[0].count, '1', 'parallel submits make one order');
});
it('same key with a changed cart is refused', async () => {
  const key = newKey(); await placeOrder([{ slug: 'crochet-clutcher', qty: 1 }], { key });
  const r = await checkout([{ slug: 'crochet-clutcher', qty: 3 }], { key });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.retry, true);
});
it('invalid payment signature is rejected and the order stays unpaid', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  const id = await payFor(o);
  let r = await call(H.verify, { method: 'POST', body: verifyBody(o, id, 'a'.repeat(64)) });
  assert.strictEqual(r.status, 400);
  r = await call(H.verify, { method: 'POST', body: verifyBody(o, id, hmac('wrong-secret', o.razorpayOrderId + '|' + id)) });
  assert.strictEqual(r.status, 400);
  r = await call(H.verify, { method: 'POST', body: { ...verifyBody(o, id), razorpay_payment_id: 'pay_other00001' } });
  assert.strictEqual(r.status, 400);
  r = await call(H.verify, { method: 'POST', body: { razorpay_order_id: 'x', razorpay_payment_id: 'y', razorpay_signature: 'z' } });
  assert.strictEqual(r.status, 400);
  const row = await orderRow(o.orderNo); assert.strictEqual(row.payment_status, 'Pending'); assert.strictEqual(row.order_status, 'Payment Pending');
});
it('failed payment is recorded; customer can retry the same order', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  const r = await payAndVerify(o, { status: 'failed', mutate: { error_description: 'Bank declined' } });
  assert.strictEqual(r.body.status, 'failed');
  assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Failed');
  const retry = await call(H.create, { method: 'POST', body: { items: [{ slug: 'crochet-keychain', qty: 1 }], customer: CUSTOMER, idempotencyKey: o.key } });
  assert.strictEqual(retry.status, 200); assert.strictEqual(retry.body.razorpayOrderId, o.razorpayOrderId);
  assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Pending');
  const ok = await payAndVerify(o); assert.strictEqual(ok.body.status, 'paid');
});
it('cancelled payment window: marked Cancelled, retry reopens it', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  let r = await call(H.cancel, { method: 'POST', body: { orderNo: o.orderNo, token: 'f'.repeat(32) } }); assert.strictEqual(r.status, 404);
  r = await call(H.cancel, { method: 'POST', body: { orderNo: o.orderNo, token: o.token } }); assert.strictEqual(r.status, 200);
  assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Cancelled');
  assert.strictEqual((await one('select status from payments where razorpay_order_id=$1', [o.razorpayOrderId])).status, 'Cancelled');
  const again = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }], { key: o.key });
  assert.strictEqual(again.razorpayOrderId, o.razorpayOrderId); assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Pending');
});
it('successful payment: verified with Razorpay, order paid once, duplicates harmless', async () => {
  const o = await placeOrder([{ slug: 'crochet-claw-hair-clip', qty: 1 }]);
  let r = await payAndVerify(o);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, 'paid'); assert.strictEqual(r.body.orderNo, o.orderNo);
  let row = await orderRow(o.orderNo);
  assert.strictEqual(row.payment_status, 'Successful'); assert.strictEqual(row.order_status, 'Paid'); assert.strictEqual(row.payment_method, 'upi'); assert.ok(row.paid_at); assert.strictEqual(row.payment_ref, r.payId);
  assert.strictEqual((await one('select status, verified_via from payments where razorpay_order_id=$1', [o.razorpayOrderId])).verified_via, 'signature');
  const again = await call(H.verify, { method: 'POST', body: verifyBody(o, r.payId) });
  assert.strictEqual(again.body.status, 'paid');
  const w = webhookReq('payment.captured', { payment: { entity: rz.payments[r.payId] } });
  assert.strictEqual((await call(H.webhook, { method: 'POST', body: w.raw, headers: w.headers })).status, 200);
  row = await orderRow(o.orderNo); assert.strictEqual(row.order_status, 'Paid');
});
it('authorized (not yet captured) payment is captured by the server before the order is marked paid', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  const r = await payAndVerify(o, { status: 'authorized', method: 'card' });
  assert.strictEqual(r.body.status, 'paid'); assert.ok(rz.captures.includes(r.payId));
  assert.strictEqual((await orderRow(o.orderNo)).payment_method, 'card');
});
it('payment still processing is NOT marked paid', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  const r = await payAndVerify(o, { status: 'created' });
  assert.strictEqual(r.body.status, 'pending'); assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Pending');
});
it('amount tampering: a payment for the wrong amount never marks the order paid', async () => {
  const o = await placeOrder([{ slug: 'crochet-claw-hair-clip', qty: 2 }]);
  const r = await payAndVerify(o, { amount: 100 });
  assert.strictEqual(r.status, 409);
  const row = await orderRow(o.orderNo); assert.notStrictEqual(row.payment_status, 'Successful'); assert.strictEqual(row.needs_attention, true);
});
it("a payment that belongs to a DIFFERENT Razorpay order is rejected", async () => {
  const a = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]); const b = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  const id = await payFor(a, { mutate: { order_id: b.razorpayOrderId } });
  const r = await call(H.verify, { method: 'POST', body: verifyBody(a, id) });
  assert.strictEqual(r.status, 400); assert.strictEqual((await orderRow(a.orderNo)).payment_status, 'Pending');
});
it('webhook: signature required, secret required, raw stream body works', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  const id = await payFor(o);
  const w = webhookReq('payment.captured', { payment: { entity: rz.payments[id] } });
  let r = await call(H.webhook, { method: 'POST', body: w.raw, headers: { ...w.headers, 'x-razorpay-signature': 'b'.repeat(64) } });
  assert.strictEqual(r.status, 400); assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Pending');
  r = await call(H.webhook, { method: 'POST', body: w.raw, headers: { ...w.headers, 'x-razorpay-signature': undefined } }); assert.strictEqual(r.status, 400);
  r = await call(H.webhook, { method: 'POST', body: w.raw + ' ', headers: w.headers }); assert.strictEqual(r.status, 400, 'altered body must fail');
  const saved = process.env.RAZORPAY_WEBHOOK_SECRET; delete process.env.RAZORPAY_WEBHOOK_SECRET;
  r = await call(H.webhook, { method: 'POST', body: w.raw, headers: w.headers }); assert.strictEqual(r.status, 503);
  process.env.RAZORPAY_WEBHOOK_SECRET = saved;
  r = await call(H.webhook, { method: 'POST', stream: w.raw, headers: w.headers });
  assert.strictEqual(r.status, 200); const row = await orderRow(o.orderNo);
  assert.strictEqual(row.payment_status, 'Successful');
  assert.strictEqual((await one('select verified_via from payments where razorpay_order_id=$1', [o.razorpayOrderId])).verified_via, 'webhook');
  r = await call(H.webhook, { method: 'POST', stream: w.raw, headers: w.headers });
  assert.strictEqual(r.body.duplicate, true, 'same event id is skipped');
});
it('webhook: duplicate events with different ids never double-process; late "failed" cannot undo a paid order', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  await q(`update products set track_stock=true, stock=10 where slug='crochet-keychain'`);
  const id = await payFor(o); const ent = rz.payments[id];
  for (let i = 0; i < 3; i++) { const w = webhookReq('payment.captured', { payment: { entity: ent } }); assert.strictEqual((await call(H.webhook, { method: 'POST', body: w.raw, headers: w.headers })).status, 200); }
  assert.strictEqual((await one(`select stock from products where slug='crochet-keychain'`)).stock, 9, 'stock reduced exactly once');
  const f = webhookReq('payment.failed', { payment: { entity: { ...ent, status: 'failed', error_description: 'late failure' } } });
  await call(H.webhook, { method: 'POST', body: f.raw, headers: f.headers });
  assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Successful');
  await q(`update products set track_stock=false, stock=0 where slug='crochet-keychain'`);
});
it('webhook: payment.failed marks a pending order Failed; unknown events are acknowledged', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  let w = webhookReq('payment.failed', { payment: { entity: { id: 'pay_fail000001', order_id: o.razorpayOrderId, status: 'failed', error_description: 'x' } } });
  assert.strictEqual((await call(H.webhook, { method: 'POST', body: w.raw, headers: w.headers })).status, 200);
  assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Failed');
  w = webhookReq('something.new', {}); assert.strictEqual((await call(H.webhook, { method: 'POST', body: w.raw, headers: w.headers })).status, 200);
});
it('order lookup is private: ID alone shows nothing, token or matching mobile works, no internal fields', async () => {
  const o = await placeOrder([{ slug: 'crochet-claw-hair-clip', qty: 1 }]); await payAndVerify(o);
  await q(`update orders set notes='INTERNAL SECRET NOTE' where order_no=$1`, [o.orderNo]);
  const g = (query) => call(H.details, { query });
  assert.strictEqual((await g({ order: o.orderNo })).status, 404);
  assert.strictEqual((await g({ order: o.orderNo, mobile: '9000000000' })).status, 404);
  assert.strictEqual((await g({ order: o.orderNo, token: 'f'.repeat(32) })).status, 404);
  assert.strictEqual((await g({ order: 'TLA-2026-99999', token: o.token })).status, 404);
  assert.strictEqual((await g({ order: "x' or 1=1 --", token: o.token })).status, 404);
  const a = await g({ order: o.orderNo, token: o.token }); assert.strictEqual(a.status, 200);
  const b = await g({ order: o.orderNo.toLowerCase(), mobile: '+91 98765 43210' }); assert.strictEqual(b.status, 200);
  assert.strictEqual(a.body.paymentStatus, 'Successful'); assert.strictEqual(a.body.items[0].name, 'Crochet Claw Hair Clip'); assert.strictEqual(a.body.totals.total, 16000);
  const text = a.raw; assert.ok(!/INTERNAL SECRET|needs_attention|public_token|idempotency|notes/.test(text), 'internal fields must not be exposed');
});
it('stock limits: cannot order more than available; stock drops only after verified payment; admin cancel restores it', async () => {
  await q(`update products set track_stock=true, stock=1 where slug='crochet-claw-hair-clip'`);
  let r = await checkout([{ slug: 'crochet-claw-hair-clip', qty: 2 }]); assert.strictEqual(r.status, 409); assert.ok(/Only 1 left/.test(r.body.error));
  const o = await placeOrder([{ slug: 'crochet-claw-hair-clip', qty: 1 }]);
  assert.strictEqual((await one(`select stock from products where slug='crochet-claw-hair-clip'`)).stock, 1, 'not reduced before payment');
  await payAndVerify(o);
  assert.strictEqual((await one(`select stock from products where slug='crochet-claw-hair-clip'`)).stock, 0);
  r = await checkout([{ slug: 'crochet-claw-hair-clip', qty: 1 }]); assert.strictEqual(r.status, 409); assert.ok(/out of stock/.test(r.body.error));
  assert.strictEqual((await call(H.products)).body.products.find((p) => p.slug === 'crochet-claw-hair-clip').available, false);
  const row = await orderRow(o.orderNo);
  const c = await admin('order-cancel', { method: 'POST', body: { id: row.id } });
  assert.strictEqual(c.status, 200); assert.strictEqual(c.body.refundNeeded, true);
  assert.strictEqual((await one(`select stock from products where slug='crochet-claw-hair-clip'`)).stock, 1, 'stock restored on cancel');
  const c2 = await admin('order-cancel', { method: 'POST', body: { id: row.id } }); assert.strictEqual(c2.status, 409);
  await q(`update products set track_stock=false, stock=0 where slug='crochet-claw-hair-clip'`);
});
it('coupons: discount computed on the server, invalid ones refused, usage counted on payment', async () => {
  await q(`insert into coupons(code,kind,value,min_paise,max_uses) values ('TEST10','percent',10,0,5),('OLD','flat',500,0,null)`);
  await q(`update coupons set expires_at = now() - interval '1 day' where code='OLD'`);
  const items = [{ slug: 'crochet-claw-hair-clip', qty: 2 }];
  const o = await placeOrder(items, { coupon: 'test10' });
  assert.strictEqual(o.totals.discount, 2400); assert.strictEqual(o.amount, 24000 - 2400 + 4000);
  let r = await checkout(items, { coupon: 'NOPE' }); assert.strictEqual(r.status, 400);
  r = await checkout(items, { coupon: 'OLD' }); assert.strictEqual(r.status, 400); assert.ok(/expired/.test(r.body.error));
  const pv = await call(H.products, { query: { coupon: 'TEST10', subtotal: '24000' } }); assert.strictEqual(pv.body.valid, true); assert.strictEqual(pv.body.discount_paise, 2400);
  await payAndVerify(o);
  assert.strictEqual((await one(`select used_count from coupons where code='TEST10'`)).used_count, 1);
});
it('refund webhook marks the order Refunded; partial refund does not', async () => {
  const o = await placeOrder([{ slug: 'crochet-claw-hair-clip', qty: 1 }]); const p = await payAndVerify(o);
  let w = webhookReq('refund.processed', { refund: { entity: { id: 'rfnd_part1', payment_id: p.payId, amount: 5000 } } });
  await call(H.webhook, { method: 'POST', body: w.raw, headers: w.headers });
  assert.strictEqual((await orderRow(o.orderNo)).payment_status, 'Successful');
  w = webhookReq('refund.processed', { refund: { entity: { id: 'rfnd_full1', payment_id: p.payId, amount: o.amount } } });
  await call(H.webhook, { method: 'POST', body: w.raw, headers: w.headers });
  const row = await orderRow(o.orderNo); assert.strictEqual(row.payment_status, 'Refunded'); assert.strictEqual(row.order_status, 'Refunded');
});
it('daily cleanup: needs the secret; cancels only old unpaid orders', async () => {
  const old = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]); const fresh = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]);
  await q(`update orders set created_at = now() - interval '2 days' where order_no=$1`, [old.orderNo]);
  assert.strictEqual((await call(H.cron, {})).status, 401);
  assert.strictEqual((await call(H.cron, { headers: { authorization: 'Bearer nope' } })).status, 401);
  const r = await call(H.cron, { headers: { authorization: 'Bearer mock_cron_secret' } });
  assert.strictEqual(r.status, 200); assert.ok(r.body.cancelled >= 1);
  assert.strictEqual((await orderRow(old.orderNo)).order_status, 'Cancelled'); assert.strictEqual((await orderRow(fresh.orderNo)).order_status, 'Payment Pending');
});

// ---------------- admin ----------------
it('admin login: wrong password, non-admin account, and a real admin', async () => {
  await q(`insert into auth.users(id,email) values ($1,$2),($3,$4) on conflict do nothing`, [USERS.admin.id, USERS.admin.email, USERS.stranger.id, USERS.stranger.email]);
  await q(`insert into admin_users(user_id,email) values ($1,$2) on conflict do nothing`, [USERS.admin.id, USERS.admin.email]);
  const L = (email, password) => call(H.admin, { method: 'POST', query: { action: 'login' }, body: { email, password } });
  assert.strictEqual((await L('owner@example.com', 'wrong')).status, 401);
  assert.strictEqual((await L('x@example.com', 'pw-stranger')).status, 403, 'valid Supabase user who is not an admin');
  const ok = await L('owner@example.com', 'correct-horse'); assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.access_token, 'tok_admin');
  assert.strictEqual((await call(H.admin, { method: 'POST', query: { action: 'refresh' }, body: { refresh_token: 'bad' } })).status, 401);
  assert.strictEqual((await call(H.admin, { method: 'POST', query: { action: 'refresh' }, body: { refresh_token: 'ref_admin' } })).status, 200);
});
it('admin endpoints are locked: no token, bad token, non-admin token', async () => {
  for (const action of ['stats', 'orders', 'products', 'customers', 'settings', 'export']) {
    assert.strictEqual((await call(H.admin, { query: { action } })).status, 401, action);
    assert.strictEqual((await call(H.admin, { query: { action }, headers: { authorization: 'Bearer junk' } })).status, 401, action);
    assert.strictEqual((await call(H.admin, { query: { action }, headers: { authorization: 'Bearer tok_stranger' } })).status, 403, action);
  }
  for (const action of ['order-update', 'order-cancel', 'order-refund', 'product-save', 'product-archive', 'settings-save', 'upload']) {
    assert.strictEqual((await call(H.admin, { method: 'POST', query: { action }, body: {} })).status, 401, action);
    assert.strictEqual((await call(H.admin, { method: 'POST', query: { action }, body: {}, headers: { authorization: 'Bearer tok_stranger' } })).status, 403, action);
  }
  assert.strictEqual((await admin('nonsense')).status, 404);
  assert.strictEqual((await admin('stats', { method: 'POST', body: {} })).status, 404, 'wrong method');
});
it('admin overview and reports', async () => {
  const r = await admin('stats'); assert.strictEqual(r.status, 200);
  const paid = await one(`select count(*)::int n, coalesce(sum(total_paise),0)::int s from orders where payment_status='Successful'`);
  assert.strictEqual(r.body.paidOrders, paid.n); assert.strictEqual(r.body.totalSales, paid.s); assert.ok(r.body.totalSales > 0);
  assert.ok(r.body.bestSellers.length > 0 && r.body.methods.some((m) => m.method === 'upi'));
  assert.ok(r.body.daily.length >= 1 && r.body.monthly.length >= 1); assert.ok(r.body.counts.awaiting_payment >= 1);
  assert.strictEqual(r.body.todaySales, r.body.totalSales, 'all test orders were paid today');
});
it('admin orders: list, filters, search, detail', async () => {
  let r = await admin('orders'); assert.strictEqual(r.status, 200); assert.ok(r.body.total > 5);
  r = await admin('orders', { query: { pay: 'Successful' } }); assert.ok(r.body.orders.every((o) => o.payment_status === 'Successful'));
  r = await admin('orders', { query: { status: 'Cancelled' } }); assert.ok(r.body.orders.every((o) => o.order_status === 'Cancelled'));
  r = await admin('orders', { query: { q: 'Test Buyer' } }); assert.ok(r.body.orders.length > 0);
  r = await admin('orders', { query: { q: '98765' } }); assert.ok(r.body.orders.length > 0);
  r = await admin('orders', { query: { q: 'nobody-here' } }); assert.strictEqual(r.body.orders.length, 0);
  r = await admin('orders', { query: { q: "'; drop table orders; --" } }); assert.strictEqual(r.status, 200);
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  r = await admin('orders', { query: { from: today, to: today } }); assert.ok(r.body.orders.length > 0);
  r = await admin('orders', { query: { from: '2001-01-01', to: '2001-01-02' } }); assert.strictEqual(r.body.orders.length, 0);
  r = await admin('orders', { query: { limit: '2', page: '2' } }); assert.strictEqual(r.body.orders.length, 2);
  const first = (await admin('orders', { query: { pay: 'Successful' } })).body.orders[0];
  const d = await admin('order', { query: { id: first.id } }); assert.strictEqual(d.status, 200); assert.ok(d.body.items.length && d.body.payments.length);
  assert.strictEqual((await admin('order', { query: { id: 'not-a-uuid' } })).status, 400);
});
it('admin order status: only verified-paid orders move forward; tracking saved; no hand-set Paid', async () => {
  const unpaid = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]); const unpaidRow = await orderRow(unpaid.orderNo);
  let r = await admin('order-update', { method: 'POST', body: { id: unpaidRow.id, status: 'Shipped' } }); assert.strictEqual(r.status, 409);
  const paid = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }]); await payAndVerify(paid); const row = await orderRow(paid.orderNo);
  r = await admin('order-update', { method: 'POST', body: { id: row.id, status: 'Paid' } }); assert.strictEqual(r.status, 400);
  r = await admin('order-update', { method: 'POST', body: { id: row.id, status: 'Refunded' } }); assert.strictEqual(r.status, 400);
  r = await admin('order-update', { method: 'POST', body: { id: row.id, tracking: { url: 'javascript:alert(1)' } } }); assert.strictEqual(r.status, 400);
  r = await admin('order-update', { method: 'POST', body: { id: row.id, status: 'Processing' } }); assert.strictEqual(r.status, 200);
  r = await admin('order-update', { method: 'POST', body: { id: row.id, status: 'Shipped', tracking: { carrier: 'India Post', number: 'EE123456789IN', url: 'https://example.com/track/1' } } }); assert.strictEqual(r.status, 200);
  const after = await orderRow(paid.orderNo); assert.strictEqual(after.order_status, 'Shipped'); assert.strictEqual(after.tracking_number, 'EE123456789IN');
  const cust = await call(H.details, { query: { order: paid.orderNo, token: paid.token } });
  assert.strictEqual(cust.body.orderStatus, 'Shipped'); assert.strictEqual(cust.body.tracking.carrier, 'India Post');
  r = await admin('order-cancel', { method: 'POST', body: { id: row.id } }); assert.strictEqual(r.status, 409, 'shipped orders cannot be cancelled');
});
it('admin refund: goes through Razorpay once, order marked Refund Initiated, double refund blocked', async () => {
  const o = await placeOrder([{ slug: 'crochet-clutcher', qty: 1 }]); const p = await payAndVerify(o); const row = await orderRow(o.orderNo);
  let r = await admin('order-refund', { method: 'POST', body: { id: row.id, amount_paise: 99999999 } }); assert.strictEqual(r.status, 400);
  r = await admin('order-refund', { method: 'POST', body: { id: row.id } }); assert.strictEqual(r.status, 200);
  const rf = rz.refunds[rz.refunds.length - 1]; assert.strictEqual(rf.payment_id, p.payId); assert.strictEqual(rf.amount, row.total_paise);
  assert.strictEqual((await orderRow(o.orderNo)).order_status, 'Refund Initiated');
  r = await admin('order-refund', { method: 'POST', body: { id: row.id } }); assert.strictEqual(r.status, 409); assert.strictEqual(rz.refunds.length >= 1, true);
  const unpaid = await orderRow((await placeOrder([{ slug: 'crochet-keychain', qty: 1 }])).orderNo);
  assert.strictEqual((await admin('order-refund', { method: 'POST', body: { id: unpaid.id } })).status, 409);
});
it('CSV export: right columns, filters, and spreadsheet-formula injection is neutralised', async () => {
  const o = await placeOrder([{ slug: 'crochet-keychain', qty: 1 }], { customer: { name: '=HYPERLINK("http://evil","x")', mobile: '9123456780' } }); await payAndVerify(o);
  const r = await admin('export', { query: { pay: 'Successful' } });
  assert.strictEqual(r.status, 200); assert.ok(/text\/csv/.test(r.headers['content-type'])); assert.ok(/attachment/.test(r.headers['content-disposition']));
  assert.ok(r.raw.includes('"Order ID"') && r.raw.includes(o.orderNo));
  assert.ok(r.raw.includes('"\'=HYPERLINK('), 'formula must be prefixed with an apostrophe');
  assert.ok(!r.raw.includes(',"=HYPERLINK'));
  const lines = r.raw.trim().split('\r\n'); assert.ok(lines.length > 5);
});
it('admin products: create with colours, edit price, validation, archive hides it and blocks ordering', async () => {
  let r = await admin('product-save', { method: 'POST', body: { name: 'Test Bow', category: 'Hair Clips', price_paise: 7500, description: 'A bow', is_available: true, variants: ['Pink', 'Blue', 'Pink'] } });
  assert.strictEqual(r.status, 200); const id = r.body.id;
  let pub = (await call(H.products)).body.products.find((p) => p.slug === 'test-bow'); assert.ok(pub); assert.deepStrictEqual(pub.variants, ['Pink', 'Blue']); assert.strictEqual(pub.price_paise, 7500);
  r = await admin('product-save', { method: 'POST', body: { id, name: 'Test Bow', category: 'Hair Clips', price_paise: 7500, sale_price_paise: 9000, is_available: true } }); assert.strictEqual(r.status, 400);
  r = await admin('product-save', { method: 'POST', body: { id, name: 'Test Bow', category: 'Hair Clips', price_paise: 7500, sale_price_paise: 6000, is_available: true, variants: ['Pink'] } }); assert.strictEqual(r.status, 200);
  pub = (await call(H.products)).body.products.find((p) => p.slug === 'test-bow'); assert.strictEqual(pub.sale_price_paise, 6000);
  const o = await placeOrder([{ slug: 'test-bow', variant: 'Pink', qty: 1 }]); assert.strictEqual(o.totals.subtotal, 6000, 'sale price is what is charged');
  r = await admin('product-save', { method: 'POST', body: { name: 'X', category: 'Hair Clips', price_paise: 7500 } }); assert.strictEqual(r.status, 400);
  r = await admin('product-save', { method: 'POST', body: { name: 'Bad', category: 'Hair Clips', price_paise: 'free' } }); assert.strictEqual(r.status, 400);
  r = await admin('product-save', { method: 'POST', body: { name: 'Bad', category: 'Hair Clips', price_paise: 500, image_url: 'javascript:alert(1)' } }); assert.strictEqual(r.status, 400);
  r = await admin('product-archive', { method: 'POST', body: { id, archived: true } }); assert.strictEqual(r.status, 200);
  assert.ok(!(await call(H.products)).body.products.find((p) => p.slug === 'test-bow'));
  assert.strictEqual((await checkout([{ slug: 'test-bow', variant: 'Pink', qty: 1 }])).status, 409);
  assert.ok((await admin('products')).body.products.find((p) => p.slug === 'test-bow').archived);
  const up = await admin('upload', { method: 'POST', body: { contentType: 'text/html', dataBase64: 'PGI+' } }); assert.strictEqual(up.status, 400);
});
it('admin shipping settings: saved, validated, and used by checkout', async () => {
  let r = await admin('settings-save', { method: 'POST', body: { standard_fee_paise: 6000, free_threshold_paise: 100000, state_fees: { 'West Bengal': 3000 } } }); assert.strictEqual(r.status, 200);
  assert.strictEqual((await admin('settings')).body.shipping.standard_fee_paise, 6000);
  assert.strictEqual((await placeOrder([{ slug: 'crochet-keychain', qty: 1 }])).amount, 8000);
  assert.strictEqual((await placeOrder([{ slug: 'crochet-keychain', qty: 1 }], { customer: { state: 'Goa' } })).amount, 11000);
  r = await admin('settings-save', { method: 'POST', body: { standard_fee_paise: -5, state_fees: {} } }); assert.strictEqual(r.status, 400);
  r = await admin('settings-save', { method: 'POST', body: { standard_fee_paise: 100, state_fees: { Atlantis: 5 } } }); assert.strictEqual(r.status, 400);
});
it('admin customers: list, search, history', async () => {
  const r = await admin('customers'); assert.strictEqual(r.status, 200); const c = r.body.customers.find((x) => x.mobile === '9876543210');
  assert.ok(c && c.orders > 3 && c.spent > 0);
  assert.ok((await admin('customers', { query: { q: 'Test Buyer' } })).body.customers.length >= 1);
  const d = await admin('customer', { query: { id: c.id } }); assert.strictEqual(d.status, 200); assert.ok(d.body.orders.length === c.orders);
});

(async () => {
  while (!global.__ready) await new Promise((r) => setTimeout(r, 20));
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' API tests passed');
  await pool.end(); process.exit(failed ? 1 : 0);
})();
