'use strict';
const { route, json, jsonBody, rateLimit, HttpError } = require('./_lib/http');
const { db } = require('./_lib/db');
const { validateCustomer, clean } = require('./_lib/validate');
const { unitPrice, couponDiscount, computeTotals } = require('./_lib/pricing');
const rzp = require('./_lib/razorpay');

const MAX_LINES = 20;
const MAX_QTY = 20;

function parseItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'Your cart is empty.');
  if (raw.length > MAX_LINES) throw new HttpError(400, 'Too many items in the cart.');
  const merged = new Map();
  for (const it of raw) {
    const slug = String((it && it.slug) || '');
    const variant = clean(it && it.variant, 40);
    const qty = Number(it && it.qty);
    if (!/^[a-z0-9-]{1,80}$/.test(slug) || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new HttpError(400, 'Something is wrong with an item in your cart. Please refresh and try again.');
    }
    const k = slug + '\u0000' + variant;
    const cur = merged.get(k) || { slug, variant, qty: 0 };
    cur.qty += qty;
    if (cur.qty > MAX_QTY) throw new HttpError(400, 'You can order at most ' + MAX_QTY + ' of one item at a time.');
    merged.set(k, cur);
  }
  return [...merged.values()];
}

module.exports = route(['POST'], async (req, res) => {
  rateLimit(req, 'create-order', 30, 10 * 60 * 1000);
  const body = await jsonBody(req);

  const idemKey = String(body.idempotencyKey || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(idemKey)) throw new HttpError(400, 'Invalid request. Please refresh the page and try again.');
  const customer = validateCustomer(body.customer);
  const items = parseItems(body.items);
  rzp.keys(); // fail early (503) if payments are not configured

  const supa = db();

  // 1. Shipping must be configured by the owner before checkout opens.
  const { data: srow } = await supa.from('settings').select('value').eq('key', 'shipping').maybeSingle();
  const shipping = srow && srow.value;
  if (!shipping || !shipping.configured) {
    throw new HttpError(503, 'Online checkout opens soon. For now, please order on WhatsApp or Instagram.');
  }

  // 2. Load TRUSTED prices and availability from the database. Anything the browser says about price is ignored.
  const slugs = [...new Set(items.map((i) => i.slug))];
  const { data: prods, error: pe } = await supa.from('products')
    .select('id,slug,name,price_paise,sale_price_paise,track_stock,stock,is_available,archived').in('slug', slugs);
  if (pe) throw pe;
  const bySlug = new Map((prods || []).map((p) => [p.slug, p]));
  const { data: vrows, error: ve } = await supa.from('product_variants')
    .select('product_id,label,is_available').in('product_id', (prods || []).map((p) => p.id));
  if (ve) throw ve;

  const lines = [];
  const qtyByProduct = new Map();
  for (const it of items) {
    const p = bySlug.get(it.slug);
    if (!p || p.archived || !p.is_available) throw new HttpError(409, 'Sorry, an item in your cart is no longer available.', { slug: it.slug });
    const opts = (vrows || []).filter((v) => v.product_id === p.id);
    if (opts.length) {
      const hit = opts.find((v) => v.label === it.variant);
      if (!it.variant) throw new HttpError(400, 'Please choose a colour for ' + p.name + '.', { slug: it.slug });
      if (!hit || !hit.is_available) throw new HttpError(409, 'That colour of ' + p.name + ' is not available.', { slug: it.slug });
    } else if (it.variant) {
      throw new HttpError(400, 'Invalid option for ' + p.name + '.', { slug: it.slug });
    }
    qtyByProduct.set(p.id, (qtyByProduct.get(p.id) || 0) + it.qty);
    lines.push({ product_id: p.id, name: p.name, variant: it.variant, unit: unitPrice(p), qty: it.qty });
  }
  for (const p of prods || []) {
    const want = qtyByProduct.get(p.id) || 0;
    if (p.track_stock && want > p.stock) {
      throw new HttpError(409, p.stock > 0 ? 'Only ' + p.stock + ' left of ' + p.name + '.' : p.name + ' is out of stock.', { slug: p.slug });
    }
  }

  // 3. Coupon (optional) and totals, all computed here.
  const subtotal = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  let discount = 0;
  let couponCode = '';
  const rawCoupon = clean(body.coupon, 30).toUpperCase();
  if (rawCoupon) {
    const { data: c } = await supa.from('coupons').select('*').eq('code', rawCoupon).maybeSingle();
    const r = couponDiscount(c, subtotal);
    if (!r.ok) throw new HttpError(400, r.reason, { fields: { coupon: r.reason } });
    discount = r.discount;
    couponCode = rawCoupon;
  }
  const totals = computeTotals({ lines, shipping, state: customer.state, discount });
  if (totals.total < 100) throw new HttpError(400, 'The order total is too low to pay online.');

  // 4. Same checkout submitted twice (double click, retry)? Return the existing order instead of a duplicate.
  let order = await findByKey(supa, idemKey);
  if (!order) {
    const { data: made, error: me } = await supa.rpc('create_order_tx', {
      p_order: {
        name: customer.name, mobile: customer.mobile, email: customer.email, address: customer.address,
        landmark: customer.landmark, city: customer.city, state: customer.state, pincode: customer.pincode,
        instructions: customer.instructions, subtotal: totals.subtotal, shipping: totals.shipping,
        discount: totals.discount, total: totals.total, coupon: couponCode, idempotency_key: idemKey
      },
      p_items: lines
    });
    if (me) {
      if (me.code === '23505') order = await findByKey(supa, idemKey); // a parallel request won the race
      if (!order) throw me;
    } else {
      order = await findByKey(supa, idemKey);
    }
  } else if (order.total_paise !== totals.total) {
    throw new HttpError(409, 'Your order changed. Please review it and try again.', { retry: true });
  }
  if (!order) throw new Error('Order was not saved');

  if (order.payment_status === 'Successful') {
    return json(res, 200, { alreadyPaid: true, orderNo: order.order_no, token: order.public_token });
  }

  // 5. Create (or reuse) the Razorpay order for exactly this amount.
  let rzpOrderId;
  const { data: prev } = await supa.from('payments').select('razorpay_order_id').eq('order_id', order.id)
    .order('created_at', { ascending: false }).limit(1);
  if (prev && prev.length) {
    rzpOrderId = prev[0].razorpay_order_id;
    await supa.from('orders').update({ payment_status: 'Pending', updated_at: new Date().toISOString() })
      .eq('id', order.id).in('payment_status', ['Cancelled', 'Failed']);
  } else {
    try {
      const ro = await rzp.api('POST', '/orders', {
        amount: order.total_paise, currency: 'INR', receipt: order.order_no,
        notes: { order_no: order.order_no }
      });
      rzpOrderId = ro.id;
    } catch (e) {
      console.error('Razorpay order creation failed:', e.message);
      await supa.from('orders').update({ order_status: 'Cancelled', payment_status: 'Failed', notes: 'Could not create Razorpay order', updated_at: new Date().toISOString() }).eq('id', order.id);
      throw new HttpError(502, 'We could not start the payment. Please try again in a moment.');
    }
    const ins = await supa.from('payments').insert({ order_id: order.id, razorpay_order_id: rzpOrderId, amount_paise: order.total_paise });
    if (ins.error) throw ins.error;
  }

  json(res, 200, {
    orderNo: order.order_no,
    token: order.public_token,
    razorpayOrderId: rzpOrderId,
    keyId: process.env.RAZORPAY_KEY_ID, // the public key id is meant to be seen by the browser
    amount: order.total_paise,
    currency: 'INR',
    totals: { subtotal: order.subtotal_paise, shipping: order.shipping_paise, discount: order.discount_paise, total: order.total_paise },
    prefill: { name: order.customer_name, contact: '+91' + order.mobile, email: order.email || '' }
  });
});

async function findByKey(supa, key) {
  const { data } = await supa.from('orders')
    .select('id,order_no,public_token,total_paise,subtotal_paise,shipping_paise,discount_paise,payment_status,customer_name,mobile,email')
    .eq('idempotency_key', key).maybeSingle();
  return data || null;
}
