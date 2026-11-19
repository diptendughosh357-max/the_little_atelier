'use strict';
const { chromium } = require('playwright'); const path = require('path'); const assert = require('assert');
const URL = 'file://' + path.resolve(__dirname, '../admin.html');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await b.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  let authed = false;
  await page.route('**/api/admin**', async (r) => {
    const u = new globalThis.URL(r.request().url()); const a = u.searchParams.get('action');
    const f = (o, s) => r.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'login') { const body = JSON.parse(r.request().postData()); if (body.password !== 'good') return f({ error: 'Incorrect email or password.' }, 401); authed = true; return f({ access_token: 't', refresh_token: 'r', email: body.email }); }
    if (!authed || r.request().headers().authorization !== 'Bearer t') return f({ error: 'no' }, 401);
    if (a === 'stats') return f({ counts: { awaiting_payment: 1, to_process: 2, processing: 0, shipped: 0, delivered: 0, cancelled: 0, refunds: 0, attention: 1 }, totalOrders: 3, paidOrders: 2, totalSales: 24000, todaySales: 12000, todayOrders: 1, daily: [{ day: '2026-11-19', orders: 1, amount: 12000 }], monthly: [], bestSellers: [{ name: 'Crochet Keychain', qty: 3, amount: 15000 }], methods: [] });
    if (a === 'settings') return f({ shipping: { configured: false, standard_fee_paise: 0, free_threshold_paise: null, state_fees: {} } });
    if (a === 'orders') return f({ orders: [{ id: 'a'.repeat(8) + '-0000-0000-0000-000000000000', order_no: 'TLA-2026-00001', customer_name: '<img src=x onerror=alert(1)>', mobile: '9876543210', total_paise: 9000, order_status: 'Paid', payment_status: 'Successful', payment_method: 'upi', created_at: new Date().toISOString(), needs_attention: false }], total: 1, page: 1, limit: 25 });
    if (a === 'products') return f({ products: [{ id: 'p1', name: 'Crochet Keychain', category: 'Keychains', price_paise: 5000, sale_price_paise: null, track_stock: false, stock: 0, is_available: true, archived: false, image_url: null, variants: [] }] });
    return f({ error: 'x' }, 404);
  });
  await page.goto(URL);
  assert.ok(await page.locator('#loginView').isVisible()); console.log('ok  login shown when signed out');
  await page.fill('#em', 'a@b.com'); await page.fill('#pw', 'bad'); await page.click('#loginBtn');
  await page.locator('#loginMsg').waitFor(); console.log('ok  wrong password rejected');
  await page.fill('#pw', 'good'); await page.click('#loginBtn');
  await page.getByText('Shipping charges are not set').waitFor(); console.log('ok  overview shows shipping warning');
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByText('TLA-2026-00001').waitFor();
  assert.strictEqual(await page.locator('img[src="x"]').count(), 0); console.log('ok  orders list renders; HTML in names is not executed');
  await page.getByRole('button', { name: 'Products' }).click(); await page.getByText('Crochet Keychain').first().waitFor();
  await page.getByRole('button', { name: '+ Add product' }).click(); await page.locator('#p-name').waitFor(); console.log('ok  products + add form');
  await page.setViewportSize({ width: 390, height: 800 });
  await b.close(); assert.deepStrictEqual(errs, [], errs.join()); console.log('admin UI checks passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
