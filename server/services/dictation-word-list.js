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
const NAME_MAX_CHARS = 60;
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

/** As many names as fit in `limit` characters of a ", "-joined list. */
function fitList(names, limit) {
  let list = '';
  for (const name of names) {
    const next = list ? `${list}, ${name}` : name;
    if (next.length > limit) break;
    list = next;
  }
  return list;
}

/**
 * The prompt for the given sections, in priority order. `sections` is
 * [{ key, label, names }]; pure, so the cap and the order are testable.
 */
function composePrompt(sections) {
  let prompt = INTRO;
  for (const { key, label, names } of sections) {
    const room = PROMPT_MAX_CHARS - prompt.length - label.length - 2;
    const list = fitList(names, Math.min(SECTION_CAPS[key] ?? room, room));
    if (!list) continue;
    prompt += ` ${label}${list}.`;
  }
  return prompt.slice(0, PROMPT_MAX_CHARS);
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

/** The named customer's name: from `customerId`, else the customer behind `serviceId`. */
async function customerNames(knex, { customerId, serviceId }) {
  let id = UUID_RE.test(String(customerId || '')) ? String(customerId) : null;
  if (!id && UUID_RE.test(String(serviceId || ''))) {
    const svc = await knex('scheduled_services').where({ id: String(serviceId) }).first('customer_id');
    id = svc?.customer_id || null;
  }
  if (!id) return [];
  const row = await knex('customers').where({ id }).first('first_name', 'last_name');
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

module.exports = {
  PROMPT_MAX_CHARS,
  SECTION_CAPS,
  buildDictationPrompt,
  composePrompt,
  cleanName,
  UUID_RE,
};
