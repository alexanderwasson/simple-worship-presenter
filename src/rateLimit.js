'use strict';
const config = require('./config');

// In-memory token bucket. Adequate for a single-process self-hosted or hosted
// instance; replace with a shared store when running multiple replicas.
const buckets = new Map();

function keyFor(req, label) {
  return label + '|' + (req.ip || req.socket?.remoteAddress || 'unknown');
}

function consume(req, label, max, windowMs) {
  const key = keyFor(req, label);
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return { allowed: bucket.count <= max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

function limiter({ label = 'default', max, windowMs = config.rateLimitWindowMs, message = 'Too many requests. Please try again shortly.' }) {
  return (req, res, next) => {
    const { allowed, remaining, resetAt } = consume(req, label, max, windowMs);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    if (!allowed) {
      res.setHeader('Retry-After', String(Math.ceil((resetAt - Date.now()) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = {
  limiter,
  authLimiter: () => limiter({ label: 'auth', max: config.rateLimitMaxAuth, message: 'Too many sign-in attempts. Please wait a minute and try again.' }),
  writeLimiter: () => limiter({ label: 'write', max: config.rateLimitMaxWrite })
};
