'use strict';

/**
 * Company facts bank (owner 2026-11-25 "all rec"): owner-approved lines the agents may state beside the code lines
 * in COMPANY_FACTS (services/sms-company-facts.js). The DB row is the source of truth, the opposite of
 * knowledge_base mirroring code. PR 1: the writer, the checks and the runtime snapshot. NO reader yet: nothing in
 * this release calls getApprovedBankFacts or renderBankFactsLines, and an empty bank changes nothing, so there is
 * no gate (the off switch is retiring the row).
 *
 * Life cycle: draft -> approved -> retired. A retired line comes back only as a NEW draft (restoreAsDraft). An edit
 * of an approved line is a NEW draft with supersedes_id; approving it retires the old row in the same transaction.
 * The text of an approved row never changes: this service never writes it, and a database trigger refuses it.
 *
 * Who: any admin drafts, edits a draft, discards a draft and retires. Approval is the owner account only: the route
 * enforces it with requireFullAccess and approveFact refuses an actor without isOwner (a second, server-side check).
 *
 * Hard blocks (checkFactText, run again at approve time and again on every snapshot load, so a row written around
 * this service is dropped, never served): banned customer copy, a dollar amount, a percent, a product name from
 * products_catalog, a phone number, email, link or handle, text shaped like an instruction, more than three
 * sentences, more than 400 characters, a line break, a duplicate of a code line or of another bank line, and a bank
 * that already holds 20 approved lines. Soft warnings (price, promise and hand-off words) need warnings_acknowledged.
 *
 * Snapshot: getApprovedBankFacts() is SYNC and reads an in-process copy that boots with the server and refreshes
 * every 60 s (the sms-prompt-patch.js pattern). A copy older than 5 minutes reads as empty (fail closed: a database
 * blip never keeps a retired line alive for long). invalidate() runs in the process that approved or retired a line,
 * so that process is instant; the others catch up within 60 s.
 *
 * Errors log codes only, never fact text.
 */

const crypto = require('crypto');
const logger = require('./logger');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');

const MAX_FACT_CHARS = 400;
const MAX_DRAFT_CHARS = 2000;
const MAX_SENTENCES = 3;
const MAX_ACTIVE_FACTS = 20;
const REFRESH_MS = 60 * 1000;
const STALE_MS = 5 * 60 * 1000;
const STATUSES = Object.freeze(['draft', 'approved', 'retired']);
const SOURCES = Object.freeze(['admin_page', 'owner_paste', 'mac_sms_job', 'mac_call_job', 'import']);
const AUDIT_APPROVED = 'company_fact.approved';
const AUDIT_RETIRED = 'company_fact.retired';

class FactError extends Error {
  constructor(code, status = 400, detail = {}) {
    super(code);
    this.name = 'FactError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/* ── Text checks (pure) ───────────────────────────────────────────────── */

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

// Lowercase words only, for the duplicate and brand compares.
const normalise = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|\b\d{3}[-.\s]\d{4}\b/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LINK_RE = /\bhttps?:|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|gov|edu|info|biz|app|ly|me)\b/i;
const HANDLE_RE = /(?:^|\s)[@#]\w+/;
const MONEY_RE = /\$|\b(?:dollars?|bucks|cents?)\b/i;
const PERCENT_RE = /%|\bper ?cent\b/i;
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

// [code, regex]: each is a hard block on its own.
const SHAPE_BLOCKS = Object.freeze([
  ['line_break', LINE_BREAK_RE],
  ['dollar_amount', MONEY_RE],
  ['percent', PERCENT_RE],
  ['phone_number', PHONE_RE],
  ['email_address', EMAIL_RE],
  ['link', LINK_RE],
  ['handle', HANDLE_RE],
]);

// A product's first word counts as a brand mention unless it is one of these generic words.
const GENERIC_PRODUCT_WORDS = new Set([
  'granular', 'insecticide', 'fertilizer', 'herbicide', 'fungicide', 'general', 'liquid', 'professional', 'concentrate', 'surfactant',
]);

// The SMS prompt patch screens (sms-prompt-patch.js: the same words the other agent guards treat as risky), read on first
// use so that merely loading this module (the scheduler boot hook) needs nothing else loaded.
let screens = null;
function loadScreens() {
  if (!screens) {
    const patch = require('./sms-prompt-patch');
    const global = (re) => new RegExp(re.source, 'gi');
    screens = {
      injection: patch.INJECTION_RE,
      warnings: [['price_words', global(patch.PRICE_RE)], ['promise_words', global(patch.PROMISE_RE)], ['handoff_words', global(patch.HANDOFF_RE)]],
    };
  }
  return screens;
}

function countSentences(text) {
  return String(text).split(SENTENCE_SPLIT_RE).filter((part) => part.trim()).length;
}

function productTokens(names) {
  const tokens = new Set();
  for (const name of names || []) {
    const full = normalise(name);
    if (full.length >= 4) tokens.add(full);
    const first = full.split(' ')[0];
    if (first.length >= 6 && !GENERIC_PRODUCT_WORDS.has(first)) tokens.add(first);
  }
  return tokens;
}

function mentionsProduct(text, tokens) {
  const padded = ` ${normalise(text)} `;
  for (const token of tokens) if (padded.includes(` ${token} `)) return true;
  return false;
}

/** hasBannedCustomerCopy from the SMS drafter, loaded on first use. Fails closed: a guard that cannot load bans the text. */
function hasBannedCopy(text) {
  try {
    return require('./sms-shadow-drafter').hasBannedCustomerCopy(text) !== false;
  } catch {
    return true;
  }
}

function warningsFor(text) {
  const out = [];
  for (const [code, re] of loadScreens().warnings) {
    const words = [...new Set((text.match(re) || []).map((w) => w.toLowerCase()).filter((w) => w !== '$' && w !== '%'))];
    if (words.length) out.push({ code, words });
  }
  return out;
}

// The text with every shape that already has its own code removed, so a link is not also "injection shaped".
function withoutShapes(text) {
  return SHAPE_BLOCKS.reduce((rest, [, re]) => rest.replace(new RegExp(re.source, `g${re.flags.replace('g', '')}`), ' '), text);
}

/**
 * The hard blocks and soft warnings for one line. Pure given its context:
 *   ctx.productNames  products_catalog names
 *   ctx.codeKeys      Set of normalised COMPANY_FACTS lines
 *   ctx.bankKeys      Set of normalised other bank lines
 * Returns { blocks: [code], warnings: [{ code, words }] }.
 */
function checkFactText(rawText, ctx = {}) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return { blocks: ['empty'], warnings: [] };
  const blocks = [];
  if (text.length > MAX_FACT_CHARS) blocks.push('too_long');
  if (countSentences(text) > MAX_SENTENCES) blocks.push('too_many_sentences');
  for (const [code, re] of SHAPE_BLOCKS) if (re.test(text)) blocks.push(code);
  if (loadScreens().injection.test(withoutShapes(text))) blocks.push('injection_shape');
  if (mentionsProduct(text, productTokens(ctx.productNames))) blocks.push('product_brand');
  const key = normalise(text);
  if (ctx.codeKeys && ctx.codeKeys.has(key)) blocks.push('duplicate_code_line');
  if (ctx.bankKeys && ctx.bankKeys.has(key)) blocks.push('duplicate_bank_line');
  if (hasBannedCopy(text)) blocks.push('banned_copy');
  return { blocks, warnings: warningsFor(text) };
}

/** `- line` per fact, '' for an empty bank. The wrapper that names the section is each reader's own. */
function renderBankFactsLines(facts = getApprovedBankFacts()) {
  const list = Array.isArray(facts) ? facts : [];
  return list.length ? list.map((f) => `- ${f.text}`).join('\n') : '';
}

/** Hash of the approved ids and text hashes, in approval order: '' for an empty bank. For readers that stamp a version. */
function bankVersionHash(facts = getApprovedBankFacts()) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return '';
  return sha256(list.map((f) => `${f.id}:${f.sha}`).join('\n'));
}

/* ── Check context (database reads) ───────────────────────────────────── */

function codeFactKeys() {
  const { COMPANY_FACTS } = require('./sms-company-facts');
  return new Set(COMPANY_FACTS.map(normalise));
}

/** Product names from products_catalog. Throws when it cannot be read: a check without the catalog must not pass. */
async function readProductNames(dbi) {
  const rows = await dbi('products_catalog').select('name');
  return rows.map((r) => r.name).filter(Boolean);
}

async function readBankKeys(dbi, { statuses, excludeIds }) {
  if (!statuses.length) return new Set();
  const rows = await dbi('company_facts').whereIn('status', statuses).whereNotIn('id', excludeIds.filter(Boolean)).select('fact_text');
  return new Set(rows.map((r) => normalise(r.fact_text)));
}

async function loadCheckContext(dbi, { statuses = ['draft', 'approved'], excludeIds = [] } = {}) {
  let productNames;
  try {
    productNames = await readProductNames(dbi);
  } catch (err) {
    logger.error(`[company-facts-bank] product catalog read failed (code ${err?.code || 'unknown'})`);
    throw new FactError('CATALOG_UNAVAILABLE', 503);
  }
  return { productNames, codeKeys: codeFactKeys(), bankKeys: await readBankKeys(dbi, { statuses, excludeIds }) };
}

const checkResult = (check) => ({ blocks: check.blocks, warnings: check.warnings, checked_at: new Date().toISOString() });

/* ── Writer ───────────────────────────────────────────────────────────── */

const cleanLine = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Optional labels: [input key, max chars]. An empty value clears the field.
const OPTIONAL_LINES = Object.freeze([['question', 300], ['ownerWords', 500], ['sourceRef', 200]]);

function cleanText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > MAX_DRAFT_CHARS) throw new FactError('TEXT_TOO_LONG', 400);
  return text;
}

/** Fields of a new or edited draft. Only the shape is refused here; the hard blocks are recorded, and bite at approve. */
function cleanFields(input, { requireAll }) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  const given = (key) => requireAll || src[key] !== undefined;
  if (given('topic')) out.topic = cleanLine(src.topic, 120);
  if (given('factText')) out.factText = cleanText(src.factText);
  for (const [key, max] of OPTIONAL_LINES) if (src[key] !== undefined) out[key] = cleanLine(src[key], max) || null;
  if (src.source !== undefined) out.source = src.source;
  if ('source' in out && !SOURCES.includes(out.source)) throw new FactError('INVALID_SOURCE', 400);
  if ('topic' in out && !out.topic) throw new FactError('TOPIC_REQUIRED', 400);
  if ('factText' in out && !out.factText) throw new FactError('TEXT_REQUIRED', 400);
  return out;
}

const mapWriteError = (err) => (err && err.code === '23505' ? new FactError('DUPLICATE', 409) : err);

async function addEvent(trx, factId, action, actor, detail = {}) {
  await trx('company_fact_events').insert({ fact_id: factId, action, actor_id: actor.id || null, detail });
}

async function lockFact(trx, id) {
  const row = await trx('company_facts').where({ id }).forUpdate().first();
  if (!row) throw new FactError('NOT_FOUND', 404);
  return row;
}

async function insertDraft(trx, values, actor, { action, detail }) {
  let row;
  try {
    [row] = await trx('company_facts').insert(values).returning('*');
  } catch (err) {
    throw mapWriteError(err);
  }
  await addEvent(trx, row.id, action, actor, detail);
  return row;
}

async function createDraft(input, actor, { dbi = db } = {}) {
  const f = cleanFields(input, { requireAll: true });
  const check = checkFactText(f.factText, await loadCheckContext(dbi));
  return dbi.transaction((trx) => insertDraft(trx, {
    topic: f.topic,
    question: f.question || null,
    fact_text: f.factText,
    text_sha256: sha256(f.factText),
    source: f.source || 'admin_page',
    source_ref: f.sourceRef || null,
    owner_words: f.ownerWords || null,
    check_result: checkResult(check),
    created_by: actor.id || null,
  }, actor, { action: 'drafted', detail: { source: f.source || 'admin_page' } }));
}

async function editDraftRow(trx, row, f, actor, dbi) {
  const text = 'factText' in f ? f.factText : row.fact_text;
  const check = checkFactText(text, await loadCheckContext(dbi, { excludeIds: [row.id] }));
  const patch = { fact_text: text, text_sha256: sha256(text), check_result: checkResult(check), warnings_acknowledged: false, updated_at: trx.fn.now() };
  if ('topic' in f) patch.topic = f.topic;
  if ('question' in f) patch.question = f.question;
  if ('ownerWords' in f) patch.owner_words = f.ownerWords;
  if ('sourceRef' in f) patch.source_ref = f.sourceRef;
  let updated;
  try {
    [updated] = await trx('company_facts').where({ id: row.id }).update(patch).returning('*');
  } catch (err) {
    throw mapWriteError(err);
  }
  await addEvent(trx, row.id, 'edited', actor, { text_changed: text !== row.fact_text });
  return updated;
}

async function editApprovedRow(trx, row, f, actor, dbi) {
  if (!('factText' in f) || f.factText === row.fact_text) throw new FactError('TEXT_UNCHANGED', 409);
  const pending = await trx('company_facts').where({ supersedes_id: row.id, status: 'draft' }).first('id');
  if (pending) throw new FactError('EDIT_IN_PROGRESS', 409, { draftId: pending.id });
  const check = checkFactText(f.factText, await loadCheckContext(dbi, { excludeIds: [row.id] }));
  return insertDraft(trx, {
    topic: 'topic' in f ? f.topic : row.topic,
    question: 'question' in f ? f.question : row.question,
    fact_text: f.factText,
    text_sha256: sha256(f.factText),
    source: row.source,
    source_ref: 'sourceRef' in f ? f.sourceRef : row.source_ref,
    owner_words: 'ownerWords' in f ? f.ownerWords : null,
    check_result: checkResult(check),
    supersedes_id: row.id,
    created_by: actor.id || null,
  }, actor, { action: 'drafted', detail: { supersedes_id: row.id } });
}

/** A draft is edited in place; an approved row is never touched: its edit is a NEW draft that supersedes it. */
async function editFact(id, patch, actor, { dbi = db } = {}) {
  const f = cleanFields(patch, { requireAll: false });
  return dbi.transaction(async (trx) => {
    const row = await lockFact(trx, id);
    if (row.status === 'retired') throw new FactError('RETIRED_USE_RESTORE', 409);
    return row.status === 'draft' ? editDraftRow(trx, row, f, actor, dbi) : editApprovedRow(trx, row, f, actor, dbi);
  });
}

/** A retired line returns only as a new draft; the retired row and its history stay. */
async function restoreAsDraft(id, actor, { dbi = db } = {}) {
  return dbi.transaction(async (trx) => {
    const row = await lockFact(trx, id);
    if (row.status !== 'retired') throw new FactError('NOT_RETIRED', 409);
    const check = checkFactText(row.fact_text, await loadCheckContext(dbi));
    return insertDraft(trx, {
      topic: row.topic,
      question: row.question,
      fact_text: row.fact_text,
      text_sha256: row.text_sha256,
      source: row.source,
      source_ref: row.source_ref,
      check_result: checkResult(check),
      created_by: actor.id || null,
    }, actor, { action: 'restored_as_draft', detail: { from_id: row.id } });
  });
}

async function discardDraft(id, actor, { dbi = db } = {}) {
  return dbi.transaction(async (trx) => {
    const row = await lockFact(trx, id);
    if (row.status !== 'draft') throw new FactError('NOT_A_DRAFT', 409);
    await trx('company_facts').where({ id }).del();
    await addEvent(trx, id, 'discarded', actor, { text_sha256: row.text_sha256 });
    return { id, discarded: true };
  });
}

/* ── Approve and retire ───────────────────────────────────────────────── */

async function approvedTextsExcept(trx, excludeId) {
  const q = trx('company_facts').where({ status: 'approved' }).orderBy('approved_at', 'asc').select('fact_text');
  if (excludeId) q.whereNot('id', excludeId);
  return (await q).map((r) => ({ text: r.fact_text }));
}

/** Every approve-time check, on the server. Throws BLOCKED (with codes) or WARNINGS_NOT_ACKNOWLEDGED. */
async function approveChecks(trx, row, { acknowledgeWarnings }, dbi) {
  const ctx = await loadCheckContext(dbi, { statuses: ['approved'], excludeIds: [row.id, row.supersedes_id] });
  const check = checkFactText(row.fact_text, ctx);
  const others = await approvedTextsExcept(trx, row.supersedes_id);
  if (others.length >= MAX_ACTIVE_FACTS) check.blocks.push('bank_full');
  if (!check.blocks.length && hasBannedCopy(renderBankFactsLines([...others, { text: row.fact_text }]))) check.blocks.push('section_banned_copy');
  if (check.blocks.length) throw new FactError('BLOCKED', 422, { blocks: check.blocks, warnings: check.warnings.map((w) => w.code) });
  if (check.warnings.length && !acknowledgeWarnings) {
    throw new FactError('WARNINGS_NOT_ACKNOWLEDGED', 409, { warnings: check.warnings });
  }
  return check;
}

async function retireSuperseded(trx, row, actor) {
  if (!row.supersedes_id) return null;
  const old = await lockFact(trx, row.supersedes_id);
  if (old.status !== 'approved') return null;
  await trx('company_facts').where({ id: old.id }).update({
    status: 'retired', retired_by: actor.id || null, retired_at: trx.fn.now(), retire_reason: 'superseded', updated_at: trx.fn.now(),
  });
  await addEvent(trx, old.id, 'retired', actor, { reason: 'superseded', superseded_by: row.id });
  await recordAuditEvent({
    actor_type: 'technician', actor_id: actor.id || null, action: AUDIT_RETIRED, resource_type: 'company_fact', resource_id: old.id,
    metadata: { reason: 'superseded', superseded_by: row.id, text_sha256: old.text_sha256 }, critical: true, trx,
  });
  return old.id;
}

/** Owner only. Re-runs every hard block, retires the line this one supersedes, and audits, in ONE transaction. */
async function approveFact(id, input, actor, { dbi = db } = {}) {
  if (!actor || !actor.isOwner) throw new FactError('OWNER_ONLY', 403);
  const ownerWords = cleanLine(input && input.ownerWords, 500) || null;
  const acknowledgeWarnings = Boolean(input && input.acknowledgeWarnings);
  const approved = await dbi.transaction(async (trx) => {
    const row = await lockFact(trx, id);
    if (row.status !== 'draft') throw new FactError('NOT_A_DRAFT', 409);
    const check = await approveChecks(trx, row, { acknowledgeWarnings }, dbi);
    const supersededId = await retireSuperseded(trx, row, actor);
    const [updated] = await trx('company_facts').where({ id }).update({
      status: 'approved',
      approved_by: actor.id || null,
      approved_at: trx.fn.now(),
      owner_words: ownerWords || row.owner_words,
      check_result: checkResult(check),
      warnings_acknowledged: Boolean(check.warnings.length && acknowledgeWarnings),
      updated_at: trx.fn.now(),
    }).returning('*');
    await addEvent(trx, id, 'approved', actor, { superseded_id: supersededId, warnings: check.warnings.map((w) => w.code) });
    await recordAuditEvent({
      actor_type: 'technician', actor_id: actor.id || null, action: AUDIT_APPROVED, resource_type: 'company_fact', resource_id: id,
      metadata: { text_sha256: row.text_sha256, superseded_id: supersededId, warnings: check.warnings.map((w) => w.code) }, critical: true, trx,
    });
    return updated;
  });
  await invalidate({ dbi });
  return approved;
}

/** Any admin. The off switch: the line leaves the snapshot of this process at once, the others within a minute. */
async function retireFact(id, input, actor, { dbi = db } = {}) {
  const reason = cleanLine(input && input.reason, 300);
  if (reason.length < 3) throw new FactError('REASON_REQUIRED', 400);
  const retired = await dbi.transaction(async (trx) => {
    const row = await lockFact(trx, id);
    if (row.status !== 'approved') throw new FactError('NOT_APPROVED', 409);
    const [updated] = await trx('company_facts').where({ id }).update({
      status: 'retired', retired_by: actor.id || null, retired_at: trx.fn.now(), retire_reason: reason, updated_at: trx.fn.now(),
    }).returning('*');
    await addEvent(trx, id, 'retired', actor, { reason });
    await recordAuditEvent({
      actor_type: 'technician', actor_id: actor.id || null, action: AUDIT_RETIRED, resource_type: 'company_fact', resource_id: id,
      metadata: { reason, text_sha256: row.text_sha256 }, critical: true, trx,
    });
    return updated;
  });
  await invalidate({ dbi });
  return retired;
}

/* ── Reads ────────────────────────────────────────────────────────────── */

async function listFacts({ status } = {}, { dbi = db } = {}) {
  if (status && status !== 'all' && !STATUSES.includes(status)) throw new FactError('INVALID_STATUS', 400);
  const q = dbi('company_facts').orderBy('created_at', 'desc').limit(500).select('*');
  if (status && status !== 'all') q.where({ status });
  return q;
}

async function getFact(id, { dbi = db } = {}) {
  const row = await dbi('company_facts').where({ id }).first();
  if (!row) throw new FactError('NOT_FOUND', 404);
  return row;
}

/** Every event of one fact, oldest first. Also answers for a discarded draft (events outlive the row). */
async function factHistory(id, { dbi = db } = {}) {
  return dbi('company_fact_events').where({ fact_id: id }).orderBy('at', 'asc').select('*');
}

/* ── Snapshot ─────────────────────────────────────────────────────────── */

let state = { facts: Object.freeze([]), loadedAt: 0 };
let generation = 0;
let refreshTimer = null;
let lastDropKey = '';

/** The approved rows that still pass every hard block, in approval order, at most MAX_ACTIVE_FACTS. */
async function loadVerifiedFacts(dbi) {
  const rows = await dbi('company_facts').where({ status: 'approved' }).orderBy([{ column: 'approved_at', order: 'asc' }, { column: 'id', order: 'asc' }]).select('*');
  const base = await loadCheckContext(dbi, { statuses: [], excludeIds: [] });
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const row of rows) {
    const check = checkFactText(row.fact_text, { ...base, bankKeys: seen });
    const shaOk = row.text_sha256 === sha256(String(row.fact_text || '').trim());
    if (check.blocks.length || !shaOk || kept.length >= MAX_ACTIVE_FACTS) {
      dropped.push(`${row.id}:${shaOk ? (check.blocks.join('+') || 'bank_full') : 'hash_mismatch'}`);
      continue;
    }
    seen.add(normalise(row.fact_text));
    kept.push(Object.freeze({ id: row.id, topic: row.topic, text: row.fact_text.trim(), sha: row.text_sha256, approvedAt: row.approved_at }));
  }
  const dropKey = dropped.join(',');
  if (dropKey && dropKey !== lastDropKey) logger.error(`[company-facts-bank] approved rows dropped at load (codes only): ${dropKey}`);
  lastDropKey = dropKey;
  return Object.freeze(kept);
}

/** Reload the snapshot. A failed read keeps the last copy (it ages out after STALE_MS); a read overtaken by invalidate() is discarded. */
async function refreshBankFacts({ dbi = db, now = Date.now } = {}) {
  const startedIn = generation;
  try {
    const facts = await loadVerifiedFacts(dbi);
    if (startedIn === generation) state = { facts, loadedAt: now() };
  } catch (err) {
    logger.warn(`[company-facts-bank] snapshot refresh failed (code ${err?.code || 'unknown'}); keeping the last copy until it goes stale`);
  }
  return state.facts;
}

/** The approved lines every reader may use right now. SYNC. Empty before the first load and after STALE_MS. */
function getApprovedBankFacts({ now = Date.now() } = {}) {
  if (!state.loadedAt || now - state.loadedAt > STALE_MS) return [];
  return state.facts;
}

/** After an approve or retire in THIS process: drop the copy (fail closed), then reload at once. */
function invalidate(opts = {}) {
  generation += 1;
  state = { facts: Object.freeze([]), loadedAt: 0 };
  return refreshBankFacts(opts);
}

/** Boot hook (scheduler.js, before the GATE_CRON_JOBS return): load now, then every minute. */
function startBankRefresh() {
  if (refreshTimer) return;
  refreshBankFacts().catch(() => {});
  refreshTimer = setInterval(() => { refreshBankFacts().catch(() => {}); }, REFRESH_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

function stopBankRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

module.exports = {
  FactError,
  MAX_FACT_CHARS,
  MAX_ACTIVE_FACTS,
  MAX_SENTENCES,
  REFRESH_MS,
  STALE_MS,
  STATUSES,
  SOURCES,
  checkFactText,
  createDraft,
  editFact,
  restoreAsDraft,
  discardDraft,
  approveFact,
  retireFact,
  listFacts,
  getFact,
  factHistory,
  getApprovedBankFacts,
  refreshBankFacts,
  renderBankFactsLines,
  bankVersionHash,
  invalidate,
  startBankRefresh,
  stopBankRefresh,
  _test: { sha256, normalise, countSentences, loadVerifiedFacts, resetSnapshot: () => { state = { facts: Object.freeze([]), loadedAt: 0 }; generation += 1; lastDropKey = ''; } },
};
