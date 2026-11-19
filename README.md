# The Little Atelier: shop setup guide

What you have: the same website, now with cart, checkout, Razorpay payment (UPI, cards, net banking), order tracking and an admin page at `/admin`.
Nothing works for real money until you finish the steps below. No keys are inside this project.

## Files
- `index.html` the shop (your design, plus cart/checkout/order/track pages)
- `admin.html` admin page (`yourdomain/admin`)
- `api/` server code (Vercel functions). `vercel.json` settings.
- `supabase/schema.sql`, `supabase/seed.sql` database and your 8 products
- `.env.example` list of secret settings (names only)
- `tests/` automatic tests (`npm test`)

## Step 1. Razorpay (payments)
1. Sign up at razorpay.com. Finish KYC (PAN, bank account, business details). Live payments stay off until Razorpay approves you.
2. Start in **Test Mode**. Dashboard > Account & Settings > API Keys > Generate. Save the Key ID (`rzp_test_...`) and Key Secret. The secret is shown once.
3. Make sure UPI is enabled under Payment Methods. If you want a QR code on desktop, check that UPI QR is enabled for your account (ask Razorpay support if it is missing).
4. Webhook (do this after Step 4 gives you a web address): Developer Controls > Webhooks > Add.
   - URL: `https://YOURDOMAIN/api/razorpay-webhook`
   - Secret: make up a long random text. Keep it for Step 4.
   - Events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`

## Step 2. Supabase (database)
1. Create a project at supabase.com (free plan is fine to start).
2. SQL Editor: paste and run `supabase/schema.sql`, then `supabase/seed.sql`.
3. Project Settings > API: copy the Project URL, the `anon` key and the `service_role` key. The service_role key is a master key. Never put it in any page or share it.
4. Create your admin login: Authentication > Users > Add user (your email + a strong password). Then in SQL Editor run:
   `insert into admin_users(user_id,email) select id,email from auth.users where email = 'YOUR EMAIL';`

## Step 3. Put the project on GitHub
Upload this folder (not `node_modules`, not any `.env` file) to a private GitHub repo.

## Step 4. Vercel (hosting)
1. vercel.com > Add New Project > import the repo. No build command needed.
2. Settings > Environment Variables. Add these (see `.env.example`):
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `CRON_SECRET` (any long random text)
3. Deploy. Then do the webhook in Step 1.4 with your real address.

## Step 5. First setup in the admin page
1. Open `/admin` and sign in.
2. **Shipping tab: save your charges.** Until you do, checkout stays closed on purpose. I did not guess any delivery rates. Enter 0 if delivery is free.
3. Products tab: check prices. Stock tracking is OFF (items are made to order). Turn it on per product if you keep stock.

## Step 6. Test before going live (Test Mode)
- Place an order. In the Razorpay popup use test UPI id `success@razorpay` (success) and `failure@razorpay` (failure). Test card details are in Razorpay docs.
- Check: order appears in Admin > Orders as Paid; the confirmation page shows only after payment is verified; refund works from the order page.
- Test on a real phone with a UPI app, and by opening your site from an Instagram link (in-app browsers behave differently).
- Check the webhook shows "delivered" in Razorpay > Webhooks.

## Step 7. Go live
Generate **Live** keys in Razorpay (after approval). Replace the two Razorpay values in Vercel, create a live webhook with its own secret, update `RAZORPAY_WEBHOOK_SECRET`, redeploy.

## How it protects you
- Prices and totals are always recalculated on the server from the database. Changing the page in a browser cannot lower a price.
- An order becomes Paid only after the server verifies Razorpay's signature and checks the payment with Razorpay. Reaching the success page proves nothing.
- Double clicks and page refreshes do not create duplicate orders.
- Order lookup needs the order ID plus the customer's mobile number or private link. An order ID alone shows nothing.
- Unpaid orders are cancelled automatically after 24 hours. Stock (if tracked) is reduced only on verified payment.

## What was NOT tested with real services (please test)
I had no Razorpay or Supabase accounts, so I tested with a real PostgreSQL database and simulated Razorpay/Supabase Auth. Real-world checks still needed:
- real UPI app/QR behaviour, and returning from the UPI app inside Instagram or other in-app browsers (no redirect fallback built)
- Supabase image upload, and the admin search filters on a real Supabase project
- the rate limiter is basic (resets when the server restarts)

## Not built yet (you chose core first)
Wishlist, customer accounts, email/SMS messages, SMS OTP tracking, coupon management screen (coupons work but are added in the Supabase table editor), product reviews.

## Known trade-offs
- Product photos are embedded inside `index.html` (about 800 KB). Fine now, but move them to files or the admin uploader as the catalogue grows.
- "Delete product" is Archive, because past orders need the product record.
