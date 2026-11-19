'use strict';
const crypto = require('crypto');
const { route, json, jsonBody, rateLimit, HttpError, ConfigError } = require('./_lib/http');
const { db } = require('./_lib/db');
const { clean, STATES } = require('./_lib/validate');
const rzp = require('./_lib/razorpay');

// One function serves the whole admin dashboard (keeps us inside Vercel's free-plan function limit).
// Every action except "login" and "refresh" requires a valid Supabase session of a user listed in admin_users.

const ORDER_STATUSES = ['Pending', 'Payment Pending', 'Paid', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Refund Initiated', 'Refunded'];
const PAY_STATUSES = ['Pending', 'Successful', 'Failed', 'Cancelled', 'Refunded'];
const FULFIL = ['Processing', 'Shipped', 'Out for Delivery', 'Delivered'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------- auth ----------------
async function supaAuth(grant, body) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new ConfigError('Admin login is not set up yet.');
  const r = await fetch(url + '/auth/v1/token?grant_type=' + grant, {
    method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

async function isAdmin(userId) {
  const { data } = await db().from('admin_users').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}

async function requireAdmin(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'Please sign in.');
  const { data, error } = await db().auth.getUser(token);
  if (error || !data || !data.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  if (!(await isAdmin(data.user.id))) throw new HttpError(403, 'This account is not an administrator.');
  return data.user;
}

async function login(req, res) {
  rateLimit(req, 'admin-login', 8, 15 * 60 * 1000);
  const b = await jsonBody(req);
  const email = clean(b.email, 120).toLowerCase();
  const password = String(b.password || '').slice(0, 200);
  if (!email || !password) throw new HttpError(400, 'Enter your email and password.');
  const r = await supaAuth('password', { email, password });
  if (!r.ok || !r.data.access_token) throw new HttpError(401, 'Incorrect email or password.');
  if (!(await isAdmin(r.data.user.id))) throw new HttpError(403, 'This account is not allowed to use the dashboard.');
  json(res, 200, { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_in: r.data.expires_in, email: r.data.user.email });
}

async function refresh(req, res) {
  rateLimit(req, 'admin-refresh', 60, 15 * 60 * 1000);
  const b = await jsonBody(req);
  const r = await supaAuth('refresh_token', { refresh_token: String(b.refresh_token || '') });
  if (!r.ok || !r.data.access_token) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  if (!(await isAdmin(r.data.user.id))) throw new HttpError(403, 'Not an administrator.');
  json(res, 200, { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_in: r.data.expires_in, email: r.data.user.email });
}

// ---------------- helpers ----------------
const istDay = (iso) => new Date(new Date(iso).getTime() + 19800000).toISOString().slice(0, 10);
const intIn = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, label + ' must be a whole number between ' + min + ' and ' + max + '.');
  return n;
};
const needId = (v) => { const id = String(v || ''); if (!UUID.test(id)) throw new HttpError(400, 'Invalid id.'); return id; };

function applyOrderFilters(qb, q) {
  if (q.status && ORDER_STATUSES.includes(q.status)) qb = qb.eq('order_status', q.status);
  if (q.pay && PAY_STATUSES.includes(q.pay)) qb = qb.eq('payment_status', q.pay);
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) qb = qb.gte('created_at', q.from + 'T00:00:00+05:30');
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) qb = qb.lte('created_at', q.to + 'T23:59:59.999+05:30');
  if (q.attention === '1') qb = qb.eq('needs_attention', true);
  const s = String(q.q || '').replace(/[^A-Za-z0-9 \-+.@]/g, '').trim().slice(0, 40);
  if (s) qb = qb.or('order_no.ilike.%' + s + '%,customer_name.ilike.%' + s + '%,mobile.ilike.%' + s + '%');
  return qb;
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stops spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

// ---------------- actions ----------------
const A = {};

A.stats = { method: 'GET', run: async (req, res) => {
  const supa = db();
  const { data: rows, error } = await supa.from('orders')
    .select('order_status,payment_status,payment_method,total_paise,created_at,paid_at,needs_attention')
    .order('created_at', { ascending: false }).limit(20000);
  if (error) throw error;

  const c = { awaiting_payment: 0, to_process: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0, refunds: 0, attention: 0 };
  const paid = [];
  for (const r of rows) {
    if (r.order_status === 'Payment Pending' || r.order_status === 'Pending') c.awaiting_payment++;
    else if (r.order_status === 'Paid') c.to_process++;
    else if (r.order_status === 'Processing') c.processing++;
    else if (r.order_status === 'Shipped' || r.order_status === 'Out for Delivery') c.shipped++;
    else if (r.order_status === 'Delivered') c.delivered++;
    else if (r.order_status === 'Cancelled') c.cancelled++;
    else if (r.order_status === 'Refund Initiated' || r.order_status === 'Refunded') c.refunds++;
    if (r.needs_attention) c.attention++;
    if (r.payment_status === 'Successful') paid.push(r);
  }

  const today = istDay(new Date().toISOString());
  const day = {}; const month = {}; const methods = {};
  let totalSales = 0; let todaySales = 0; let todayOrders = 0;
  for (const r of paid) {
    const d = istDay(r.paid_at || r.created_at);
    totalSales += r.total_paise;
    if (d === today) { todaySales += r.total_paise; todayOrders++; }
    day[d] = day[d] || { orders: 0, amount: 0 }; day[d].orders++; day[d].amount += r.total_paise;
    const m = d.slice(0, 7); month[m] = month[m] || { orders: 0, amount: 0 }; month[m].orders++; month[m].amount += r.total_paise;
    const k = r.payment_method || 'unknown'; methods[k] = methods[k] || { orders: 0, amount: 0 }; methods[k].orders++; methods[k].amount += r.total_paise;
  }
  const daily = Object.keys(day).sort().reverse().slice(0, 30).map((d) => ({ day: d, ...day[d] }));
  const monthly = Object.keys(month).sort().reverse().slice(0, 12).map((m) => ({ month: m, ...month[m] }));

  const { data: items, error: ie } = await supa.from('order_items')
    .select('name,qty,line_total_paise,orders!inner(payment_status)').eq('orders.payment_status', 'Successful').limit(20000);
  if (ie) throw ie;
  const best = {};
  for (const i of items || []) { best[i.name] = best[i.name] || { name: i.name, qty: 0, amount: 0 }; best[i.name].qty += i.qty; best[i.name].amount += i.line_total_paise; }
  const bestSellers = Object.values(best).sort((a, b) => b.qty - a.qty).slice(0, 10);

  json(res, 200, {
    counts: c, totalOrders: rows.length, paidOrders: paid.length, totalSales, todaySales, todayOrders,
    daily, monthly, bestSellers, methods: Object.entries(methods).map(([method, v]) => ({ method, ...v }))
  });
} };

A.orders = { method: 'GET', run: async (req, res) => {
  const q = req.query || {};
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  let qb = db().from('orders')
    .select('id,order_no,customer_name,mobile,total_paise,order_status,payment_status,payment_method,created_at,needs_attention', { count: 'exact' });
  qb = applyOrderFilters(qb, q).order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  const { data, count, error } = await qb;
  if (error) throw error;
  json(res, 200, { orders: data || [], total: count || 0, page, limit });
} };

A.order = { method: 'GET', run: async (req, res) => {
  const id = needId((req.query || {}).id);
  const supa = db();
  const { data: o } = await supa.from('orders').select('*').eq('id', id).maybeSingle();
  if (!o) throw new HttpError(404, 'Order not found.');
  const { data: items } = await supa.from('order_items').select('*').eq('order_id', id);
  const { data: payments } = await supa.from('payments').select('*').eq('order_id', id).order('created_at', { ascending: false });
  json(res, 200, { order: o, items: items || [], payments: payments || [] });
} };

A['order-update'] = { method: 'POST', run: async (req, res) => {
  const b = await jsonBody(req);
  const id = needId(b.id);
  const supa = db();
  const { data: o } = await supa.from('orders').select('id,order_status,payment_status').eq('id', id).maybeSingle();
  if (!o) throw new HttpError(404, 'Order not found.');

  const patch = { updated_at: new Date().toISOString() };
  if (b.status) {
    const st = String(b.status);
    if (!FULFIL.includes(st)) throw new HttpError(400, 'That status cannot be set by hand. Paid, cancelled and refund statuses change automatically.');
    if (o.payment_status !== 'Successful') throw new HttpError(409, 'Payment has not been verified, so this order cannot move forward.');
    if (['Cancelled', 'Refund Initiated', 'Refunded'].includes(o.order_status)) throw new HttpError(409, 'This order is ' + o.order_status.toLowerCase() + ' and cannot be changed.');
    patch.order_status = st;
  }
  if (b.tracking && typeof b.tracking === 'object') {
    const url = clean(b.tracking.url, 300);
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, 'Tracking link must start with http:// or https://');
    patch.tracking_carrier = clean(b.tracking.carrier, 60) || null;
    patch.tracking_number = clean(b.tracking.number, 80) || null;
    patch.tracking_url = url || null;
  }
  if (typeof b.notes === 'string') patch.notes = clean(b.notes, 1000) || null;
  if (b.resolve === true) patch.needs_attention = false;

  const { error } = await supa.from('orders').update(patch).eq('id', id);
  if (error) throw error;
  json(res, 200, { ok: true });
} };

A['order-cancel'] = { method: 'POST', run: async (req, res) => {
  const id = needId((await jsonBody(req)).id);
  const supa = db();
  const { data: o } = await supa.from('orders').select('id,order_status,payment_status').eq('id', id).maybeSingle();
  if (!o) throw new HttpError(404, 'Order not found.');
  if (!['Pending', 'Payment Pending', 'Paid', 'Processing'].includes(o.order_status)) {
    throw new HttpError(409, 'An order that is ' + o.order_status.toLowerCase() + ' cannot be cancelled here.');
  }
  const patch = { order_status: 'Cancelled', updated_at: new Date().toISOString() };
  if (o.payment_status === 'Pending') patch.payment_status = 'Cancelled';
  const { error } = await supa.from('orders').update(patch).eq('id', id);
  if (error) throw error;
  await supa.rpc('restore_stock_tx', { p_order_id: id });
  json(res, 200, { ok: true, refundNeeded: o.payment_status === 'Successful' });
} };

A['order-refund'] = { method: 'POST', run: async (req, res) => {
  const b = await jsonBody(req);
  const id = needId(b.id);
  const supa = db();
  const { data: o } = await supa.from('orders').select('id,order_no,order_status,payment_status,total_paise').eq('id', id).maybeSingle();
  if (!o) throw new HttpError(404, 'Order not found.');
  if (o.payment_status !== 'Successful') throw new HttpError(409, 'Only paid orders can be refunded.');
  const { data: pay } = await supa.from('payments').select('id,razorpay_payment_id,refund_id,amount_paise').eq('order_id', id).eq('status', 'Successful').maybeSingle();
  if (!pay || !pay.razorpay_payment_id) throw new HttpError(409, 'No verified payment was found for this order.');
  if (pay.refund_id) throw new HttpError(409, 'A refund was already started for this payment. Check the Razorpay dashboard.');
  const amount = b.amount_paise == null ? o.total_paise : intIn(b.amount_paise, 100, o.total_paise, 'Refund amount');

  let refund;
  try {
    refund = await rzp.api('POST', '/payments/' + pay.razorpay_payment_id + '/refund', { amount, speed: 'normal', notes: { order_no: o.order_no } });
  } catch (e) {
    console.error('Refund failed:', e.message);
    throw new HttpError(502, 'Razorpay could not start the refund: ' + e.message.replace(/^Razorpay \d+: /, ''));
  }
  const now = new Date().toISOString();
  await supa.from('payments').update({ refund_id: refund.id, updated_at: now }).eq('id', pay.id);
  const patch = { updated_at: now };
  if (amount === o.total_paise) patch.order_status = 'Refund Initiated';
  else patch.notes = 'Partial refund of Rs ' + amount / 100 + ' started (' + refund.id + ')';
  await supa.from('orders').update(patch).eq('id', id);
  json(res, 200, { ok: true, refundId: refund.id, status: refund.status });
} };

A.export = { method: 'GET', run: async (req, res) => {
  const supa = db();
  let qb = supa.from('orders').select('*');
  qb = applyOrderFilters(qb, req.query || {}).order('created_at', { ascending: false }).limit(5000);
  const { data: orders, error } = await qb;
  if (error) throw error;

  const itemsBy = {};
  for (let i = 0; i < orders.length; i += 100) {
    const ids = orders.slice(i, i + 100).map((o) => o.id);
    const { data: its } = await supa.from('order_items').select('order_id,name,variant_label,qty').in('order_id', ids);
    for (const it of its || []) (itemsBy[it.order_id] = itemsBy[it.order_id] || []).push(it.qty + ' x ' + it.name + (it.variant_label ? ' (' + it.variant_label + ')' : ''));
  }
  const head = ['Order ID', 'Date (IST)', 'Customer', 'Mobile', 'Email', 'Address', 'City', 'State', 'PIN', 'Items', 'Subtotal (Rs)', 'Shipping (Rs)', 'Discount (Rs)', 'Total (Rs)', 'Payment method', 'Payment reference', 'Payment status', 'Order status', 'Tracking'];
  const lines = [head.map(csvCell).join(',')];
  for (const o of orders) {
    lines.push([
      o.order_no, new Date(new Date(o.created_at).getTime() + 19800000).toISOString().replace('T', ' ').slice(0, 16), o.customer_name, o.mobile, o.email,
      [o.address, o.landmark].filter(Boolean).join(', '), o.city, o.state, o.pincode, (itemsBy[o.id] || []).join('; '),
      o.subtotal_paise / 100, o.shipping_paise / 100, o.discount_paise / 100, o.total_paise / 100,
      o.payment_method, o.payment_ref, o.payment_status, o.order_status, [o.tracking_carrier, o.tracking_number].filter(Boolean).join(' ')
    ].map(csvCell).join(','));
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.end('﻿' + lines.join('\r\n'));
} };

A.products = { method: 'GET', run: async (req, res) => {
  const supa = db();
  const { data: prods, error } = await supa.from('products').select('*').order('archived', { ascending: true }).order('sort_order', { ascending: true });
  if (error) throw error;
  const { data: vars } = await supa.from('product_variants').select('product_id,label,sort_order').order('sort_order', { ascending: true });
  json(res, 200, { products: (prods || []).map((p) => ({ ...p, variants: (vars || []).filter((v) => v.product_id === p.id).map((v) => v.label) })) });
} };

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product'; }

A['product-save'] = { method: 'POST', run: async (req, res) => {
  const b = await jsonBody(req);
  const supa = db();
  const name = clean(b.name, 100);
  const category = clean(b.category, 40);
  if (name.length < 2) throw new HttpError(400, 'Enter a product name.');
  if (category.length < 2) throw new HttpError(400, 'Enter a category.');
  const price = intIn(b.price_paise, 100, 10000000, 'Price');
  let sale = null;
  if (b.sale_price_paise !== null && b.sale_price_paise !== '' && b.sale_price_paise !== undefined) {
    sale = intIn(b.sale_price_paise, 100, 10000000, 'Discounted price');
    if (sale > price) throw new HttpError(400, 'The discounted price cannot be higher than the normal price.');
  }
  const track = !!b.track_stock;
  const stock = intIn(b.stock == null || b.stock === '' ? 0 : b.stock, 0, 100000, 'Stock');
  const image = clean(b.image_url, 500);
  if (image && !/^https:\/\/\S+$/i.test(image)) throw new HttpError(400, 'Image link must start with https://');
  const labels = [...new Set((Array.isArray(b.variants) ? b.variants : []).map((v) => clean(v, 40)).filter(Boolean))].slice(0, 20);

  const row = {
    name, category, description: clean(b.description, 600), price_paise: price, sale_price_paise: sale,
    track_stock: track, stock, image_url: image || null, is_available: !!b.is_available, updated_at: new Date().toISOString()
  };

  let id = b.id ? needId(b.id) : null;
  if (id) {
    const { error } = await supa.from('products').update(row).eq('id', id);
    if (error) throw error;
  } else {
    let slug = slugify(name);
    for (let n = 2; ; n++) {
      const { data: hit } = await supa.from('products').select('id').eq('slug', slug).maybeSingle();
      if (!hit) break;
      slug = slugify(name) + '-' + n;
    }
    const { data: last } = await supa.from('products').select('sort_order').order('sort_order', { ascending: false }).limit(1);
    const { data: made, error } = await supa.from('products').insert({ ...row, slug, sort_order: (last && last[0] ? last[0].sort_order : 0) + 1 }).select('id').single();
    if (error) throw error;
    id = made.id;
  }
  await supa.from('product_variants').delete().eq('product_id', id);
  if (labels.length) {
    const { error } = await supa.from('product_variants').insert(labels.map((label, i) => ({ product_id: id, label, sort_order: i + 1 })));
    if (error) throw error;
  }
  json(res, 200, { ok: true, id });
} };

// Products that were ordered before cannot be deleted (order history needs them), so "delete" = archive.
A['product-archive'] = { method: 'POST', run: async (req, res) => {
  const b = await jsonBody(req);
  const { error } = await db().from('products').update({ archived: !!b.archived, updated_at: new Date().toISOString() }).eq('id', needId(b.id));
  if (error) throw error;
  json(res, 200, { ok: true });
} };

A.upload = { method: 'POST', run: async (req, res) => {
  const b = await jsonBody(req);
  const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const ext = types[String(b.contentType || '')];
  if (!ext) throw new HttpError(400, 'Upload a JPG, PNG or WebP image.');
  const buf = Buffer.from(String(b.dataBase64 || ''), 'base64');
  if (!buf.length || buf.length > 3 * 1024 * 1024) throw new HttpError(400, 'Image must be smaller than 3 MB.');
  const path = 'products/' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  const supa = db();
  const { error } = await supa.storage.from('product-images').upload(path, buf, { contentType: b.contentType, upsert: false });
  if (error) throw new HttpError(502, 'Could not upload the image: ' + error.message);
  const { data } = supa.storage.from('product-images').getPublicUrl(path);
  json(res, 200, { url: data.publicUrl });
} };

A.customers = { method: 'GET', run: async (req, res) => {
  const supa = db();
  const s = String((req.query || {}).q || '').replace(/[^A-Za-z0-9 \-+.@]/g, '').trim().slice(0, 40);
  let qb = supa.from('customers').select('*').order('created_at', { ascending: false }).limit(200);
  if (s) qb = qb.or('name.ilike.%' + s + '%,mobile.ilike.%' + s + '%,email.ilike.%' + s + '%');
  const { data: custs, error } = await qb;
  if (error) throw error;
  const ids = (custs || []).map((c) => c.id);
  const stats = {};
  if (ids.length) {
    const { data: os } = await supa.from('orders').select('customer_id,total_paise,payment_status').in('customer_id', ids);
    for (const o of os || []) {
      const t = stats[o.customer_id] = stats[o.customer_id] || { orders: 0, spent: 0 };
      t.orders++; if (o.payment_status === 'Successful') t.spent += o.total_paise;
    }
  }
  json(res, 200, { customers: (custs || []).map((c) => ({ ...c, orders: (stats[c.id] || {}).orders || 0, spent: (stats[c.id] || {}).spent || 0 })) });
} };

A.customer = { method: 'GET', run: async (req, res) => {
  const id = needId((req.query || {}).id);
  const supa = db();
  const { data: c } = await supa.from('customers').select('*').eq('id', id).maybeSingle();
  if (!c) throw new HttpError(404, 'Customer not found.');
  const { data: orders } = await supa.from('orders').select('id,order_no,total_paise,order_status,payment_status,created_at').eq('customer_id', id).order('created_at', { ascending: false });
  json(res, 200, { customer: c, orders: orders || [] });
} };

A.settings = { method: 'GET', run: async (req, res) => {
  const { data } = await db().from('settings').select('value').eq('key', 'shipping').maybeSingle();
  json(res, 200, { shipping: (data && data.value) || { configured: false, standard_fee_paise: 0, free_threshold_paise: null, state_fees: {} } });
} };

A['settings-save'] = { method: 'POST', run: async (req, res) => {
  const b = await jsonBody(req);
  const standard = intIn(b.standard_fee_paise, 0, 500000, 'Standard shipping fee');
  let free = null;
  if (b.free_threshold_paise !== null && b.free_threshold_paise !== '' && b.free_threshold_paise !== undefined) free = intIn(b.free_threshold_paise, 100, 100000000, 'Free shipping threshold');
  const stateFees = {};
  const raw = b.state_fees && typeof b.state_fees === 'object' ? b.state_fees : {};
  for (const [st, fee] of Object.entries(raw)) {
    if (!STATES.includes(st)) throw new HttpError(400, 'Unknown state: ' + st);
    stateFees[st] = intIn(fee, 0, 500000, 'Fee for ' + st);
  }
  const value = { configured: true, standard_fee_paise: standard, free_threshold_paise: free, state_fees: stateFees };
  const { error } = await db().from('settings').upsert({ key: 'shipping', value, updated_at: new Date().toISOString() });
  if (error) throw error;
  json(res, 200, { ok: true, shipping: value });
} };

// ---------------- router ----------------
module.exports = route(['GET', 'POST'], async (req, res) => {
  const action = String((req.query || {}).action || '');
  if (action === 'login' && req.method === 'POST') return login(req, res);
  if (action === 'refresh' && req.method === 'POST') return refresh(req, res);
  const a = Object.prototype.hasOwnProperty.call(A, action) ? A[action] : null;
  if (!a || a.method !== req.method) throw new HttpError(404, 'Unknown action');
  const user = await requireAdmin(req);
  await a.run(req, res, user);
});
