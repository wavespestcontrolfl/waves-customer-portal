const PRICING_TTL_MS = 10 * 60 * 1000;
const pricingCache = new Map();

function estimateCacheId(estimateOrId) {
  return typeof estimateOrId === 'object' && estimateOrId
    ? estimateOrId.id
    : estimateOrId;
}

function normalizeCachePart(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function estimatePricingCacheKey(estimateOrId) {
  const id = estimateCacheId(estimateOrId);
  if (!id) return null;
  if (!estimateOrId || typeof estimateOrId !== 'object') return String(id);

  const updatedAt = normalizeCachePart(estimateOrId.updated_at || estimateOrId.updatedAt);
  const pricingVersion = normalizeCachePart(estimateOrId.pricing_version || estimateOrId.pricingVersion);
  // GATE_LAWN_V13 changes what a stored bahia lawn replays to (the review reason), so the gate state is
  // part of the key: unsetting the gate takes effect on the next read, not after the 10-minute TTL.
  const lawnV13 = require('../config/feature-gates').lawnV13Live?.() === true ? 'lawn-v13' : '';
  const version = [updatedAt, pricingVersion, lawnV13].filter(Boolean).join('|');
  return version ? `${id}:${version}` : String(id);
}

function cleanupEstimatePricingCache(nowMs = Date.now()) {
  for (const [key, value] of pricingCache.entries()) {
    if (value.expiresAt < nowMs) pricingCache.delete(key);
  }
}

function getEstimatePricingCache(estimateOrId, nowMs = Date.now()) {
  const key = estimatePricingCacheKey(estimateOrId);
  if (!key) return null;
  const cached = pricingCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= nowMs) {
    pricingCache.delete(key);
    return null;
  }
  return cached.payload;
}

function setEstimatePricingCache(estimateOrId, payload, nowMs = Date.now()) {
  const key = estimatePricingCacheKey(estimateOrId);
  if (!key) return;
  pricingCache.set(key, {
    payload,
    expiresAt: nowMs + PRICING_TTL_MS,
  });
}

function clearEstimatePricingCache(estimateId) {
  const id = estimateCacheId(estimateId);
  if (!id) return;
  const exact = String(id);
  const prefix = `${exact}:`;
  for (const key of pricingCache.keys()) {
    if (key === exact || key.startsWith(prefix)) pricingCache.delete(key);
  }
}

function clearAllEstimatePricingCache() {
  pricingCache.clear();
}

module.exports = {
  cleanupEstimatePricingCache,
  clearAllEstimatePricingCache,
  clearEstimatePricingCache,
  estimatePricingCacheKey,
  getEstimatePricingCache,
  setEstimatePricingCache,
};
