'use strict';
// Small helpers shared by every API route.

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
class ConfigError extends Error {}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

// Wraps a route: checks the HTTP method, catches errors, hides internals from the browser.
function route(methods, fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        throw new HttpError(405, 'Method not allowed');
      }
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, Object.assign({ error: e.message }, e.extra || {}));
      if (e instanceof ConfigError) return json(res, 503, { error: e.message });
      console.error('API error:', e && e.stack ? e.stack : e);
      return json(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  };
}

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 6 * 1024 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Raw request text (needed to verify webhook signatures byte for byte).
async function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return readStream(req);
}

// Parsed JSON body as a plain object.
async function jsonBody(req) {
  let b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b !== 'string') b = await readStream(req);
  if (!b) return {};
  try {
    const parsed = JSON.parse(b);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) { /* fall through */ }
  throw new HttpError(400, 'Invalid request body');
}

// Best-effort limiter. On serverless each instance has its own memory, so this slows
// down casual guessing but is not a hard guarantee. Supabase/Razorpay add their own limits.
const buckets = new Map();
function rateLimit(req, name, max, windowMs) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
  const key = name + ':' + ip;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n += 1;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  if (b.n > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

module.exports = { HttpError, ConfigError, json, route, rawBody, jsonBody, rateLimit };
