'use strict';
/**
 * Extra ad-platform match keys beyond email/phone: first/last name, city,
 * state, ZIP, country and our own customer id (Meta external_id). Pure
 * normalization + source-picking helpers shared by all four upload lanes
 * (Meta CAPI, Google Data Manager conversions, Meta Custom Audiences, Google
 * Customer Match). Hashing stays in each lane (they hash with their own
 * sha256Hex) — this module only produces the NORMALIZED plaintext.
 *
 * Rules verified against the official docs (checked 2026-09-29):
 *   Meta CAPI customer information parameters — fn/ln: lowercase, no
 *   punctuation; ct: lowercase, no punctuation/special chars/spaces; st: 2-char
 *   ANSI lowercase; zp: first 5 digits, no spaces/dash; country: lowercase
 *   ISO 3166-1 alpha-2; external_id: any unique advertiser id. All hashed.
 *   https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
 *   Meta Custom Audience multi-key schema (FN, LN, ZIP, CT, ST, COUNTRY,
 *   EXTERN_ID) — same rules; DELETE /users matches multi-key rows by ALL keys.
 *   https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences
 *   Google Data Manager AddressInfo — givenName/familyName lowercase, no
 *   punctuation, no honorific prefix / generational suffix, SHA-256; regionCode
 *   (ISO alpha-2) and postalCode NOT hashed; all four fields mandatory.
 *   https://developers.google.com/data-manager/api/devguides/concepts/formatting
 *   https://developers.google.com/data-manager/api/reference/rest/v1/UserData
 */

const US_STATES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', districtofcolumbia: 'dc', florida: 'fl', georgia: 'ga',
  hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks',
  kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma',
  michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt',
  nebraska: 'ne', nevada: 'nv', newhampshire: 'nh', newjersey: 'nj', newmexico: 'nm',
  newyork: 'ny', northcarolina: 'nc', northdakota: 'nd', ohio: 'oh', oklahoma: 'ok',
  oregon: 'or', pennsylvania: 'pa', rhodeisland: 'ri', southcarolina: 'sc', southdakota: 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  westvirginia: 'wv', wisconsin: 'wi', wyoming: 'wy', puertorico: 'pr',
};
const US_STATE_CODES = new Set(Object.values(US_STATES));

// Placeholder values CRM rows carry when the name was never captured.
const PLACEHOLDER_NAMES = new Set(['unknown', 'n/a', 'na', 'none', 'null', 'undefined', 'caller', 'guest']);

const TITLE_PREFIX = /^(?:(?:mr|mrs|ms|miss|mx|dr|prof)\.?\s+)+/i;
const NAME_SUFFIX = /(?:[\s,]+(?:jr|sr|ii|iii|iv|phd|md|esq|dds)\.?)+$/i;

// Lowercase, no punctuation (apostrophes/hyphens dropped), interior spaces
// collapsed; honorific prefix (first names) / generational suffix (last
// names) removed per Google's rule. null when nothing usable is left.
function normalizeName(value, kind = 'first') {
  let s = String(value == null ? '' : value).trim();
  if (!s || PLACEHOLDER_NAMES.has(s.toLowerCase())) return null;
  s = kind === 'last' ? s.replace(NAME_SUFFIX, '') : s.replace(TITLE_PREFIX, '');
  s = s.normalize('NFC').toLowerCase().replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim();
  return s || null;
}

// Letters only: no punctuation, special characters or spaces (Meta ct rule).
function normalizeCity(value) {
  const s = String(value == null ? '' : value).normalize('NFC').toLowerCase().replace(/[^\p{L}]/gu, '');
  return s || null;
}

// 2-letter ANSI code, lowercase; accepts the full state name too.
function normalizeState(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return null;
  if (/^[a-z]{2}$/.test(raw)) return US_STATE_CODES.has(raw) ? raw : null;
  return US_STATES[raw.replace(/[^a-z]/g, '')] || null;
}

// First 5 digits of a US ZIP (ZIP+4 truncated); anything else is not a US ZIP.
function normalizeZip(value) {
  const m = String(value == null ? '' : value).match(/(?:^|\D)(\d{5})(?:[-\s]?\d{4})?(?:\D|$)/);
  return m ? m[1] : null;
}

function normalizeExternalId(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s || null;
}

// A single full-name field ("John Smith" in first_name, no last name) splits at
// the last space; otherwise first/last pass through.
function splitName(first, last) {
  const f = first == null ? '' : String(first).trim();
  const l = last == null ? '' : String(last).trim();
  if (!l && /\s/.test(f)) {
    const i = f.lastIndexOf(' ');
    return { first: f.slice(0, i).trim(), last: f.slice(i + 1).trim() };
  }
  return { first: f, last: l };
}

// Normalized plaintext identity for one person: { fn, ln, ct, st, zp } (each
// null when absent/unusable). Country is derived by callers (always US here).
function normalizeIdentity(src) {
  const s = src || {};
  const n = splitName(s.firstName, s.lastName);
  return {
    fn: normalizeName(n.first, 'first'),
    ln: normalizeName(n.last, 'last'),
    ct: normalizeCity(s.city),
    st: normalizeState(s.state),
    zp: normalizeZip(s.zip),
  };
}

// Pick ONE coherent name / address from two sources (preferred first) instead
// of mixing fields person-by-person: a full first+last pair wins; the address
// block comes from whichever source has a valid ZIP, and city/state are only
// borrowed from the other source when its ZIP is the same or absent.
function pickName(a, b) {
  const na = splitName(a && a.firstName, a && a.lastName);
  const nb = splitName(b && b.firstName, b && b.lastName);
  const full = (n) => !!(normalizeName(n.first, 'first') && normalizeName(n.last, 'last'));
  if (full(na)) return na;
  if (full(nb)) return nb;
  return (normalizeName(na.first) || normalizeName(na.last, 'last')) ? na : nb;
}
function pickAddress(a = {}, b = {}) {
  const za = normalizeZip(a.zip);
  const zb = normalizeZip(b.zip);
  const base = za || !zb ? a : b;
  const other = base === a ? b : a;
  const zOther = base === a ? zb : za;
  const compatible = !zOther || zOther === normalizeZip(base.zip);
  return {
    zip: base.zip || null,
    city: base.city || (compatible ? other.city : null) || null,
    state: base.state || (compatible ? other.state : null) || null,
  };
}
function mergeIdentity(preferred, fallback) {
  const name = pickName(preferred, fallback);
  const addr = pickAddress(preferred || {}, fallback || {});
  return { firstName: name.first || null, lastName: name.last || null, city: addr.city, state: addr.state, zip: addr.zip };
}

// Google AddressInfo needs ALL of givenName, familyName, regionCode and
// postalCode; names are SHA-256 hashed (by the caller's `hash`), regionCode and
// postalCode are sent as-is. null unless both names and a 5-digit ZIP exist.
// Shared by both Google lanes (conversions + Customer Match) so they format
// identically.
function googleAddressParts(src, hash) {
  const id = normalizeIdentity(src);
  if (!id.fn || !id.ln || !id.zp) return null;
  return { givenName: hash(id.fn), familyName: hash(id.ln), regionCode: 'US', postalCode: id.zp };
}

// Field names a candidate/member carries for these keys — consent code nulls
// exactly this list next to email/phone.
const IDENTITY_FIELDS = ['firstName', 'lastName', 'city', 'state', 'zip', 'externalId'];
function nullIdentityFields() {
  const out = {};
  for (const f of IDENTITY_FIELDS) out[f] = null;
  return out;
}

// Our stable per-person id: the customer id when known (one person stays the
// same across a Lead and every later Purchase/audience row), else a
// lead-scoped id.
function externalIdFor({ customerId, leadId }) {
  if (customerId) return String(customerId);
  if (leadId) return `lead:${leadId}`;
  return null;
}

// ── audience state helpers ──────────────────────────────────────────
// A persisted audience entry is { k, d:[emailHash, phoneHash], c?, e?, o? }.
// d is the row IDENTITY, unchanged, so rows uploaded before extras existed keep
// matching. `e` is the LATEST hashed extras uploaded with the row; `o` is a
// small bounded list (newest first) of EARLIER variants that were also
// uploaded. Every variant that ever went up must stay known: removal has to
// delete each one (Meta matches a multi-key DELETE by all keys) and the
// shared-handle guards must see them, even after the source fields change or
// disappear. Variants leave state only with the entry, once removal is confirmed.
const EXTRA_ORDER = ['fn', 'ln', 'zp', 'ct', 'st', 'co', 'xid'];
const MAX_OLDER_VARIANTS = 4;
function extrasSig(e) {
  return e ? EXTRA_ORDER.map((k) => e[k] || '').join('|') : '';
}
// Every extras variant uploaded for this entry, newest first.
function entryVariants(entry) {
  return [entry.e, ...(Array.isArray(entry.o) ? entry.o : [])].filter(Boolean);
}
// The entry to persist for a member that was uploaded before: the current
// identity with `e` = latest extras (the freshly computed ones, or — when the
// source fields shrank/vanished so there is nothing new to send — the
// previously uploaded ones) and `o` = every other variant still out there.
function carryVariants(before, current) {
  const prior = entryVariants(before);
  if (!prior.length) return current;
  const out = { ...current };
  let older;
  // Nothing new to say (source fields vanished or shrank, e.g. only the id is
  // left): keep what was uploaded, send nothing.
  const subsetOfLatest = current.e && Object.keys(current.e).every((k) => current.e[k] === prior[0][k]);
  if (current.e && !subsetOfLatest) {
    const sig = extrasSig(current.e);
    older = prior.filter((v) => extrasSig(v) !== sig);
  } else {
    out.e = prior[0];
    older = prior.slice(1);
  }
  older = older.slice(0, MAX_OLDER_VARIANTS);
  if (older.length) out.o = older; else delete out.o;
  return out;
}
// Every key an audience DELETE for this entry could match on, across all
// uploaded variants. Removal must never knock out a current member that
// shares any of them.
function entryHandles(entry) {
  const out = [];
  if (entry.d[0]) out.push(entry.d[0]);
  if (entry.d[1]) out.push(entry.d[1]);
  for (const e of entryVariants(entry)) {
    if (e.xid) out.push(`x:${e.xid}`);
    if (e.fn && e.ln && e.zp) out.push(`n:${e.fn}|${e.ln}|${e.zp}`);
  }
  return out;
}

module.exports = {
  normalizeName,
  normalizeCity,
  normalizeState,
  normalizeZip,
  normalizeExternalId,
  splitName,
  normalizeIdentity,
  googleAddressParts,
  mergeIdentity,
  externalIdFor,
  IDENTITY_FIELDS,
  nullIdentityFields,
  extrasSig,
  entryVariants,
  carryVariants,
  entryHandles,
};
