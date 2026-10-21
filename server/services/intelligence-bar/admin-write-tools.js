/**
 * Intelligence Bar — general admin edit, batch 1 (owner ruling 2026-10-12:
 * "a general EDIT tool is allowed for a reviewed allow-list of small internal
 * edits only ... Owner login only, ALWAYS a confirm card, its own gate. NEVER
 * on the list: customer messages, money, deletes, bulk changes,
 * settings/users/credentials. Any address text = a card anyway").
 *
 *   find_admin_edits   searches the catalog of reviewed edits by words.
 *   propose_admin_edit validates one edit against its reviewed row, shows the
 *                      current values when a reviewed read supplies them, and
 *                      mints a confirm card. Confirm replays the PUT or PATCH.
 *
 * The catalog (admin-write-catalog.json) is a HAND-REVIEWED list, built by
 * scripts/build-ib-admin-write-catalog.js from admin-write-reviewed.json (a
 * row per endpoint, fingerprinted to the handler chain: the scan signals, the
 * tables written and a hash of every followed function). It is the allow-list:
 * the model passes a catalog method and pattern, the path parameter values and
 * the body fields; never a URL. A body field the row does not list is REFUSED
 * (never dropped). The deny rules (utils/admin-write-rules.js) run again at
 * call time on top of the catalog: only PUT or PATCH, and no delete, bulk,
 * send, money, settings, user or credential word in the path.
 *
 * The edit is a loopback PUT or PATCH to this same server with the
 * Authorization header of the request that runs the bar, so every router
 * middleware (auth, MFA, token version, technician scope, the handler's own
 * validation and locks) applies exactly as it does for the screen. The token
 * travels only on the server-built action context (`staffAuthorization`, set by
 * the route from the authenticated request); it is never read from model input,
 * logged, returned, or stored in a task, checkpoint, pending action or
 * telemetry row. The response body of the edit is never returned (a handler
 * can echo a whole record): the result is a receipt with the endpoint, the
 * record ids and the field names.
 *
 *   unconfirmed -> a PREVIEW: nothing is changed. `_version` pins the reviewed
 *                  row's digest, the filled path, the exact body, the customer
 *                  binding and the current values the card showed.
 *   confirmed   -> rebuilds the plan from the stored input and refuses with
 *                  preview_changed unless it still equals the approved pin
 *                  (`_approved_edit_pin`, set by the route from the card's own
 *                  preview), so a changed row, handler digest, body or record
 *                  is a new card. Then it sends exactly the carded body.
 *
 * Dark behind GATE_IB_GENERAL_EDIT (ibGeneralEditLive, read at call time; needs
 * GATE_IB_PLATFORM, which has the owner-only access model) and owner-login only
 * (ibFullAccess, carried as actionContext.fullAccess). Never owner-direct.
 */
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../logger');
const readRules = require('../../utils/admin-read-rules');
const writeRules = require('../../utils/admin-write-rules');
const { ADMIN_READ_HEADER, adminReadMarkerValue } = require('../../utils/redact-request-url');
const { newState, redactString, redactSecrets } = require('../../utils/signed-link-redaction');
const { wordsOf, stem, STOPWORDS } = require('./admin-read-tools');
const Snapshots = require('./admin-write-snapshots');
const catalog = require('./admin-write-catalog.json');

const LOOPBACK_HOST = '127.0.0.1';
const WRITE_TIMEOUT_MS = 15000;
const MAX_MATCHES = 10;
const CARD_VALUE_CHARS = 300;
const BEARER_RE = /^Bearer [A-Za-z0-9._~+/=-]{10,4000}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADMIN_EDIT_FIND_TOOL = 'find_admin_edits';
const ADMIN_EDIT_PROPOSE_TOOL = 'propose_admin_edit';

const ENTRIES = Object.freeze(catalog.entries.map(entry => Object.freeze({ ...entry })));
const BY_KEY = new Map(ENTRIES.map(entry => [`${entry.method} ${entry.endpoint}`, entry]));
const BLOCKED_ROUTES = Object.freeze([...catalog.blockedRoutes]);
const REVIEWED_COUNT = ENTRIES.length;

const ADMIN_WRITE_TOOLS = [
  {
    name: ADMIN_EDIT_FIND_TOOL,
    description: `Find the reviewed admin edit for a small internal change no purpose-built tool makes: a template's wording, a timesheet entry, a visit note, a customer's text and report preferences, a product-use note. Searches a short, hand-reviewed list of the admin portal's edits (${REVIEWED_COUNT} today; it grows only when a person reviews another) by words and returns up to 10 entries: the method, the exact endpoint pattern, its parameter names, the body fields the edit may carry (type and size) and what the edit does not do. It changes nothing. An edit that is not on the list cannot be made this way: never a customer message, money, price, delete, bulk change, setting, user or credential. Purpose-built tools come first. Then call propose_admin_edit with the exact method and pattern.
Use for: "which edit changes X", before any propose_admin_edit call.`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words for the change wanted, e.g. "sms template wording", "time entry", "visit note".' },
      },
      required: ['query'],
    },
  },
  {
    name: ADMIN_EDIT_PROPOSE_TOOL,
    description: `Propose ONE reviewed admin edit as a confirm card. Nothing is changed until the operator confirms the card. Call find_admin_edits first and pass the method and endpoint pattern unchanged; give each :name in "params" (a record id, letters, digits, dot, dash, underscore; never a slash or a URL; a parameter the finder lists in text_params may hold spaces and punctuation) and the fields to change in "body", using only the fields find_admin_edits lists for that endpoint; any other field is refused. An edit on a customer's record or a visit also needs "customer_id" (the finder says so). The card shows the record, each field's current value when the screen can supply it, and the new value; the operator approves exactly that body. Address text always shows an ADDRESS CHANGE card. Never a customer message, money, price, delete or bulk change: say so and point the operator to the right screen. Owner login only.`,
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['PUT', 'PATCH'], description: 'The method find_admin_edits listed for this endpoint.' },
        endpoint: { type: 'string', maxLength: 200, description: 'The exact endpoint pattern from find_admin_edits, with :name placeholders. Never a URL.' },
        params: {
          type: 'object', description: 'A value for each :name in the endpoint pattern, e.g. { "id": "<uuid>" }.',
          additionalProperties: { type: 'string', maxLength: 120 },
        },
        body: { type: 'object', description: 'The fields to change, only those find_admin_edits lists for this endpoint.' },
        customer_id: { type: 'string', format: 'uuid', description: 'The customer the record belongs to, when find_admin_edits says the endpoint is customer or visit scoped.' },
      },
      required: ['method', 'endpoint', 'body'],
    },
    _sideEffects: true,
  },
];

function adminWriteLive() {
  return require('../../config/feature-gates').ibGeneralEditLive() === true;
}

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const textParams = entry => Object.entries(entry.paramKinds || {}).filter(([, kind]) => kind === 'text').map(([name]) => name);
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
};
const digestOf = value => crypto.createHash('sha256').update(stable(value)).digest('hex').slice(0, 32);

// ── find_admin_edits ─────────────────────────────────────────────────────

const SEARCH_STOPWORDS = new Set([...STOPWORDS, 'edit', 'change', 'update', 'set', 'make', 'put', 'patch', 'save', 'fix', 'correct']);

const SEARCH_INDEX = ENTRIES.map((entry) => {
  const pathWords = new Set(readRules.splitPath(entry.endpoint).filter(s => !readRules.isParam(s)).flatMap(wordsOf).map(stem));
  const otherWords = new Set([...entry.screens, ...entry.handlers, entry.label, ...Object.keys(entry.body)].flatMap(wordsOf).map(stem));
  return { entry, pathWords, otherWords };
});

function scoreEntry({ pathWords, otherWords }, terms) {
  let score = 0;
  for (const term of terms) {
    if (pathWords.has(term)) score += 3;
    else if (otherWords.has(term)) score += 2;
    else if (term.length >= 4 && [...pathWords, ...otherWords].some(word => word.startsWith(term) || (term.startsWith(word) && word.length >= 4))) score += 1;
  }
  return score;
}

function fieldSummary(entry) {
  return Object.entries(entry.body).map(([name, spec]) => ({
    name, type: spec.type,
    ...(spec.maxLength ? { max_length: spec.maxLength } : {}),
    ...(spec.enum ? { one_of: spec.enum } : {}),
    ...(entry.required.includes(name) ? { required: true } : {}),
  }));
}

function findAdminEdits(input) {
  const query = typeof input?.query === 'string' ? input.query : '';
  const terms = [...new Set(wordsOf(query).filter(word => !SEARCH_STOPWORDS.has(word)).map(stem))];
  const ranked = terms.length ? SEARCH_INDEX
    .map(item => ({ entry: item.entry, score: scoreEntry(item, terms) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.endpoint.length - b.entry.endpoint.length || a.entry.endpoint.localeCompare(b.entry.endpoint))
    : [];
  const matches = ranked.slice(0, MAX_MATCHES).map(({ entry }) => ({
    method: entry.method, endpoint: entry.endpoint, params: entry.params, label: entry.label, screen: entry.screens.join(', '),
    fields: fieldSummary(entry),
    ...(textParams(entry).length ? { text_params: textParams(entry) } : {}),
    ...(entry.scope === 'broad' ? {} : { needs_customer_id: true, customer_id_must_match: entry.scope === 'customer' ? `params.${entry.scopeParam}` : `the customer of visit params.${entry.scopeParam}` }),
    does_not: entry.noSend,
  }));
  return {
    status: matches.length ? 'edits_found' : 'no_match',
    matches,
    more_available: ranked.length > matches.length,
    note: matches.length
      ? 'Pass the method and endpoint exactly as listed to propose_admin_edit, with a value for each parameter and only the listed fields. This lookup changes nothing; the edit happens only after the operator confirms its card.'
      : 'No reviewed edit matched. Try other words (a screen name or the noun on the screen). Only small internal edits are on this list: no customer messages, money, deletes, bulk changes, settings, users or credentials.',
  };
}

// ── the plan: one edit, validated against its reviewed row ───────────────

function loopbackOrigin() {
  const port = Number(config.port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? `http://${LOOPBACK_HOST}:${port}` : null;
}

function rowFor(input) {
  const method = typeof input?.method === 'string' ? input.method.toUpperCase() : '';
  const endpoint = typeof input?.endpoint === 'string' ? input.endpoint : '';
  const row = BY_KEY.get(`${method} ${endpoint}`);
  // The deny rules run again here: a catalog row can never outrank them.
  if (!row || writeRules.editDenyReason(row.method, row.endpoint)) {
    return { refusal: refusal('That edit is not on the hand-reviewed admin edit list. Call find_admin_edits to get an exact method and endpoint pattern. Customer messages, money, deletes, bulk changes, settings, users and credentials cannot be edited this way.', 'edit_not_on_list', { hint: 'find_admin_edits' }) };
  }
  return { row };
}

function buildPath(row, params) {
  const filled = readRules.fillPattern(row.endpoint, params === undefined ? {} : params, row.paramKinds || {});
  if (filled.error) return { refusal: refusal(filled.error, 'invalid_input') };
  const segments = readRules.splitPath(filled.path);
  const encoded = textParams(row).length > 0;
  // A parameter value that spells a literal segment must not reach a route the
  // catalog does not cover.
  if (readRules.denyReason(filled.path, { encodedParams: encoded }) || BLOCKED_ROUTES.some(route => readRules.collidesWithRoute(route, segments, row.endpoint))) {
    return { refusal: refusal('That parameter value points outside the reviewed admin edit list.', 'invalid_input') };
  }
  const paramIndexes = readRules.splitPath(row.endpoint).flatMap((segment, index) => (readRules.isParam(segment) ? [index] : []));
  return { path: filled.path, paramIndexes };
}

// The customer a customer-scoped or visit-scoped row is about. The task-context
// guard (task-context.js validateRecordTarget) checks the `customer_id` the
// call carries against the customer of the task, so this must be the REAL
// customer of the record the path names, not what the model says.
async function bindCustomer(row, input, pathParams) {
  const given = input.customer_id === undefined ? null : String(input.customer_id).trim().toLowerCase();
  if (row.scope === 'broad') {
    return given ? { refusal: refusal('This edit does not belong to a customer: leave customer_id out.', 'invalid_input') } : { customerId: null };
  }
  if (!given || !UUID_RE.test(given)) {
    return { refusal: refusal('Give customer_id: this edit is on a customer record, and it is checked against the customer in this task.', 'customer_scope_required') };
  }
  const recordId = String(pathParams[row.scopeParam] || '').trim().toLowerCase();
  if (row.scope === 'customer') {
    return recordId === given ? { customerId: given } : { refusal: refusal('customer_id must be the same customer as the record in the endpoint.', 'target_relationship_mismatch') };
  }
  let visit;
  try {
    visit = await require('../../models/db')('scheduled_services').where({ id: recordId }).first('customer_id');
  } catch {
    return { refusal: refusal('Could not look up the visit just now. Try again in a moment. Nothing was changed.', 'record_lookup_failed') };
  }
  if (!visit) return { refusal: refusal('That visit was not found.', 'record_unavailable') };
  return String(visit.customer_id || '').toLowerCase() === given
    ? { customerId: given }
    : { refusal: refusal('customer_id is not the customer of that visit.', 'target_relationship_mismatch') };
}

const showValue = (value) => {
  if (value === undefined || value === null || value === '') return '(empty)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > CARD_VALUE_CHARS ? `${text.slice(0, CARD_VALUE_CHARS)}… [${text.length - CARD_VALUE_CHARS} more characters]` : text;
};

// The record the card is about: its label, the current value of every carded
// field, its version and its state, from the snapshot queries
// (admin-write-snapshots.js). Fail closed: a record that cannot be read, or does
// not exist, or is in a state the row does not allow, gets no card.
async function recordSnapshot(row, pathParams, bodyKeys) {
  let snapshot;
  try {
    snapshot = await Snapshots.loadSnapshot(`${row.method} ${row.endpoint}`, pathParams, bodyKeys);
  } catch {
    return { refusal: refusal('Could not read that record just now, so nothing was proposed. Try again in a moment.', 'record_lookup_failed') };
  }
  if (snapshot?.unsupported) return { refusal: refusal('That edit has no record snapshot, so it cannot be carded.', 'edit_not_on_list', { hint: 'find_admin_edits' }) };
  if (!snapshot) return { refusal: refusal('That record was not found.', 'record_unavailable') };
  for (const [field, wanted] of Object.entries(row.requireState || {})) {
    if (snapshot.state[field] !== wanted) {
      return { refusal: refusal(`This edit is only allowed while the record's ${field} is "${wanted}" (it is "${snapshot.state[field]}"). Nothing was proposed.`, 'record_state_not_allowed') };
    }
  }
  return { snapshot };
}

async function buildPlan(input) {
  const found = rowFor(input);
  if (found.refusal) return found;
  const { row } = found;
  const built = buildPath(row, input.params);
  if (built.refusal) return built;
  const checked = writeRules.validateBody(row, input.body);
  if (checked.error) return { refusal: refusal(checked.error, 'invalid_input', checked.allowed ? { allowed_fields: checked.allowed } : {}) };
  const key = `${row.method} ${row.endpoint}`;
  let body;
  try {
    body = Snapshots.normalizeBody(key, checked.body);
  } catch {
    return { refusal: refusal('That body could not be read as the screen would read it. Nothing was proposed.', 'invalid_input') };
  }
  const pathParams = Object.fromEntries(readRules.patternParams(row.endpoint).map(name => [name, String(input.params[name])]));
  const bound = await bindCustomer(row, input, pathParams);
  if (bound.refusal) return bound;
  const record = await recordSnapshot(row, pathParams, Object.keys(body));
  if (record.refusal) return record;
  const { snapshot } = record;
  const addressFields = Object.keys(body).filter(writeRules.bodyKeyLooksLikeAddress);
  // The card shows the current text with credentials scrubbed (the model sees it too); the pin covers the raw value.
  const shown = redactSecrets(snapshot.current, newState());
  const changes = Object.keys(body).sort().map(field => ({ field, before: shown[field], after: body[field] }));
  const version = digestOf({
    m: row.method, e: row.endpoint, p: pathParams, b: body, c: bound.customerId, d: row.digest,
    l: snapshot.label, cur: snapshot.current, v: snapshot.version,
  });
  return {
    row, path: built.path, paramIndexes: built.paramIndexes, body, pathParams, customerId: bound.customerId,
    changes, addressFields, version, label: snapshot.label, recordVersion: snapshot.version,
  };
}

function previewOf(plan) {
  const { row } = plan;
  return {
    preview: true,
    tool: ADMIN_EDIT_PROPOSE_TOOL,
    edit: row.label,
    method: row.method,
    endpoint: row.endpoint,
    record: plan.pathParams,
    record_label: plan.label,
    ...(plan.customerId ? { customer_id: plan.customerId } : {}),
    changes: plan.changes,
    address_change: plan.addressFields.length > 0,
    ...(plan.addressFields.length ? { address_fields: plan.addressFields } : {}),
    does_not: row.noSend,
    writes: row.writes,
    reason: row.reason,
    _version: plan.version,
  };
}

// ── the card ─────────────────────────────────────────────────────────────

const humanField = field => String(field).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const fullText = value => (typeof value === 'string' ? value : JSON.stringify(value));

// Card lines for authorization-contract.js: [{ kind, text, more? }]. A long new
// value shows its first characters on the card and the whole text under "Show
// more"; the contract hash covers the complete preview either way.
function cardLines(preview) {
  if (!preview || preview.preview !== true) return [];
  const lines = [];
  if (preview.address_change) {
    lines.push({ kind: 'customer', text: `ADDRESS CHANGE: this edit changes address text (${(preview.address_fields || []).map(humanField).join(', ')}). Check every character before you confirm.` });
  }
  lines.push({ kind: 'operational', text: `Edit: ${preview.edit}` });
  lines.push({ kind: 'operational', text: `Record: ${preview.record_label}` });
  for (const change of preview.changes || []) {
    const after = fullText(change.after);
    lines.push({ kind: 'operational', text: `${humanField(change.field)}: ${showValue(change.before)} → ${showValue(change.after)}` });
    if (after.length > CARD_VALUE_CHARS) lines.push({ kind: 'operational', text: `Full new ${humanField(change.field)}: ${after}`, more: true });
  }
  lines.push({ kind: 'operational', text: preview.does_not });
  lines.push({ kind: 'operational', text: `Saved through the same screen endpoint (${preview.method} ${preview.endpoint}), so its own checks apply.` });
  return lines;
}

// The card's parameter rows (route PINNED_DISPLAY_BUILDERS).
function displayParams(preview) {
  if (!preview || preview.preview !== true) return null;
  const shown = { edit: preview.edit, record: preview.record_label };
  if (preview.address_change) shown.address_change = `YES: ${(preview.address_fields || []).join(', ')}`;
  for (const change of preview.changes || []) {
    shown[change.field] = `${showValue(change.before)} → ${showValue(change.after)}`;
  }
  return shown;
}

// ── confirm: replay the carded body ──────────────────────────────────────

// The screen's own refusal, with the caller's token and the log marker blanked should the endpoint echo them.
function errorText(parsed, status, authorization) {
  const message = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message) : null;
  if (typeof message !== 'string' || !message.trim()) return `The screen's save answered HTTP ${status}`;
  const token = authorization.slice('Bearer '.length);
  const marker = adminReadMarkerValue();
  let text = message.trim().slice(0, 300);
  if (token) text = text.split(token).join('[redacted]');
  text = text.split(marker).join('[redacted]');
  return redactString(text, newState());
}

const interrupted = () => ({ outcome_unknown: true, code: 'execution_interrupted', error: 'The edit was sent but its outcome could not be established. Check the record before taking further action.' });

// Reads the record after the save. null when every carded field now holds its new value; otherwise
// an unknown outcome (the save may or may not have happened) that names the fields.
async function verifySaved(plan) {
  const unverified = (fields) => ({
    outcome_unknown: true, code: 'edit_not_verified',
    error: `The screen answered that it saved, but the record was read again and ${fields} did not hold the new value. Check the record before taking further action.`,
  });
  let after;
  try {
    after = await Snapshots.loadSnapshot(`${plan.row.method} ${plan.row.endpoint}`, plan.pathParams, Object.keys(plan.body));
  } catch {
    return unverified('could not be read, so the fields');
  }
  if (!after || after.unsupported) return unverified('the record was not found, so the fields');
  const wrong = Object.keys(plan.body).filter(field => !Snapshots.sameValue(plan.body[field], after.current[field], plan.row.body[field]));
  return wrong.length ? unverified(wrong.join(', ')) : null;
}

async function replay(plan, authorization) {
  const origin = loopbackOrigin();
  if (!origin) return refusal('The edit could not find this server. Nothing was changed.', 'edit_connection_failed');
  const { row } = plan;
  let response;
  try {
    response = await fetch(`${origin}/api${plan.path}`, {
      method: row.method,
      headers: {
        Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json',
        [ADMIN_READ_HEADER]: adminReadMarkerValue(plan.paramIndexes),
      },
      body: JSON.stringify(plan.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    // The request may have reached the handler before the connection failed.
    logger.warn(`[admin-edit] ${row.method} ${row.endpoint} ${err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timed out' : 'failed'}`);
    return interrupted();
  }
  const status = response.status;
  let parsed;
  try { parsed = JSON.parse(await response.text()); } catch { parsed = undefined; }
  if (status >= 200 && status < 300) {
    if (parsed === undefined) return interrupted();
    // A 200 is not proof (a handler can answer 200 for zero rows): read the record again and require the new values.
    const verified = await verifySaved(plan);
    if (verified) return verified;
    logger.info(`[admin-edit] ${row.method} ${row.endpoint} saved (fields: ${Object.keys(plan.body).sort().join(', ')})`);
    return {
      success: true, status, edited: row.label, method: row.method, endpoint: row.endpoint,
      record: plan.pathParams, fields_changed: Object.keys(plan.body).sort(),
      record_label: plan.label,
      note: 'Saved exactly as the card showed, through the screen\'s own endpoint, and read back to confirm. Nothing was sent to a customer.',
    };
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return {
      success: false, status, error: errorText(parsed, status, authorization), code: status === 404 ? 'record_unavailable' : 'endpoint_rejected',
      note: 'The screen\'s own check refused this edit. Nothing was changed by the bar beyond that answer.',
    };
  }
  return interrupted();
}

// ── tool entry points ────────────────────────────────────────────────────

async function proposeAdminEdit(input, actionContext) {
  const authorization = actionContext.staffAuthorization;
  if (typeof authorization !== 'string' || !BEARER_RE.test(authorization)) {
    return refusal('This edit needs the logged-in owner session, which is missing', 'permission_denied');
  }
  const built = await buildPlan(input || {});
  if (built.refusal) return built.refusal;
  if (input.confirmed !== true) return previewOf(built);
  // The approved pin comes from the card's own preview (the route stores it on
  // the pending action). A plan that no longer equals it is a new card.
  if (!input._approved_edit_pin || input._approved_edit_pin !== built.version) {
    return refusal('What this edit would do changed after the card was shown. Ask again for a fresh confirmation card.', 'preview_changed', { preview_changed: true });
  }
  return replay(built, authorization);
}

async function executeAdminWriteTool(name, input, actionContext = {}) {
  if (![ADMIN_EDIT_FIND_TOOL, ADMIN_EDIT_PROPOSE_TOOL].includes(name)) {
    return refusal('Capability is not implemented', 'capability_unimplemented');
  }
  if (!adminWriteLive()) {
    return refusal('Editing admin screen data from the bar is turned off (GATE_IB_GENERAL_EDIT, which needs GATE_IB_PLATFORM). Nothing was changed.', 'gate_off');
  }
  if (actionContext?.fullAccess !== true || actionContext?.isAdmin === false) {
    return refusal('This edit is limited to the owner account.', 'permission_denied');
  }
  return name === ADMIN_EDIT_FIND_TOOL ? findAdminEdits(input) : proposeAdminEdit(input, actionContext);
}

module.exports = {
  ADMIN_WRITE_TOOLS, executeAdminWriteTool, adminWriteLive, cardLines, displayParams,
  ADMIN_EDIT_FIND_TOOL, ADMIN_EDIT_PROPOSE_TOOL,
};
