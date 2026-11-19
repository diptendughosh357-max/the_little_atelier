'use strict';
const { ConfigError } = require('./http');

let client = null;

// Server-side Supabase client using the SERVICE ROLE key. It bypasses RLS, so it must
// only ever run inside these API routes. Never send it to the browser.
function db() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new ConfigError('The shop backend is not set up yet.');
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

// Test hook: lets the test suite plug in a different client.
function setClient(c) { client = c; }

module.exports = { db, setClient };
