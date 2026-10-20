/**
 * Rules for the Intelligence Bar's general admin edit (owner ruling
 * 2026-10-12: "a general EDIT tool is allowed for a reviewed allow-list of
 * small internal edits only ... Owner login only, ALWAYS a confirm card, its
 * own gate. NEVER on the list: customer messages, money, deletes, bulk
 * changes, settings/users/credentials. Any address text = a card anyway").
 * Shared by the catalog generator (scripts/build-ib-admin-write-catalog.js)
 * and the runtime tools (services/intelligence-bar/admin-write-tools.js), so
 * a route is judged by one definition at build time and again at call time.
 *
 * Pure functions, no I/O. Everything fails closed.
 */
const readRules = require('./admin-read-rules');

// Only a column update. POST creates (and often sends), DELETE deletes.
const EDIT_METHODS = Object.freeze(['PUT', 'PATCH']);

// Words in a path that put it outside the edit list for good. Matched against
// the words inside each segment, like the read rules. A reviewer cannot
// override these; a route with one of them is not editable from the bar.
const DENIED_WORDS = new Set([
  // deletes and bulk changes
  'delete', 'deletes', 'remove', 'removes', 'destroy', 'purge', 'void', 'voids', 'cancel', 'cancels', 'merge', 'merges',
  'bulk', 'batch', 'all', 'reorder', 'import', 'sync',
  // anything that sends or queues a message
  'send', 'sends', 'resend', 'reply', 'broadcast', 'blast', 'notify', 'enqueue', 'queue', 'schedule-send',
  'campaign', 'campaigns', 'newsletter', 'drafts',
  // money
  'invoice', 'invoices', 'payment', 'payments', 'pay', 'charge', 'charges', 'refund', 'refunds', 'credit', 'credits',
  'price', 'prices', 'pricing', 'amount', 'amounts', 'rate', 'rates', 'discount', 'discounts', 'billing', 'bill',
  'subscription', 'subscriptions', 'payout', 'payouts', 'tax', 'estimate', 'estimates', 'quote', 'quotes', 'catalog',
  'autopay', 'stripe', 'wallet',
  // settings, users and credentials
  'settings', 'setting', 'config', 'configuration', 'users', 'user', 'roles', 'role', 'permissions', 'permission',
  'technicians', 'technician', 'staff', 'password', 'passwords', 'secret', 'secrets', 'token', 'tokens',
  'credential', 'credentials', 'keys', 'key-rotation', 'gates', 'flags', 'feature-flags',
  // state machines that send or close things
  'approve', 'reject', 'publish', 'unpublish', 'activate', 'deactivate', 'status', 'resolve', 'dismiss', 'assign',
]);

// A literal word list is not enough for names run together ("autopay-state"),
// so the whole segment is also tested against this pattern.
const DENIED_SEGMENT_RE = /(invoice|payment|refund|credit|discount|pricing|payout|stripe|autopay|password|credential|secret|unsubscribe|opt-?out|sms-send|email-send|bulk|batch)/i;

function segmentWords(segment) {
  const spaced = String(segment).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const words = spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const compact = String(segment).toLowerCase();
  return compact.includes('-') || compact.includes('_') ? [...words, compact] : words;
}

// Why a method and path pattern is outside the edit catalog, or null. Reuses
// the read rules first (credential and identity paths, tokens, webhooks,
// sessions, files, streams, action verbs, not a plain admin path).
function editDenyReason(method, pattern) {
  if (!EDIT_METHODS.includes(String(method || '').toUpperCase())) return 'method_not_edit';
  const base = readRules.denyReason(pattern);
  if (base) return base;
  for (const segment of readRules.splitPath(pattern)) {
    if (readRules.isParam(segment)) continue;
    if (segmentWords(segment).some(word => DENIED_WORDS.has(word)) || DENIED_SEGMENT_RE.test(segment)) return 'denied_edit_path';
  }
  return null;
}

// Handler-chain signals that keep a route out of the edit list. The scan is
// the same one the read catalog runs; the HARD signals can never be waived.
//   outside:* / outside_service:*  a call that leaves this server or reaches a
//        messaging, payment, provider or alerting module (the scan names a
//        service file that matches twilio / sendgrid / stripe / sms-service /
//        notify / bell / admin-alert ...)
//   signed_url:* / credential_link:*  a link that carries its own credential,
//        or a customer-facing pay / portal / estimate / unsubscribe link
//   writes_process_state / response:* / no_json_response  not a JSON column update
//   write:*  anything except update / insert / transaction / onConflict /
//        increment / decrement (a delete, truncate, DDL, file write, raw SQL
//        write, upsert helper or bulk insert)
const HARD_WRITE_SIGNAL_RE = /^(outside|outside_service:|signed_url|credential_link:|writes_process_state|response:|no_json_response)/;
const ALLOWED_WRITE_SIGNALS = new Set(['write:update', 'write:insert', 'write:transaction', 'write:onConflict', 'write:increment', 'write:decrement']);

// effect_call:<name> signals whose name reaches a sender, a charge, a delete
// or an outside lookup. A reviewer may waive one only by naming it in the
// row's `waive` map with a reason (the call was read and sends nothing).
const EFFECT_DENY_RE = /(send|sms|text|email|mail|notif|push|message|queue|enqueue|charge|refund|pay|invoice|price|credit|discount|delete|remove|destroy|void|cancel|merge|sync|geocode|publish|dispatch|broadcast|alert|bell|emit|stripe|twilio|sendgrid|autopay|bill)/i;

// Tables a chain may not write: money, messages and queues. Template tables
// are the edit list (editing a template is not sending).
const DENIED_TABLE_RE = /(invoice|payment|charge|refund|credit|price|pricing|discount|ledger|outbox|queue|autopay|stripe|billing|conversation|sms_log|scheduled_sms|scheduled_email|email_messages|push_|^messages?$|wallet|payout)/i;

// Why a scanned signal keeps a row out: returns the reason, or null when the
// signal is acceptable (or waived with a reason).
function signalProblem(signal, waive = {}) {
  if (HARD_WRITE_SIGNAL_RE.test(signal)) return `hard signal ${signal}`;
  if (signal.startsWith('write:')) return ALLOWED_WRITE_SIGNALS.has(signal) ? null : `write kind ${signal}`;
  const waived = typeof waive[signal] === 'string' && waive[signal].trim().length >= 20;
  if (signal.startsWith('credential_field:') || signal.startsWith('credential_table:')) {
    // A credential NAME in the code (a column read, a field referenced) is not
    // a message or a charge; the bar never returns the response body of an
    // edit. credential_table is allowed; credential_field must be waived.
    return signal.startsWith('credential_table:') || waived ? null : `credential field ${signal} needs a waiver with a reason`;
  }
  if (signal.startsWith('effect_call:')) {
    const name = signal.slice('effect_call:'.length);
    return EFFECT_DENY_RE.test(name) && !waived ? `effect call ${name} needs a waiver with a reason` : null;
  }
  return `unknown signal ${signal}`;
}

// ── address-looking body keys ───────────────────────────────────────────

const ADDRESS_WORDS = new Set(['address', 'addr', 'street', 'city', 'zip', 'zipcode', 'postal', 'postcode', 'county', 'latitude', 'longitude', 'lat', 'lng', 'lon', 'geocode', 'geo', 'parcel', 'neighborhood']);
function bodyKeyLooksLikeAddress(key) {
  const spaced = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const words = spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some(word => ADDRESS_WORDS.has(word)) || /^(state|unit|apt|suite)$/i.test(String(key));
}

// ── body validation against a reviewed allow-list ───────────────────────

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_STRING = 5000;
const MAX_JSON_CHARS = 20000;
const BODY_TYPES = new Set(['string', 'boolean', 'integer', 'number', 'datetime', 'array', 'object']);

function jsonLength(value) {
  try { return JSON.stringify(value).length; } catch { return Infinity; }
}

// One value against its spec: each type has its own checker, returning
// { value } (normalized) or { error }.
function checkString(spec, value, fail) {
  if (typeof value !== 'string') return fail('must be text');
  if (CONTROL_RE.test(value)) return fail('has a control character');
  const text = spec.trim === false ? value : value.trim();
  const max = Math.min(Number.isInteger(spec.maxLength) ? spec.maxLength : 500, MAX_STRING);
  if (text.length > max) return fail(`is longer than ${max} characters`);
  if (spec.minLength && text.length < spec.minLength) return fail(`must be at least ${spec.minLength} characters`);
  if (Array.isArray(spec.enum) && !spec.enum.includes(text)) return fail(`must be one of: ${spec.enum.join(', ')}`);
  return { value: text };
}

function checkBoolean(spec, value, fail) {
  return typeof value === 'boolean' ? { value } : fail('must be true or false');
}

function checkNumber(spec, value, fail) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail('must be a number');
  if (spec.type === 'integer' && !Number.isInteger(value)) return fail('must be a whole number');
  if (typeof spec.min === 'number' && value < spec.min) return fail(`must be at least ${spec.min}`);
  if (typeof spec.max === 'number' && value > spec.max) return fail(`must be at most ${spec.max}`);
  return { value };
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
function checkDatetime(spec, value, fail) {
  if (typeof value !== 'string' || !DATETIME_RE.test(value)) return fail('must be an ISO date-time with a zone, like 2026-10-12T14:30:00-04:00');
  return Number.isNaN(Date.parse(value)) ? fail('is not a real date-time') : { value };
}

function checkContainer(spec, value, fail) {
  const isArray = Array.isArray(value);
  if (value === null || typeof value !== 'object' || isArray !== (spec.type === 'array')) return fail(spec.type === 'array' ? 'must be a list' : 'must be an object');
  if (isArray && Number.isInteger(spec.maxItems) && value.length > spec.maxItems) return fail(`has more than ${spec.maxItems} items`);
  if (jsonLength(value) > Math.min(Number.isInteger(spec.maxJson) ? spec.maxJson : MAX_JSON_CHARS, MAX_JSON_CHARS)) return fail('is too large');
  return { value: JSON.parse(JSON.stringify(value)) };
}

const VALUE_CHECKERS = {
  string: checkString, boolean: checkBoolean, integer: checkNumber, number: checkNumber, datetime: checkDatetime, array: checkContainer, object: checkContainer,
};

function checkValue(key, spec, value) {
  const fail = message => ({ error: `${key}: ${message}` });
  if (spec.nullable === true && value === null) return { value: null };
  const check = VALUE_CHECKERS[spec.type];
  return check ? check(spec, value, fail) : fail('has an unsupported type in the reviewed row');
}

// Validates a request body against a reviewed row's allow-list. A key the row
// does not list is REFUSED, never dropped (the card shows what the call asked
// for, and a dropped key would be an effect the operator never approved).
// `row.body` maps key -> spec; `row.required` lists keys that must be present.
function validateBody(row, body) {
  const specs = row.body && typeof row.body === 'object' ? row.body : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object of the fields to change' };
  const keys = Object.keys(body);
  if (!keys.length) return { error: 'body is empty: give at least one field to change' };
  const extra = keys.filter(key => !Object.hasOwn(specs, key));
  if (extra.length) {
    return { error: `Field(s) not allowed for this endpoint: ${extra.slice(0, 6).join(', ')}. Allowed: ${Object.keys(specs).join(', ')}.`, allowed: Object.keys(specs) };
  }
  const missing = (row.required || []).filter(key => body[key] === undefined);
  if (missing.length) return { error: `Missing required field(s): ${missing.join(', ')}` };
  const out = {};
  for (const key of keys) {
    if (!KEY_RE.test(key)) return { error: `Field name not allowed: ${key.slice(0, 40)}` };
    if (body[key] === undefined) continue;
    const checked = checkValue(key, specs[key], body[key]);
    if (checked.error) return { error: checked.error };
    out[key] = checked.value;
  }
  return { body: out };
}

// A row's own body spec must be well formed (the generator fails the build).
function bodySpecProblem(row) {
  const specs = row.body;
  if (!specs || typeof specs !== 'object' || Array.isArray(specs) || !Object.keys(specs).length) return 'body must list the allowed fields';
  for (const [key, spec] of Object.entries(specs)) {
    if (!KEY_RE.test(key)) return `body.${key} is not a valid field name`;
    if (!spec || typeof spec !== 'object' || !BODY_TYPES.has(spec.type)) return `body.${key}.type must be one of ${[...BODY_TYPES].join(', ')}`;
    if (spec.type === 'string' && (!Number.isInteger(spec.maxLength) || spec.maxLength < 1 || spec.maxLength > MAX_STRING)) return `body.${key}.maxLength must be set (1 to ${MAX_STRING})`;
    if ((spec.type === 'array' && !Number.isInteger(spec.maxItems))) return `body.${key}.maxItems must be set`;
  }
  const required = row.required === undefined ? [] : row.required;
  if (!Array.isArray(required) || required.some(key => !Object.hasOwn(specs, key))) return 'required must name allowed body fields';
  return null;
}

module.exports = {
  EDIT_METHODS, DENIED_WORDS, DENIED_TABLE_RE, EFFECT_DENY_RE, HARD_WRITE_SIGNAL_RE, ALLOWED_WRITE_SIGNALS,
  editDenyReason, signalProblem, bodyKeyLooksLikeAddress, validateBody, bodySpecProblem,
};
