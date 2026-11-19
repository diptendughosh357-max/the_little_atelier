'use strict';
const { route, json } = require('./_lib/http');
const { db } = require('./_lib/db');
const { couponDiscount } = require('./_lib/pricing');

// GET /api/products           -> live catalogue (prices, availability, shipping settings)
// GET /api/products?coupon=X&subtotal=N -> preview of a coupon (display only; create-order re-checks it)
module.exports = route(['GET'], async (req, res) => {
  const supa = db();
  const q = req.query || {};

  if (q.coupon) {
    const code = String(q.coupon).trim().toUpperCase().slice(0, 30);
    const sub = Math.max(0, parseInt(q.subtotal, 10) || 0);
    const { data } = await supa.from('coupons').select('*').eq('code', code).maybeSingle();
    const r = couponDiscount(data, sub);
    return json(res, 200, { valid: r.ok, discount_paise: r.discount, message: r.ok ? 'Coupon applied' : r.reason });
  }

  const { data: prods, error } = await supa.from('products')
    .select('id,slug,name,description,category,price_paise,sale_price_paise,track_stock,stock,image_url,is_available,sort_order')
    .eq('archived', false).order('sort_order', { ascending: true });
  if (error) throw error;

  const ids = (prods || []).map((p) => p.id);
  let vars = [];
  if (ids.length) {
    const r = await supa.from('product_variants').select('product_id,label,is_available,sort_order').in('product_id', ids).order('sort_order', { ascending: true });
    if (r.error) throw r.error;
    vars = r.data || [];
  }

  const { data: s } = await supa.from('settings').select('value').eq('key', 'shipping').maybeSingle();
  const sh = (s && s.value) || {};

  const products = (prods || []).map((p) => {
    const all = vars.filter((v) => v.product_id === p.id);
    const open = all.filter((v) => v.is_available).map((v) => v.label);
    const inStock = !p.track_stock || p.stock > 0;
    const variantsOk = all.length === 0 || open.length > 0;
    return {
      slug: p.slug, name: p.name, description: p.description, category: p.category,
      price_paise: p.price_paise, sale_price_paise: p.sale_price_paise,
      stock: p.track_stock ? p.stock : null,
      image_url: p.image_url || null,
      available: !!(p.is_available && inStock && variantsOk),
      variants: open
    };
  });

  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
  json(res, 200, {
    products,
    shipping: {
      configured: !!sh.configured,
      standard_fee_paise: sh.standard_fee_paise || 0,
      free_threshold_paise: sh.free_threshold_paise == null ? null : sh.free_threshold_paise,
      state_fees: sh.state_fees || {}
    }
  });
});
