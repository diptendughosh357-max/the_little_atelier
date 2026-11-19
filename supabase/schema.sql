-- =====================================================================
-- The Little Atelier : database schema
-- Run this whole file once in Supabase > SQL Editor > New query > Run.
-- All money is stored as INTEGER PAISE (Rs 120 = 12000).
-- Safe to re-run: tables use "if not exists"; functions use "or replace".
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- settings (shipping etc.) ----------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Shipping starts UNCONFIGURED on purpose: checkout stays closed until you
-- save your real shipping charges in Admin > Settings.
insert into settings (key, value)
values ('shipping', '{"configured": false, "standard_fee_paise": 0, "free_threshold_paise": null, "state_fees": {}}')
on conflict (key) do nothing;

-- ---------- catalogue ----------
create table if not exists products (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique not null,
  name             text not null,
  description      text not null default '',
  category         text not null,
  price_paise      integer not null check (price_paise >= 0),
  sale_price_paise integer check (sale_price_paise is null or (sale_price_paise >= 0 and sale_price_paise <= price_paise)),
  track_stock      boolean not null default false,   -- false = made to order, no stock limit
  stock            integer not null default 0 check (stock >= 0),
  image_url        text,
  is_available     boolean not null default true,
  archived         boolean not null default false,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists product_variants (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  label        text not null,                       -- e.g. a colour name
  is_available boolean not null default true,
  sort_order   integer not null default 0,
  unique (product_id, label)
);

-- ---------- customers and orders ----------
create table if not exists customers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  mobile     text unique not null,                  -- 10 digits, no country code
  email      text,
  created_at timestamptz not null default now()
);

create table if not exists order_counters (
  year    integer primary key,
  last_no integer not null default 0
);

create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  order_no         text unique not null,            -- TLA-2026-00001
  customer_id      uuid references customers(id),
  customer_name    text not null,
  mobile           text not null,
  email            text,
  address          text not null,
  landmark         text,
  city             text not null,
  state            text not null,
  pincode          text not null,
  instructions     text,
  subtotal_paise   integer not null check (subtotal_paise >= 0),
  shipping_paise   integer not null check (shipping_paise >= 0),
  discount_paise   integer not null default 0 check (discount_paise >= 0),
  total_paise      integer not null check (total_paise >= 100),
  coupon_code      text,
  order_status     text not null default 'Payment Pending'
    check (order_status in ('Pending','Payment Pending','Paid','Processing','Shipped','Out for Delivery','Delivered','Cancelled','Refund Initiated','Refunded')),
  payment_status   text not null default 'Pending'
    check (payment_status in ('Pending','Successful','Failed','Cancelled','Refunded')),
  payment_method   text,
  payment_ref      text,                            -- Razorpay payment id
  tracking_carrier text,
  tracking_number  text,
  tracking_url     text,
  public_token     text unique not null,            -- secret used in the customer's private order link
  idempotency_key  text unique,
  stock_deducted   boolean not null default false,
  needs_attention  boolean not null default false,
  notes            text,                            -- internal, never shown to customers
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  paid_at          timestamptz
);

create table if not exists order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references orders(id) on delete cascade,
  product_id       uuid not null references products(id),
  name             text not null,
  variant_label    text,
  unit_price_paise integer not null check (unit_price_paise >= 0),
  qty              integer not null check (qty > 0),
  line_total_paise integer not null check (line_total_paise >= 0)
);

create table if not exists payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete cascade,
  razorpay_order_id   text unique not null,
  razorpay_payment_id text unique,
  method              text,
  status              text not null default 'Pending'
    check (status in ('Pending','Successful','Failed','Cancelled','Refunded')),
  amount_paise        integer not null,
  verified_via        text,                         -- 'signature' or 'webhook'
  refund_id           text,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists webhook_events (
  event_id    text primary key,
  event       text,
  received_at timestamptz not null default now()
);

create table if not exists coupons (
  code       text primary key,                      -- store in UPPER CASE
  kind       text not null check (kind in ('percent','flat')),
  value      integer not null check (value > 0),    -- percent (1-100) or paise
  min_paise  integer not null default 0,
  max_uses   integer,
  used_count integer not null default 0,
  expires_at timestamptz,
  active     boolean not null default true
);

create table if not exists admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- ---------- indexes ----------
create index if not exists idx_orders_created   on orders (created_at desc);
create index if not exists idx_orders_mobile    on orders (mobile);
create index if not exists idx_orders_ostatus   on orders (order_status);
create index if not exists idx_orders_pstatus   on orders (payment_status);
create index if not exists idx_orders_customer  on orders (customer_id);
create index if not exists idx_items_order      on order_items (order_id);
create index if not exists idx_items_product    on order_items (product_id);
create index if not exists idx_payments_order   on payments (order_id);
create index if not exists idx_products_cat     on products (category);
create index if not exists idx_variants_product on product_variants (product_id);

-- ---------- Row Level Security ----------
-- RLS is ON for every table and there are NO policies. That means the public
-- (anon) key and logged-in users cannot read or write anything directly.
-- Only the server (service role key, kept in Vercel) can touch data.
alter table settings         enable row level security;
alter table products         enable row level security;
alter table product_variants enable row level security;
alter table customers        enable row level security;
alter table order_counters   enable row level security;
alter table orders           enable row level security;
alter table order_items      enable row level security;
alter table payments         enable row level security;
alter table webhook_events   enable row level security;
alter table coupons          enable row level security;
alter table admin_users      enable row level security;

-- ---------- functions ----------
create or replace function next_order_no() returns text
language plpgsql as $$
declare
  y int := extract(year from (now() at time zone 'Asia/Kolkata'))::int;
  n int;
begin
  insert into order_counters (year, last_no) values (y, 1)
  on conflict (year) do update set last_no = order_counters.last_no + 1
  returning last_no into n;
  return 'TLA-' || y || '-' || lpad(n::text, 5, '0');
end $$;

-- Creates customer + order + items in ONE transaction. Prices come from the
-- server (which read them from the products table), never from the browser.
create or replace function create_order_tx(p_order jsonb, p_items jsonb) returns jsonb
language plpgsql as $$
declare
  cid uuid; oid uuid; ono text; tok text;
begin
  insert into customers (name, mobile, email)
  values (p_order->>'name', p_order->>'mobile', nullif(p_order->>'email', ''))
  on conflict (mobile) do update
    set name = excluded.name, email = coalesce(excluded.email, customers.email)
  returning id into cid;

  ono := next_order_no();
  tok := encode(gen_random_bytes(16), 'hex');

  insert into orders (
    order_no, customer_id, customer_name, mobile, email, address, landmark, city, state, pincode,
    instructions, subtotal_paise, shipping_paise, discount_paise, total_paise, coupon_code,
    public_token, idempotency_key
  ) values (
    ono, cid, p_order->>'name', p_order->>'mobile', nullif(p_order->>'email', ''),
    p_order->>'address', nullif(p_order->>'landmark', ''), p_order->>'city', p_order->>'state',
    p_order->>'pincode', nullif(p_order->>'instructions', ''),
    (p_order->>'subtotal')::int, (p_order->>'shipping')::int, (p_order->>'discount')::int,
    (p_order->>'total')::int, nullif(p_order->>'coupon', ''), tok, nullif(p_order->>'idempotency_key', '')
  ) returning id into oid;

  insert into order_items (order_id, product_id, name, variant_label, unit_price_paise, qty, line_total_paise)
  select oid, (i->>'product_id')::uuid, i->>'name', nullif(i->>'variant', ''),
         (i->>'unit')::int, (i->>'qty')::int, (i->>'unit')::int * (i->>'qty')::int
  from jsonb_array_elements(p_items) i;

  return jsonb_build_object('id', oid, 'order_no', ono, 'token', tok);
end $$;

-- Marks an order paid. SAFE TO CALL MANY TIMES (duplicate webhooks, double clicks).
-- Row locks make stock reduction safe when two orders pay at the same moment.
create or replace function confirm_payment(
  p_razorpay_order_id text, p_payment_id text, p_method text, p_amount int, p_source text
) returns jsonb
language plpgsql as $$
declare
  pay payments%rowtype;
  ord orders%rowtype;
  ok boolean;
  deducted boolean := false;
  attention boolean := false;
  note text := null;
begin
  select * into pay from payments where razorpay_order_id = p_razorpay_order_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into ord from orders where id = pay.order_id for update;

  if ord.payment_status = 'Successful' or ord.payment_status = 'Refunded' then
    return jsonb_build_object('result', 'already', 'order_no', ord.order_no);
  end if;

  if p_amount <> ord.total_paise then
    update payments set status = 'Failed', razorpay_payment_id = coalesce(razorpay_payment_id, p_payment_id),
           error = 'Amount mismatch: paid ' || p_amount || ' expected ' || ord.total_paise, updated_at = now()
    where id = pay.id;
    update orders set needs_attention = true, payment_status = 'Failed',
           notes = coalesce(notes || E'\n', '') || 'Amount mismatch on payment ' || p_payment_id,
           updated_at = now()
    where id = ord.id;
    return jsonb_build_object('result', 'amount_mismatch', 'order_no', ord.order_no);
  end if;

  -- lock the product rows in a fixed order (prevents deadlocks), then check stock
  perform 1 from products
    where id in (select product_id from order_items where order_id = ord.id)
    order by id for update;

  select coalesce(bool_and(p.stock >= q.qty or not p.track_stock), true) into ok
  from (select product_id, sum(qty)::int as qty from order_items where order_id = ord.id group by product_id) q
  join products p on p.id = q.product_id;

  if ok then
    update products p set stock = p.stock - q.qty, updated_at = now()
    from (select product_id, sum(qty)::int as qty from order_items where order_id = ord.id group by product_id) q
    where p.id = q.product_id and p.track_stock;
    deducted := true;
  else
    attention := true;
    note := 'Payment received but stock was not enough. Contact the customer or refund.';
  end if;

  if ord.order_status = 'Cancelled' then
    attention := true;
    note := coalesce(note || ' ', '') || 'Payment arrived after the order was cancelled.';
  end if;

  update payments set status = 'Successful', razorpay_payment_id = p_payment_id, method = p_method,
         verified_via = p_source, error = null, updated_at = now()
  where id = pay.id;

  update orders set
    payment_status = 'Successful',
    order_status = case when order_status in ('Pending','Payment Pending','Cancelled') then 'Paid' else order_status end,
    payment_method = p_method,
    payment_ref = p_payment_id,
    paid_at = now(),
    stock_deducted = deducted,
    needs_attention = attention,
    notes = case when note is null then notes else coalesce(notes || E'\n', '') || note end,
    updated_at = now()
  where id = ord.id;

  if ord.coupon_code is not null then
    update coupons set used_count = used_count + 1 where code = ord.coupon_code;
  end if;

  return jsonb_build_object('result', 'confirmed', 'order_no', ord.order_no, 'needs_attention', attention);
end $$;

-- Puts stock back when a paid order is cancelled. Safe to call twice.
create or replace function restore_stock_tx(p_order_id uuid) returns boolean
language plpgsql as $$
declare ord orders%rowtype;
begin
  select * into ord from orders where id = p_order_id for update;
  if not found or not ord.stock_deducted then
    return false;
  end if;
  update products p set stock = p.stock + q.qty, updated_at = now()
  from (select product_id, sum(qty)::int as qty from order_items where order_id = ord.id group by product_id) q
  where p.id = q.product_id and p.track_stock;
  update orders set stock_deducted = false, updated_at = now() where id = ord.id;
  return true;
end $$;

-- Abandoned checkouts: unpaid orders older than p_hours are cancelled.
-- Stock is only reduced when payment is confirmed, so nothing needs releasing.
create or replace function cleanup_abandoned(p_hours int default 24) returns int
language plpgsql as $$
declare n int;
begin
  with c as (
    update orders set
      order_status = 'Cancelled',
      payment_status = case when payment_status = 'Pending' then 'Cancelled' else payment_status end,
      updated_at = now()
    where payment_status in ('Pending', 'Failed', 'Cancelled')
      and order_status in ('Pending', 'Payment Pending')
      and created_at < now() - make_interval(hours => p_hours)
    returning 1
  )
  select count(*) into n from c;
  return n;
end $$;

-- These functions are for the server only. Block the public API from calling them.
revoke all on function next_order_no()                                  from public, anon, authenticated;
revoke all on function create_order_tx(jsonb, jsonb)                    from public, anon, authenticated;
revoke all on function confirm_payment(text, text, text, int, text)     from public, anon, authenticated;
revoke all on function restore_stock_tx(uuid)                           from public, anon, authenticated;
revoke all on function cleanup_abandoned(int)                           from public, anon, authenticated;

-- ---------- product photo storage (Supabase only; skipped elsewhere) ----------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('product-images', 'product-images', true)
    on conflict (id) do nothing;
  end if;
end $$;
