'use strict';

const {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} = require('node:crypto');
const pathModule = require('node:path');

const POLICY_VERSION = '1';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REQUIRED_CHECKS = Object.freeze([
  'answer_first',
  'source_support',
  'standalone_passages',
  'title_intent',
  'editorial_quality',
]);
const SNAPSHOT_FIELDS = ['excerpt', 'snapshot', 'content', 'body', 'text'];

function sha256(value) {
  return createHash('sha256').update(toDocumentBuffer(value)).digest('hex');
}

function toDocumentBuffer(document) {
  if (Buffer.isBuffer(document)) return document;
  if (document instanceof Uint8Array) return Buffer.from(document);
  if (typeof document === 'string') return Buffer.from(document, 'utf8');
  throw new TypeError('document must be a string, Buffer, or Uint8Array');
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('path must be a non-empty string');
  const slashPath = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalized = pathModule.posix.normalize(slashPath);
  if (pathModule.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)
      || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError('path must be repository-relative');
  }
  return normalized;
}

function evidencePath(path) {
  const normalized = normalizePath(path);
  return `content-ops/editorial-evidence/${sha256(normalized)}.json`;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('manifest values must be finite JSON numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('manifest values must be JSON-compatible');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseTimestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError(`${field} must be an ISO-8601 timestamp with a timezone`);
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new TypeError(`${field} must be a valid calendar date`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${field} must be an ISO-8601 string`);
  return timestamp;
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks) || checks.length !== REQUIRED_CHECKS.length) {
    throw new TypeError(`checks must contain exactly ${REQUIRED_CHECKS.length} review results`);
  }
  const names = new Set();
  const normalized = checks.map((check, index) => {
    if (!isPlainObject(check)) throw new TypeError(`checks[${index}] must be an object`);
    const { name, status, findings } = check;
    if (!REQUIRED_CHECKS.includes(name)) throw new TypeError(`checks[${index}].name is not a required check`);
    if (names.has(name)) throw new TypeError(`checks contains duplicate result for ${name}`);
    names.add(name);
    if (status !== 'pass') throw new TypeError(`${name} must have status "pass"`);
    if (!Array.isArray(findings)) throw new TypeError(`${name}.findings must be an array`);
    for (const [findingIndex, finding] of findings.entries()) {
      if (!isPlainObject(finding)) throw new TypeError(`${name}.findings[${findingIndex}] must be an object`);
      if (finding.blocking === true || finding.severity === 'error' || finding.severity === 'blocking') {
        throw new TypeError(`${name} contains a blocking finding`);
      }
    }
    return cloneJson(check);
  });
  for (const name of REQUIRED_CHECKS) {
    if (!names.has(name)) throw new TypeError(`checks is missing ${name}`);
  }
  return normalized;
}

function normalizeSources(sources, { addContentHash = false } = {}) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  return sources.map((source, index) => {
    if (!isPlainObject(source)) throw new TypeError(`sources[${index}] must be an object`);
    for (const field of ['url', 'publisher', 'retrievedAt', 'excerpt']) {
      if (typeof source[field] !== 'string' || !source[field].trim()) {
        throw new TypeError(`sources[${index}].${field} must be a non-empty string`);
      }
    }
    try {
      const parsed = new URL(source.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    } catch {
      throw new TypeError(`sources[${index}].url must be an absolute URL`);
    }
    parseTimestamp(source.retrievedAt, `sources[${index}].retrievedAt`);
    const expectedHash = sha256(source.excerpt);
    if (source.contentHash === undefined && !addContentHash) {
      throw new TypeError(`sources[${index}].contentHash must be a SHA-256 hash of excerpt`);
    }
    if (source.contentHash !== undefined && source.contentHash !== expectedHash) {
      throw new TypeError(`sources[${index}].contentHash does not match excerpt`);
    }
    for (const field of SNAPSHOT_FIELDS.slice(1)) {
      if (source[field] !== undefined && typeof source[field] !== 'string') {
        throw new TypeError(`sources[${index}].${field} must be a string`);
      }
    }
    return { ...cloneJson(source), contentHash: expectedHash };
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function keyFromPrivate(value) {
  if (value === null || (typeof value !== 'string' && !Buffer.isBuffer(value) && typeof value !== 'object')) {
    throw new TypeError('privateKey must be a PEM, base64 PKCS8 DER, JWK, or KeyObject');
  }
  let key;
  if (value instanceof KeyObject) key = value;
  else if (typeof value === 'object' && typeof value.kty === 'string') key = createPrivateKey({ key: value, format: 'jwk' });
  else if (typeof value === 'string' && !value.includes('BEGIN')) key = createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  else key = createPrivateKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('privateKey must be an Ed25519 key');
  return key;
}

function keyFromPublic(value) {
  if (value === null || (typeof value !== 'string' && !Buffer.isBuffer(value) && typeof value !== 'object')) {
    throw new TypeError('publicKey must be a PEM, base64 SPKI DER, JWK, or KeyObject');
  }
  let key;
  if (value instanceof KeyObject) key = value.type === 'private' ? createPublicKey(value) : value;
  else if (typeof value === 'object' && typeof value.kty === 'string') key = createPublicKey({ key: value, format: 'jwk' });
  else if (typeof value === 'string' && !value.includes('BEGIN')) key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
  else key = createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('publicKey must be an Ed25519 key');
  return key;
}

function unsignedPayload(manifest) {
  const payload = { ...manifest };
  delete payload.signature;
  return Buffer.from(canonicalJson(payload), 'utf8');
}

function createManifest({ document, path, domain, checks, sources, reviewedAt, model, privateKey }) {
  const normalizedPath = normalizePath(path);
  if (typeof domain !== 'string' || !domain.trim()) throw new TypeError('domain must be a non-empty string');
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('model must be a non-empty string');
  parseTimestamp(reviewedAt, 'reviewedAt');
  const normalizedSources = normalizeSources(sources, { addContentHash: true });
  const manifest = {
    policyVersion: POLICY_VERSION,
    path: normalizedPath,
    domain,
    documentHash: sha256(document),
    checks: normalizeChecks(checks),
    sources: normalizedSources,
    reviewedAt,
    model,
  };
  const signature = sign(null, unsignedPayload(manifest), keyFromPrivate(privateKey)).toString('base64');
  return { ...manifest, signature: { algorithm: 'Ed25519', value: signature } };
}

function verifyManifest({ document, path, domain, manifest, publicKey, now = new Date(), requireFresh = true }) {
  const findings = [];
  const fail = (code, message) => findings.push({ code, message });
  if (!isPlainObject(manifest)) return { pass: false, findings: [{ code: 'malformed_manifest', message: 'manifest must be an object' }] };

  let normalizedPath;
  try {
    normalizedPath = normalizePath(path);
  } catch (error) {
    return { pass: false, findings: [{ code: 'invalid_input', message: error.message }] };
  }
  if (manifest.policyVersion !== POLICY_VERSION) fail('policy_version', `policyVersion must be ${POLICY_VERSION}`);
  if (manifest.path !== normalizedPath) fail('path_mismatch', 'manifest path does not match document path');
  if (manifest.domain !== domain) fail('domain_mismatch', 'manifest domain does not match expected domain');
  try {
    if (manifest.documentHash !== sha256(document)) fail('document_hash', 'document bytes do not match manifest documentHash');
  } catch (error) {
    fail('invalid_input', error.message);
  }
  try {
    normalizeChecks(manifest.checks);
  } catch (error) {
    fail('checks', error.message);
  }
  try {
    normalizeSources(manifest.sources);
  } catch (error) {
    fail('sources', error.message);
  }

  let reviewedTimestamp;
  try {
    reviewedTimestamp = parseTimestamp(manifest.reviewedAt, 'reviewedAt');
    const nowTimestamp = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
    if (!Number.isFinite(nowTimestamp)) throw new TypeError('now must be a Date, timestamp, or ISO-8601 string');
    if (reviewedTimestamp > nowTimestamp) fail('future_review', 'reviewedAt is in the future');
    if (requireFresh && nowTimestamp - reviewedTimestamp > MAX_AGE_MS) {
      fail('stale_review', 'review is older than 7 days');
    }
    for (const [index, source] of (Array.isArray(manifest.sources) ? manifest.sources : []).entries()) {
      const retrievedTimestamp = parseTimestamp(source.retrievedAt, `sources[${index}].retrievedAt`);
      if (retrievedTimestamp > nowTimestamp) fail('future_source', `sources[${index}].retrievedAt is in the future`);
      if (retrievedTimestamp > reviewedTimestamp) fail('source_after_review', `sources[${index}].retrievedAt is later than reviewedAt`);
    }
  } catch (error) {
    fail('timestamp', error.message);
  }
  if (typeof manifest.model !== 'string' || !manifest.model.trim()) fail('model', 'model must be a non-empty string');

  if (!isPlainObject(manifest.signature) || manifest.signature.algorithm !== 'Ed25519' || typeof manifest.signature.value !== 'string') {
    fail('signature_format', 'signature must contain an Ed25519 base64 value');
  } else {
    try {
      const signature = Buffer.from(manifest.signature.value, 'base64');
      if (signature.length !== 64 || signature.toString('base64') !== manifest.signature.value) {
        fail('signature_format', 'signature value is not canonical Ed25519 base64');
      } else if (!verify(null, unsignedPayload(manifest), keyFromPublic(publicKey), signature)) {
        fail('signature_invalid', 'manifest signature is invalid');
      }
    } catch (error) {
      fail('signature_invalid', `manifest signature could not be verified: ${error.message}`);
    }
  }
  return { pass: findings.length === 0, findings };
}

module.exports = {
  POLICY_VERSION,
  REQUIRED_CHECKS,
  createManifest,
  evidencePath,
  verifyManifest,
};
