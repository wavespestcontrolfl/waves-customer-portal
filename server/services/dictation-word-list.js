/**
 * The word list (the transcriber's `prompt`) for general staff dictation
 * (routes/tech-dictation.js, GATE_SERVER_DICTATION).
 *
 * Built ONLY from our own records, never from text the client sends: the
 * customer the request names (by id), the active technicians, the product
 * catalog (the same source and aliases Fast Complete voice fill primes with),
 * the service catalog, and the pest and lawn words the codebase already keeps.
 * The transcriber only uses it as a spelling hint.
 *
 * The prompt is capped at the voice-fill transcriber's own limit. When the
 * lists do not all fit, the earlier section wins: the named customer, then
 * technicians, then products, then services, then pest and lawn words. Each
 * section also has its own ceiling so a long product list cannot push out the
 * sections below it.
 *
 * GATE_DICTATION_CUSTOMER_NAMES (buildDictationHints; the route chooses it, gate off keeps
 * buildDictationPrompt exactly as it was): adds "Customers who may be named" right after the
 * named customer: the customer on screen, customers with a visit today or tomorrow, customers
 * who texted or called in the last 48 hours, then recently updated active customers; full
 * names, "First Last". Products shrink to make room (the 1800-character cap does not move).
 * A technician login gets the first group for its OWN stops only; the texts, calls and
 * recent-customer groups are office reads and stay admin-only. The list is cached 5 minutes
 * per (login scope, ET day); the on-screen customer is added per request. The same names'
 * surnames come back as `keywords` for the transcriber's keywords[] hint.
 *
 * Nothing here is logged. Names never leave the transcription call.
 */
const db = require('../models/db');
const logger = require('./logger');
const { STT_HINTS } = require('../config/transcription-vocabulary');

// Same ceiling as the voice-fill transcriber's prompt (benchmarked 2026-10-03).
const PROMPT_MAX_CHARS = 1800;
const INTRO = 'Dictated by Waves Pest Control staff (pest control and lawn care, Southwest Florida).';
// Own ceiling per section, in characters of the list itself (the label is extra).
const SECTION_CAPS = Object.freeze({ customer: 150, technicians: 300, products: 750, services: 300, terms: 450 });
// With GATE_DICTATION_CUSTOMER_NAMES the product list gives up room for the customer names.
const NAMES_SECTION_CAPS = Object.freeze({ ...SECTION_CAPS, products: 400, customers: 350 });
const NAME_MAX_CHARS = 60;
// Live visit statuses the route list counts (a finished or cancelled stop is not "on the route").
const LIVE_VISIT_STATUSES = Object.freeze(['pending', 'confirmed', 'en_route', 'on_site']);
const NAME_CACHE_TTL_MS = 5 * 60 * 1000;
const NAME_CACHE_MAX_ENTRIES = 100;
const RECENT_CONTACT_HOURS = 48;
const NAME_ROWS = Object.freeze({ visits: 40, contacts: 30, recent: 40 });
const KEYWORD_MAX = 50;
// Voice-fill idioms that mean nothing outside a visit sheet.
const SHEET_IDIOMS = new Set(['no wait', 'same as last time']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One name as it may sit in a comma list: no control characters, quotes or commas, bounded. */
function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[,;:"`<>{}[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX_CHARS)
    .trim();
}

/** Distinct, cleaned names (case-insensitive), order kept. */
function uniqueNames(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const name = cleanName(value);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** The leading names that fit in `limit` characters of a ", "-joined list (same rule as fitList). */
function fitNames(names, limit) {
  const kept = [];
  let length = 0;
  for (const name of names) {
    const next = length + (kept.length ? 2 : 0) + name.length;
    if (next > limit) break;
    kept.push(name);
    length = next;
  }
  return kept;
}

/**
 * The prompt for the given sections, in priority order, and the names each section kept.
 * `sections` is [{ key, label, names }]; pure, so the cap and the order are testable.
 */
function composeSections(sections, caps = SECTION_CAPS) {
  let prompt = INTRO;
  const kept = {};
  for (const { key, label, names } of sections) {
    const room = PROMPT_MAX_CHARS - prompt.length - label.length - 2;
    const used = fitNames(names, Math.min(caps[key] ?? room, room));
    if (!used.length) continue;
    kept[key] = used;
    prompt += ` ${label}${used.join(', ')}.`;
  }
  return { prompt: prompt.slice(0, PROMPT_MAX_CHARS), kept };
}

function composePrompt(sections, caps = SECTION_CAPS) {
  return composeSections(sections, caps).prompt;
}

/** The pest and lawn words the codebase already keeps (voice fill's sheet words, the call hints). */
function termList() {
  const voiceFill = require('./fast-complete-voice-fill');
  const words = [
    ...voiceFill.PEST_SHEET_PESTS.filter((pest) => pest !== 'Other'),
    ...String(voiceFill.TRANSCRIBE_SHEET_WORDS || '').split(','),
    ...String(voiceFill.LAWN_TRANSCRIBE_WORDS || '').split(','),
    // Last: the transcriber already gets these as keyword hints (call-recording-processor).
    ...STT_HINTS,
  ].map((word) => word.trim()).filter((word) => word && !SHEET_IDIOMS.has(word.toLowerCase()));
  return uniqueNames(words);
}

// A failed read of one source drops that section; it never fails the clip.
async function safely(label, read) {
  try {
    return await read();
  } catch (err) {
    logger.warn(`[dictation-word-list] ${label} unavailable: ${err?.code || err?.name || 'Error'}`);
    return [];
  }
}

/** The named customer's row: from `customerId`, else the customer behind `serviceId`. */
async function namedCustomerRow(knex, { customerId, serviceId }) {
  let id = UUID_RE.test(String(customerId || '')) ? String(customerId) : null;
  if (!id && UUID_RE.test(String(serviceId || ''))) {
    const svc = await knex('scheduled_services').where({ id: String(serviceId) }).first('customer_id');
    id = svc?.customer_id || null;
  }
  if (!id) return null;
  return (await knex('customers').where({ id }).first('first_name', 'last_name')) || null;
}

/** The named customer's name: from `customerId`, else the customer behind `serviceId`. */
async function customerNames(knex, context) {
  const row = await namedCustomerRow(knex, context);
  if (!row) return [];
  const full = cleanName(`${row.first_name || ''} ${row.last_name || ''}`);
  return uniqueNames([full, row.first_name, row.last_name]);
}

async function technicianNames(knex) {
  const rows = await knex('technicians').where({ employment_status: 'active' }).orderBy('name').select('name');
  const names = [];
  for (const row of rows) {
    const full = cleanName(row.name);
    if (!full) continue;
    names.push(full);
  }
  // First names are what people say aloud ("tell Marcus"); after the full names so a tight cap keeps those.
  const firsts = names.map((full) => full.split(' ')[0]).filter((first) => first.length > 1);
  return uniqueNames([...names, ...firsts]);
}

async function productNames(knex) {
  const voiceFill = require('./fast-complete-voice-fill');
  const { loadRecapCatalogProducts } = require('./pest-recap');
  const catalog = (await loadRecapCatalogProducts(knex))
    .filter((row) => row && row.id != null && String(row.name || '').trim()
      && !voiceFill.HIDDEN_CATEGORIES.has(voiceFill.categoryKey(row)));
  const aliases = await voiceFill.loadProductAliases(knex, catalog.map((row) => row.id));
  return uniqueNames(catalog.flatMap((row) => [
    row.display_name || row.name,
    ...(aliases.get(String(row.id)) || []).slice(0, 8),
  ]));
}

async function serviceNames(knex) {
  const rows = await knex('services').where({ is_active: true }).orderBy('name').select('name', 'short_name');
  return uniqueNames(rows.flatMap((row) => [row.name, row.short_name]));
}

/**
 * The transcription prompt for one dictation request.
 * `context` = { customerId?, serviceId? }, ids only. Never throws on a failed
 * source: the prompt just carries fewer sections.
 */
async function buildDictationPrompt(context = {}, knex = db) {
  const [customer, technicians, products, services] = await Promise.all([
    safely('customer', () => customerNames(knex, context || {})),
    safely('technicians', () => technicianNames(knex)),
    safely('products', () => productNames(knex)),
    safely('services', () => serviceNames(knex)),
  ]);
  return composePrompt([
    { key: 'customer', label: 'Customer on this screen: ', names: customer },
    { key: 'technicians', label: 'Staff who may be named: ', names: technicians },
    { key: 'products', label: 'Products that may be said: ', names: products },
    { key: 'services', label: 'Services that may be said: ', names: services },
    { key: 'terms', label: 'Other words that may be said: ', names: termList() },
  ]);
}

// ── GATE_DICTATION_CUSTOMER_NAMES ───────────────────────────────────────────

// (scope key|ET day) -> { at, people }. In memory, 5 minutes, so each clip does not re-query.
const nameCache = new Map();

function resetNameCache() { nameCache.clear(); }

/** A person row as { full, last }, or null when there is no usable name. */
function personFrom(row) {
  const first = cleanName(row?.first_name);
  const last = cleanName(row?.last_name);
  const full = cleanName(`${first} ${last}`);
  return full ? { full, last } : null;
}

/** Distinct people by full name (case-insensitive), order kept. */
function uniquePeople(people) {
  const seen = new Set();
  const out = [];
  for (const person of people) {
    if (!person) continue;
    const key = person.full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(person);
  }
  return out;
}

/** Who this login may be told about: a technician sees its own stops, an admin sees the office's view. */
function loginScope(scope) {
  const technicianId = scope?.technicianId;
  return technicianId ? { key: `tech:${technicianId}`, technicianId: String(technicianId) } : { key: 'admin', technicianId: null };
}

async function routePeople(knex, scope, today, tomorrow) {
  const q = knex('scheduled_services')
    .join('customers as c', 'c.id', 'scheduled_services.customer_id')
    .whereNull('c.deleted_at')
    .whereIn('scheduled_services.status', LIVE_VISIT_STATUSES)
    .whereBetween('scheduled_services.scheduled_date', [today, tomorrow])
    .orderBy('scheduled_services.scheduled_date')
    .orderBy('scheduled_services.window_start')
    .limit(NAME_ROWS.visits);
  if (scope.technicianId) q.where('scheduled_services.technician_id', scope.technicianId);
  const rows = await q.select('c.first_name', 'c.last_name');
  return rows.map(personFrom);
}

async function contactPeople(knex) {
  const since = new Date(Date.now() - RECENT_CONTACT_HOURS * 3600 * 1000);
  const rows = await knex('conversations as cv')
    .join('customers as c', 'c.id', 'cv.customer_id')
    .whereNull('c.deleted_at')
    .whereIn('cv.channel', ['sms', 'voice', 'voicemail'])
    .where('cv.last_inbound_at', '>=', since)
    .orderBy('cv.last_inbound_at', 'desc')
    .limit(NAME_ROWS.contacts)
    .select('c.first_name', 'c.last_name');
  return rows.map(personFrom);
}

async function recentPeople(knex) {
  const rows = await knex('customers')
    .where({ active: true })
    .whereNull('deleted_at')
    .orderBy('updated_at', 'desc')
    .limit(NAME_ROWS.recent)
    .select('first_name', 'last_name');
  return rows.map(personFrom);
}

/**
 * Customers who may be named, best first, for one login scope: today's and tomorrow's route (ET),
 * then (admin only) customers who texted or called in the last 48 hours, then recently updated
 * active customers. Cached per (scope, ET day) for 5 minutes. A failed read drops its group.
 */
async function customerPeople(knex, scope, now = new Date()) {
  const { addETDays, etDateString } = require('../utils/datetime-et');
  const today = etDateString(now);
  const cacheKey = `${scope.key}|${today}`;
  const hit = nameCache.get(cacheKey);
  if (hit && now.getTime() - hit.at < NAME_CACHE_TTL_MS && now.getTime() >= hit.at) return hit.people;
  const tomorrow = etDateString(addETDays(now, 1));
  const groups = [await safely('route customers', () => routePeople(knex, scope, today, tomorrow))];
  if (!scope.technicianId) {
    groups.push(await safely('texting customers', () => contactPeople(knex)));
    groups.push(await safely('recent customers', () => recentPeople(knex)));
  }
  const people = uniquePeople(groups.flat());
  // Every read failed: do not pin an empty list for 5 minutes.
  if (people.length) {
    if (nameCache.size >= NAME_CACHE_MAX_ENTRIES) nameCache.delete(nameCache.keys().next().value);
    nameCache.set(cacheKey, { at: now.getTime(), people });
  }
  return people;
}

/**
 * The prompt AND the transcriber keyword hints for one dictation request with
 * GATE_DICTATION_CUSTOMER_NAMES on. `context` = { customerId?, serviceId?, scope? } where
 * `scope` = { technicianId } for a technician login (absent = admin). The ids must already
 * be fenced by the route. Never throws on a failed source.
 */
async function buildDictationHints(context = {}, knex = db) {
  const ctx = context || {};
  const scope = loginScope(ctx.scope);
  const [onScreenRow, technicians, products, services, people] = await Promise.all([
    safely('customer', async () => [await namedCustomerRow(knex, ctx)]),
    safely('technicians', () => technicianNames(knex)),
    safely('products', () => productNames(knex)),
    safely('services', () => serviceNames(knex)),
    safely('customer names', () => customerPeople(knex, scope)),
  ]);
  const row = onScreenRow[0] || null;
  const customer = row
    ? uniqueNames([cleanName(`${row.first_name || ''} ${row.last_name || ''}`), row.first_name, row.last_name])
    : [];
  const onScreen = personFrom(row);
  const ordered = uniquePeople([onScreen, ...people]);
  const { prompt, kept } = composeSections([
    { key: 'customer', label: 'Customer on this screen: ', names: customer },
    { key: 'customers', label: 'Customers who may be named: ', names: ordered.map((person) => person.full) },
    { key: 'technicians', label: 'Staff who may be named: ', names: technicians },
    { key: 'products', label: 'Products that may be said: ', names: products },
    { key: 'services', label: 'Services that may be said: ', names: services },
    { key: 'terms', label: 'Other words that may be said: ', names: termList() },
  ], NAMES_SECTION_CAPS);
  // Surnames of the names that made it into the prompt, in the same order (on-screen first).
  const keptFull = new Set((kept.customers || []).map((name) => name.toLowerCase()));
  const keywords = uniqueNames(ordered
    .filter((person) => keptFull.has(person.full.toLowerCase()) && person.last.length > 1)
    .map((person) => person.last)).slice(0, KEYWORD_MAX);
  return { prompt, keywords };
}

module.exports = {
  PROMPT_MAX_CHARS,
  SECTION_CAPS,
  NAMES_SECTION_CAPS,
  KEYWORD_MAX,
  buildDictationPrompt,
  buildDictationHints,
  resetNameCache,
  composePrompt,
  cleanName,
  UUID_RE,
};
