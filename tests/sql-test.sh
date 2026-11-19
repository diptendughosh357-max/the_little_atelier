#!/usr/bin/env bash
# Tests the database functions on a real PostgreSQL server.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres tests/sql-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGHOST="${PGHOST:-/var/tmp/pgtest}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
P="psql -v ON_ERROR_STOP=1 -q -X"

$P -c "drop database if exists tla_test" -c "create database tla_test" >/dev/null 2>&1
P="$P -d tla_test"
$P -c "do \$\$ begin create role anon nologin; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin; exception when duplicate_object then null; end \$\$;"
$P -c "create schema auth; create table auth.users(id uuid primary key default gen_random_uuid(), email text);"
$P -f supabase/schema.sql >/dev/null 2>&1
$P -f supabase/seed.sql

# helper: create an order for a product slug/qty/total and a Razorpay order row
mk() { # slug qty total rzp_order_id mobile
  $P -tA -c "
  with p as (select id, name from products where slug='$1'),
  o as (select create_order_tx(
    jsonb_build_object('name','Test','mobile','$5','email','','address','12 Test Road','landmark','','city','Bandel','state','West Bengal','pincode','712123','instructions','','subtotal',$3,'shipping',0,'discount',0,'total',$3,'coupon','','idempotency_key',''),
    (select jsonb_build_array(jsonb_build_object('product_id',p.id,'name',p.name,'variant','','unit',$3/$2,'qty',$2)) from p)) r)
  insert into payments(order_id, razorpay_order_id, amount_paise)
  select (r->>'id')::uuid, '$4', $3 from o;" >/dev/null
  $P -tA -c "select o.order_no from orders o join payments p on p.order_id=o.id where p.razorpay_order_id='$4'"
}

echo "== 1. order numbers are sequential and in the TLA-YEAR-00001 format"
A=$(mk crochet-claw-hair-clip 2 24000 order_A 9000000001)
B=$(mk crochet-claw-hair-clip 1 12000 order_B 9000000002)
YEAR=$(TZ=Asia/Kolkata date +%Y)
[ "$A" = "TLA-$YEAR-00001" ] && [ "$B" = "TLA-$YEAR-00002" ] && echo "ok: $A, $B" || { echo "FAIL: $A $B"; exit 1; }

echo "== 2. confirm_payment: paid once, duplicate is harmless, stock reduces once"
$P -c "update products set track_stock=true, stock=5 where slug='crochet-claw-hair-clip'"
R1=$($P -tA -c "select confirm_payment('order_A','pay_A',  'upi', 24000, 'signature')->>'result'")
R2=$($P -tA -c "select confirm_payment('order_A','pay_A',  'upi', 24000, 'webhook')->>'result'")
ST=$($P -tA -c "select stock from products where slug='crochet-claw-hair-clip'")
OS=$($P -tA -c "select order_status||'/'||payment_status||'/'||stock_deducted from orders where order_no='$A'")
[ "$R1" = confirmed ] && [ "$R2" = already ] && [ "$ST" = 3 ] && [ "$OS" = "Paid/Successful/true" ] && echo "ok: $R1 then $R2, stock=$ST, $OS" || { echo "FAIL $R1 $R2 $ST $OS"; exit 1; }

echo "== 3. wrong amount is never marked paid"
C=$(mk crochet-keychain 1 5000 order_C 9000000003)
R=$($P -tA -c "select confirm_payment('order_C','pay_C','upi', 100, 'webhook')->>'result'")
OS=$($P -tA -c "select payment_status||'/'||needs_attention from orders where order_no='$C'")
[ "$R" = amount_mismatch ] && [ "$OS" = "Failed/true" ] && echo "ok: $R, $OS" || { echo "FAIL $R $OS"; exit 1; }

echo "== 4. not enough stock: payment is recorded, stock untouched, order flagged"
R=$($P -tA -c "select confirm_payment('order_B','pay_B','upi', 12000, 'signature')->>'result'")   # stock 3, wants 1 -> fine
D=$(mk crochet-claw-hair-clip 4 48000 order_D 9000000004)                                              # wants 4, only 2 left
R4=$($P -tA -c "select confirm_payment('order_D','pay_D','upi', 48000, 'signature')->>'result'")
ST=$($P -tA -c "select stock from products where slug='crochet-claw-hair-clip'")
OS=$($P -tA -c "select payment_status||'/'||stock_deducted||'/'||needs_attention from orders where order_no='$D'")
[ "$ST" = 2 ] && [ "$OS" = "Successful/false/true" ] && echo "ok: stock stays $ST, order $OS" || { echo "FAIL $ST $OS"; exit 1; }

echo "== 5. two simultaneous payments for the LAST item: exactly one gets it, stock never negative"
$P -c "update products set track_stock=true, stock=1 where slug='crochet-keychain'"
E=$(mk crochet-keychain 1 5000 order_E 9000000005)
F=$(mk crochet-keychain 1 5000 order_F 9000000006)
$P -tA -c "select confirm_payment('order_E','pay_E','upi',5000,'webhook')" >/dev/null &
$P -tA -c "select confirm_payment('order_F','pay_F','upi',5000,'webhook')" >/dev/null &
wait
ST=$($P -tA -c "select stock from products where slug='crochet-keychain'")
N=$($P -tA -c "select count(*) from orders where order_no in ('$E','$F') and stock_deducted")
BOTH=$($P -tA -c "select count(*) from orders where order_no in ('$E','$F') and payment_status='Successful'")
[ "$ST" = 0 ] && [ "$N" = 1 ] && [ "$BOTH" = 2 ] && echo "ok: stock=$ST, deducted for $N order, both recorded as paid" || { echo "FAIL $ST $N $BOTH"; exit 1; }

echo "== 6. restore_stock_tx gives stock back once only"
OID=$($P -tA -c "select id from orders where order_no='$A'")
T1=$($P -tA -c "select restore_stock_tx('$OID')")
T2=$($P -tA -c "select restore_stock_tx('$OID')")
ST=$($P -tA -c "select stock from products where slug='crochet-claw-hair-clip'")
[ "$T1" = t ] && [ "$T2" = f ] && [ "$ST" = 4 ] && echo "ok: restored once, stock=$ST" || { echo "FAIL $T1 $T2 $ST"; exit 1; }

echo "== 7. abandoned unpaid orders are cancelled after 24h, paid ones never"
G=$(mk crochet-clutcher 1 10000 order_G 9000000007)
$P -c "update orders set created_at = now() - interval '30 hours' where order_no in ('$G','$A')"
N=$($P -tA -c "select cleanup_abandoned(24)")
GS=$($P -tA -c "select order_status||'/'||payment_status from orders where order_no='$G'")
AS=$($P -tA -c "select order_status||'/'||payment_status from orders where order_no='$A'")
[ "$N" = 1 ] && [ "$GS" = "Cancelled/Cancelled" ] && [ "$AS" = "Paid/Successful" ] && echo "ok: cancelled $N; paid order untouched" || { echo "FAIL $N $GS $AS"; exit 1; }

echo "== 8. late payment on an abandoned (cancelled) order is still recorded and flagged"
R=$($P -tA -c "select confirm_payment('order_G','pay_G','upi',10000,'webhook')->>'result'")
GS=$($P -tA -c "select order_status||'/'||payment_status||'/'||needs_attention from orders where order_no='$G'")
[ "$R" = confirmed ] && [ "$GS" = "Paid/Successful/true" ] && echo "ok: $GS" || { echo "FAIL $R $GS"; exit 1; }

echo "== 9. database rules reject bad data"
if $P -c "update products set sale_price_paise = price_paise + 1 where slug='crochet-keychain'" 2>/dev/null; then echo "FAIL sale price above price accepted"; exit 1; else echo "ok: sale price above price rejected"; fi
if $P -c "update orders set order_status='Teleported' where order_no='$A'" 2>/dev/null; then echo "FAIL bad status accepted"; exit 1; else echo "ok: invalid order status rejected"; fi
if $P -c "insert into payments(order_id, razorpay_order_id, amount_paise) select id,'order_A',1 from orders limit 1" 2>/dev/null; then echo "FAIL duplicate razorpay order accepted"; exit 1; else echo "ok: duplicate Razorpay order id rejected"; fi

echo "== 10. public (anon) key cannot read data or call the payment functions"
$P -c "grant usage on schema public to anon, authenticated; grant select, insert, update, delete on all tables in schema public to anon, authenticated;" >/dev/null
CNT=$($P -tA -c "set role anon; select count(*) from orders" 2>/dev/null || echo 0)
[ "$CNT" = 0 ] && echo "ok: anon sees 0 orders (RLS)" || { echo "FAIL anon sees $CNT orders"; exit 1; }
if $P -c "set role anon; select confirm_payment('order_E','x','upi',5000,'webhook')" 2>/dev/null; then echo "FAIL anon can call confirm_payment"; exit 1; else echo "ok: anon cannot call confirm_payment"; fi
$P -c "set role authenticated; update products set price_paise=1" >/dev/null 2>&1 || true
HACKED=$($P -tA -c "select count(*) from products where price_paise = 1")
[ "$HACKED" = 0 ] && echo "ok: logged-in user cannot change prices (RLS)" || { echo "FAIL prices changed"; exit 1; }

echo
echo "ALL SQL TESTS PASSED"
