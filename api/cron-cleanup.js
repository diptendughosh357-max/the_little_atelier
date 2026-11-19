'use strict';
const { route, json, HttpError, ConfigError } = require('./_lib/http');
const { db } = require('./_lib/db');
const { safeEqual } = require('./_lib/razorpay');

// Runs once a day (see vercel.json). Cancels checkouts that were never paid for 24 hours.
// Stock is only reduced when payment succeeds, so there is nothing to release.
module.exports = route(['GET', 'POST'], async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new ConfigError('CRON_SECRET is not set.');
  const auth = String(req.headers.authorization || '');
  if (!safeEqual(auth, 'Bearer ' + secret)) throw new HttpError(401, 'Unauthorized');
  const { data, error } = await db().rpc('cleanup_abandoned', { p_hours: 24 });
  if (error) throw error;
  json(res, 200, { cancelled: data });
});
