'use strict';

const crypto = require('crypto');

// Approval covers every authored entry field. Review metadata records the
// approval rather than forming part of it, and `level` is injected by the
// loader at runtime, so neither belongs in the content fingerprint.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
  return sorted;
}

function approvalContentHash(entry) {
  const content = {};
  for (const [key, value] of Object.entries(entry || {})) {
    if (key !== 'review' && key !== 'level') content[key] = value;
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

function isApproved(entry) {
  const storedHash = entry?.review?.approval_hash;
  return entry?.review?.status === 'owner_approved'
    && Array.isArray(entry.verification)
    && entry.verification.length === 0
    && typeof storedHash === 'string'
    && /^[a-f0-9]{64}$/.test(storedHash)
    && storedHash === approvalContentHash(entry);
}

module.exports = { approvalContentHash, isApproved };
