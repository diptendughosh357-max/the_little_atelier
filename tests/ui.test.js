'use strict';
// Browser test: loads index.html, mocks /api/* and Razorpay, checks cart + checkout flow.
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');
const URL = 'file://' + path.resolve(__dirname, '../index.html');
const prods = require('fs').readFileSync(path.resolve(__dirname, '../supabase/seed.sql'), 'utf8');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = []; let n = 0; const ok = (m) => { n++; console.log('ok  ' + m); };
  for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 800 }]) {
    const ctx = await b.newContext({ viewport: vp });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    let created = 0, verified = 0, paid = false;
    await page.route('**/api/**', async (route) => {
      const u = new URL_(route.request().url());
      const f = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (u.pathname === '/api/products') return f({ error: 'x' }, 500);
      return f({ error: 'x' }, 500);
    });
    await page.goto(URL);
    // offline / unconfigured: catalogue works, checkout falls back
    assert.strictEqual(await page.locator('.product-card').count(), 8); ok(vp.width + ' 8 products render');
    await page.locator('.product-card', { hasText: 'Crochet Keychain' }).getByRole('button', { name: 'Add to cart' }).click();
    assert.strictEqual(await page.locator('#cartCount').textContent(), '1'); ok(vp.width + ' add to cart updates badge');
    await page.reload();
    assert.strictEqual(await page.locator('#cartCount').textContent(), '1'); ok(vp.width + ' cart persists after refresh');
    await page.goto(URL + '#cart');
    assert.ok(await page.locator('.cart-line').count() === 1);
    await page.getByLabel('Increase quantity of Crochet Keychain').click();
    assert.ok((await page.locator('.cart-line-total').textContent()).includes('100')); ok(vp.width + ' qty change = ₹100');
    await page.goto(URL + '#checkout');
    assert.ok(await page.getByText('Online checkout is opening soon').count() === 1); ok(vp.width + ' checkout falls back to chat when API is down');
    await page.goto(URL + '#cart');
    await page.getByRole('button', { name: 'Remove' }).click();
    assert.ok(await page.getByText('Your cart is empty').count() === 1); ok(vp.width + ' remove works');
    // overflow check
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(sw <= 1, 'horizontal overflow ' + sw); ok(vp.width + ' no horizontal overflow');
    await ctx.close();
  }
  // Live flow
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  let createBody = null, verifyCalled = 0, orderPaid = false, rzpOpts = null;
  const order = () => ({ orderNo: 'TLA-2026-00001', createdAt: new Date().toISOString(), paidAt: orderPaid ? new Date().toISOString() : null, customerName: 'Asha Roy',
    paymentStatus: orderPaid ? 'Successful' : 'Pending', orderStatus: orderPaid ? 'Paid' : 'Pending Payment', paymentMethod: 'upi', paymentRef: 'pay_123',
    items: [{ name: 'Crochet Keychain', variant: '', qty: 1, total: 5000 }], totals: { subtotal: 5000, discount: 0, shipping: 4000, total: 9000 },
    address: { line: '12 Station Road', landmark: '', city: 'Bandel', state: 'West Bengal', pincode: '712123' }, tracking: null });
  await page.route('**/api/**', async (route) => {
    const u = new URL_(route.request().url()); const f = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.pathname === '/api/products') return f({ products: ['crochet-keychain'].map((s) => ({ slug: s, name: 'Crochet Keychain', category: 'Keychains', price_paise: 5000, sale_price_paise: null, available: true, stock: null, variants: [], image_url: null, description: 'd' })), shipping: { configured: true, standard_fee_paise: 4000, free_threshold_paise: null, state_fees: {} } });
    if (u.pathname === '/api/create-order') { createBody = JSON.parse(route.request().postData()); await new Promise((r) => setTimeout(r, 300));
      return f({ keyId: 'rzp_test_x', razorpayOrderId: 'order_1', amount: 9000, currency: 'INR', orderNo: 'TLA-2026-00001', token: 'a'.repeat(32), totals: { subtotal: 5000, discount: 0, shipping: 4000, total: 9000 }, prefill: { name: 'Asha Roy', contact: '9876543210', email: '' } }); }
    if (u.pathname === '/api/verify-payment') { verifyCalled++; orderPaid = true; return f({ status: 'paid' }); }
    if (u.pathname === '/api/order-details') return f(order());
    if (u.pathname === '/api/cancel-payment') return f({ ok: true });
    return f({ error: 'x' }, 404);
  });
  await page.route('**/checkout.razorpay.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body:
    'window.Razorpay=function(o){window.__rzp=o;this.open=function(){window.__opened=(window.__opened||0)+1};this.on=function(){}}' }));
  await page.goto(URL);
  await page.locator('.product-card', { hasText: 'Crochet Keychain' }).getByRole('button', { name: 'Add to cart' }).click();
  await page.locator('#cartBtn').click();
  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  await page.getByRole('button', { name: /Pay .* securely/ }).click();
  assert.ok((await page.locator('#err-mobile').textContent()).length > 0); ok('validation blocks empty form');
  await page.fill('#name', 'Asha Roy'); await page.fill('#mobile', '12345'); await page.fill('#address', '12 Station Road, Bandel'); await page.fill('#city', 'Bandel');
  await page.selectOption('#state', 'West Bengal'); await page.fill('#pincode', '012345');
  await page.getByRole('button', { name: /Pay .* securely/ }).click();
  assert.ok((await page.locator('#err-mobile').textContent()) && (await page.locator('#err-pincode').textContent())); ok('bad mobile + PIN rejected');
  await page.fill('#mobile', '98765 43210'); await page.fill('#pincode', '712123');
  await page.getByRole('button', { name: /Pay .* securely/ }).dblclick();   // double click
  await page.waitForFunction(() => window.__opened >= 1, null, {timeout:5000}).catch(async (e) => { console.log('MSG:', await page.locator('#payMsg').textContent(), '| btn:', await page.locator('#payBtn').textContent(), '| err', await page.locator('.err:not(:empty)').allTextContents()); throw e; });
  assert.strictEqual(createBody.items[0].qty, 1);
  assert.ok(!JSON.stringify(createBody).includes('price')); ok('create-order sent once, no prices from browser');
  assert.strictEqual(await page.evaluate(() => window.__opened), 1); ok('double-click opens payment once');
  assert.ok(!page.url().includes('order=')); ok('no success page before payment');
  await page.evaluate(() => window.__rzp.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_123', razorpay_signature: 'sig' }));
  await page.waitForSelector('text=Your payment is confirmed');
  assert.strictEqual(verifyCalled, 1); ok('success shown only after verify-payment says paid');
  assert.strictEqual(await page.locator('#cartCount').textContent(), '0'); ok('cart cleared after paid');
  await page.goto(URL + '#track');
  await page.fill('#t-order', 'TLA-2026-00001'); await page.fill('#t-mobile', '9876543210'); await page.getByRole('button', { name: 'Check status' }).click();
  await page.locator('#trackView').getByText('Order progress').waitFor(); ok('tracking page finds order');
  await ctx.close(); await b.close();
  assert.deepStrictEqual(errors, [], errors.join('\n'));
  console.log('\n' + n + ' UI checks passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
function URL_(s) { return new globalThis.URL(s); }
