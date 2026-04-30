// In-memory per-user TTL cache for GET responses.
//
// The dashboard fans out 11 concurrent fetches on every mount and the
// underlying queries (revenue, AR aging, MRR trend, attribution panels)
// don't change minute-to-minute. Without a cache, repeated mounts on
// flaky mobile connections both hammered the DB and burned through the
// per-user rate-limit bucket — users saw HTTP 429 with no recovery path.
//
// Usage:
//   const { cacheRoute } = require('../utils/route-cache');
//   router.get('/aging', cacheRoute(60), async (req, res, next) => { ... });
//
// Keying is per-user-per-URL. Tech 7's /aging is a different bucket than
// Tech 9's /aging, but the same user hitting the same URL twice in 60s
// gets the cached body.

const buckets = new Map();

function userKey(req) {
  if (req.technicianId) return `tech:${req.technicianId}`;
  if (req.customerId) return `cust:${req.customerId}`;
  return `ip:${req.ip || 'unknown'}`;
}

function cacheRoute(ttlSeconds) {
  const ttlMs = Math.max(1, ttlSeconds) * 1000;
  return function (req, res, next) {
    if (req.method !== 'GET') return next();
    const key = `${userKey(req)}::${req.originalUrl}`;
    const hit = buckets.get(key);
    const now = Date.now();
    if (hit && hit.expires > now) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(hit.status).json(hit.body);
    }
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        buckets.set(key, { body, status: res.statusCode, expires: now + ttlMs });
      }
      res.setHeader('X-Cache', 'MISS');
      return origJson(body);
    };
    next();
  };
}

// Periodic sweep so a long-running process doesn't accumulate stale
// entries forever. Runs every 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.expires <= now) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

module.exports = { cacheRoute };
