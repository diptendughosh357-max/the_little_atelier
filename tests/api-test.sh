#!/usr/bin/env bash
# Creates a fresh test database from schema.sql + seed.sql, then runs the API tests.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGHOST="${PGHOST:-/var/tmp/pgtest}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
P="psql -v ON_ERROR_STOP=1 -q -X"
$P -c "drop database if exists tla_api" -c "create database tla_api" >/dev/null 2>&1
$P -d tla_api -c "do \$\$ begin create role anon nologin; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin; exception when duplicate_object then null; end \$\$;"
$P -d tla_api -c "create schema auth; create table auth.users(id uuid primary key default gen_random_uuid(), email text);"
$P -d tla_api -f supabase/schema.sql >/dev/null 2>&1
$P -d tla_api -f supabase/seed.sql
node tests/api.test.js
