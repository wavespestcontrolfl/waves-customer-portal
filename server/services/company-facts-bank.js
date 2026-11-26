'use strict';

/**
 * Company facts bank (owner 2026-11-25 "all rec"): owner-approved lines the agents may state beside the code lines
 * in COMPANY_FACTS (services/sms-company-facts.js). The DB row is the source of truth, the opposite of
 * knowledge_base mirroring code. PR 1: the writer, the checks and the runtime snapshot. Readers: the voice agent (relay-conversation buildBasePrompt, per call) and email
 * drafts (email-actions companyFactsSystemEntry, per draft); texting comes later. An empty bank changes nothing, so there is
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
const BANK_LOCK_KEY = 'company_facts_bank_approve';
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
// https: and www. forms, or any host name: dot-separated labels ending in a 2 to 24 letter suffix (all lower or all upper case, so
// "ok.Then" is not one), not part of a longer word or an email. "e.g.", "a.m.", "U.S." and "3.5" have no such suffix.
const LINK_RE = /\bhttps?:|\bwww\.|(?<![\w@.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:[a-z]{2,24}|[A-Z]{2,24})(?![A-Za-z0-9-])/;
const HANDLE_RE = /(?:^|\s)[@#]\w+/;
// Any currency symbol, a USD code before or after a number ("USD 99", "99 USD", "usd99"), or an amount written in words.
const MONEY_RE = /[$€£¥]|(?<![a-z])usd(?![a-z])|\b(?:dollars?|bucks|cents?)\b/i;
const PERCENT_RE = /%|\bper ?cent\b/i;
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;
// A sentence ends at . ! or ? followed by white space, whatever letter case comes next. Not a boundary: after a dotted abbreviation
// ("a.m.", "e.g.", "i.e.", "U.S.") or a common title or short word ("Mr.", "Dr.", "vs.", "approx.").
const SENTENCE_END_RE = /(?<=[.!?])\s+/;
const ABBREVIATION_END_RE = /(?:\b[a-z]\.){2,}$|\b(?:mr|mrs|ms|dr|vs|approx|inc)\.$/i;

// Pesticide safety and "natural" claims (AGENTS.md compliance language). The SMS screen (SMS_COMPLIANCE_CLAIM_RE) only reads "safe"
// near a treatment word, so "We use safe pesticides" slipped past it; the bank refuses the claim anywhere, as the owner ruled
// ("safe" is a hard block).
const SAFETY_CLAIM_RE = /\bsafe(?:r|st|ly)?\b|\bnon[\s-]?toxic\b|\bharmless\b|\ball[\s-]?natural\b|\b(?:no|zero|without)\s+(?:harsh\s+|harmful\s+)?(?:chemicals?|toxins?|pesticides?)\b|\b(?:chemical|toxin|poison|pesticide)[\s-]?free\b|\b(?:eco|environmentally|child|kid|pet|family)[\s-]?friendly\b|\b(?:organic|green)\s+(?:pest|treatment|product|spray)/i;

// number_in_fact: a bank fact states NO amount at all (owner: facts state no prices, counts, measures or times; the agents read them as
// policy, and every attempt to tell a price from a count by wording kept leaking). So the text may hold no digit of any script (any
// Unicode decimal digit or other number character: fullwidth, Arabic-Indic, superscripts, vulgar fractions such as a half sign) and no
// number word: zero to nineteen, the tens, hundred, thousand, million, billion, dozen, couple, and the multiplying or fraction words
// half/halves, quarter(s), every fraction denominator (third(s) but not "third-party", fourth ... twelfth, tenths, hundredth), twice, thrice,
// double, triple, quadruple, and the named clock times noon, midday, midnight and o'clock. NO exception for clock times:
// "Office opens at nine a.m." blocks (intended; the owner rewords). "Quarterly", "monthly", "weekly", "once", "first" and "second" are
// not numbers. "Prices" and "rates" are not numbers either: the screens for those words are the soft warnings.
const UNIT_WORD = 'one|two|three|four|five|six|seven|eight|nine';
const TEEN_WORD = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
// Fraction denominators and large ordinals ("a fifth", "one-eighth", "tenths", "hundredth"): "first" and "second" are not among them.
const DENOMINATOR_WORD = "(?:fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|(?:thir|four|fif|six|seven|eigh|nine)teenth|(?:twen|thir|for|fif|six|seven|eigh|nine)tieth|hundredth|thousandth|millionth)s?";
const NUMBER_WORD_RE = new RegExp(`\\b(?:zero|${UNIT_WORD}|${TEEN_WORD}|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|couple|half|halves|quarters?|thirds?(?![-\\s]party\\b)|${DENOMINATOR_WORD}|twice|thrice|double|triple|quadruple|noon|noontime|midday|midnight|o'?clock)\\b`, 'gi');
const NUMBER_CHAR_RE = /\p{N}/u; // decimal digits (Nd), letter numbers such as Roman numeral characters (Nl), other numbers (No)
// "one" passes only in these fixed phrases: "one of", "one another", "no one", "one-time", "one-off". ("anyone", "someone" and "everyone"
// never match \b one \b.) Every other "one" counts, so "every one business day", "each one visit" and "this one" block (intended).
const ONE_PRONOUN_AFTER_RE = /^(?:\s+(?:of|another)\b|-(?:time|off)\b)/i;
const ONE_PRONOUN_BEFORE_RE = /\bno\s+$/i;

/** True when the text states an amount: any digit or number character, or any number word. */
function hasNumberInFact(text) {
  const plain = String(text);
  if (NUMBER_CHAR_RE.test(plain)) return true;
  for (const m of plain.matchAll(NUMBER_WORD_RE)) {
    const pronoun = m[0].toLowerCase() === 'one'
      && (ONE_PRONOUN_AFTER_RE.test(plain.slice(m.index + 3)) || ONE_PRONOUN_BEFORE_RE.test(plain.slice(0, m.index)));
    if (!pronoun) return true;
  }
  return false;
}

// [code, regex]: each is a hard block on its own.
const SHAPE_BLOCKS = Object.freeze([
  ['line_break', LINE_BREAK_RE],
  ['dollar_amount', MONEY_RE],
  ['percent', PERCENT_RE],
  ['phone_number', PHONE_RE],
  ['email_address', EMAIL_RE],
  ['link', LINK_RE],
  ['handle', HANDLE_RE],
  ['safety_claim', SAFETY_CLAIM_RE],
]);

// Distinctive coined brand words of the catalog's products. A brand is also refused by its full catalog name, but a name's first
// word is NOT an alias by default: several are ordinary words ("Advance Termite Bait Station", "Demand CS", "Drive XLR8") and a line
// like "book in advance" must pass. Add a word here when a new coined brand joins products_catalog.
const BRAND_ALIASES = Object.freeze([
  'acelepryn', 'advion', 'anuew', 'artavia', 'atticus', 'azatin', 'bifen', 'bora-care', 'contrac', 'cyzmic', 'dylox', 'espoma',
  'fusilade', 'gentrol', 'gravex', 'hydretain', 'lesco', 'prodiamine', 'sedgehammer', 'sequestar', 'speedzone', 'suffoil', 'talpirid',
  'talstar', 'tekko', 'termidor', 'tetrino', 'topchoice', 'trelona', 'tritek', 'velista', 'dithiopyr', 'fipronil', 'bifenthrin',
].map((word) => word.replace(/-/g, ' ')));

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

/** Sentences of a line: split after . ! ? and white space (any case), but not after a dotted abbreviation. */
function splitSentences(text) {
  const out = [];
  for (const part of String(text).split(SENTENCE_END_RE).filter((piece) => piece.trim())) {
    if (out.length && ABBREVIATION_END_RE.test(out[out.length - 1].trim())) out[out.length - 1] += ` ${part}`;
    else out.push(part);
  }
  return out;
}

function countSentences(text) {
  return splitSentences(text).length;
}

/** The full catalog names (4+ characters, normalised) plus the explicit brand aliases. */
function productTokens(names) {
  const tokens = new Set(BRAND_ALIASES);
  for (const name of names || []) {
    const full = normalise(name);
    if (full.length >= 4) tokens.add(full);
  }
  return tokens;
}

function mentionsProduct(text, tokens) {
  const padded = ` ${normalise(text)} `;
  for (const token of tokens) if (padded.includes(` ${token} `)) return true;
  return false;
}

/**
 * The whole-bank check, as a reader renders the lines one after another. The plain banned-copy screen runs on the full section. The
 * timing guard (rainfast, re-entry, drying) judges a line by the rain, pet and stay-off wording ANYWHERE in the same reply, so it runs on
 * EVERY contiguous run of two or more lines whose joined text stays within the SMS reply limit (2,000 characters; no text over it ever
 * reaches the guard), so a verdict that depends on how much text surrounds a claim cannot be dodged by the choice of window. With the
 * 20-line cap that is at most 190 guard calls. Two lines more than a reply apart are not judged together, since no reply holds both.
 */
const SMS_REPLY_LIMIT = 2000;
function* timingWindows(texts) {
  for (let i = 0; i < texts.length - 1; i += 1) {
    let joined = texts[i];
    for (let j = i + 1; j < texts.length; j += 1) {
      joined += ` ${texts[j]}`;
      if (joined.length > SMS_REPLY_LIMIT) break;
      yield joined;
    }
  }
}
function sectionHasBannedCopy(texts) {
  if (!texts.length) return false;
  if (hasBannedCopy(texts.map((t) => `- ${t}`).join('\n'), { timing: false })) return true;
  for (const window of timingWindows(texts)) if (hasBannedCopy(window)) return true;
  return false;
}

/**
 * hasBannedCustomerCopy from the SMS drafter, loaded on first use, WITH the label-timing guard (rainTimeGuard) and no
 * label evidence: rainfast, re-entry and drying times reach a customer only as visit-specific LABEL FACTS (AGENTS.md), never
 * as a standing company line. Fails closed: a guard that cannot load bans the text.
 * `timing: false` is for the whole-section check only: the timing guard also holds any reply over the 2,000-character SMS reply limit,
 * which is not a limit of the bank (each line is already checked alone, at most 400 characters; the bank holds 20 lines).
 */
function hasBannedCopy(text, { timing = true } = {}) {
  try {
    return require('./sms-shadow-drafter').hasBannedCustomerCopy(text, timing ? { rainTimeGuard: true, labelFactsText: '' } : {}) !== false;
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
  if (hasNumberInFact(text)) blocks.push('number_in_fact');
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

/**
 * The section a reader appends right after the code lines of COMPANY_FACTS: one header line, then `- line` per fact.
 * '' for an empty bank (the reader's prompt or entry is then byte-identical to before). One header for voice and email.
 */
const BANK_SECTION_HEADER = 'More company facts (approved by the owner; state these plainly, same as the company facts above):';
function renderBankFactsSection(facts = getApprovedBankFacts()) {
  const lines = renderBankFactsLines(facts);
  return lines ? `${BANK_SECTION_HEADER}\n${lines}` : '';
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
  const rows = await dbi('company_fact_bank').whereIn('status', statuses).whereNotIn('id', excludeIds.filter(Boolean)).select('fact_text');
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

// `acknowledged` (approve only): the warning codes the owner ticked for. Anything else the screens later find is not acknowledged.
const checkResult = (check, acknowledged = []) => ({ blocks: check.blocks, warnings: check.warnings, acknowledged_warnings: acknowledged, checked_at: new Date().toISOString() });

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
  // `at` is the moment of THIS insert (clock_timestamp), not the transaction's start: events of one transaction, and of transactions that
  // waited on each other's locks, then sort in the order they were written.
  await trx('company_fact_bank_events').insert({ fact_id: factId, action, actor_id: actor.id || null, detail, at: trx.raw('clock_timestamp()') });
}

async function lockFact(trx, id) {
  const row = await trx('company_fact_bank').where({ id }).forUpdate().first();
  if (!row) throw new FactError('NOT_FOUND', 404);
  return row;
}

async function insertDraft(trx, values, actor, { action, detail }) {
  let row;
  try {
    [row] = await trx('company_fact_bank').insert(values).returning('*');
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

async function editDraftRow(trx, row, f, actor) {
  const text = 'factText' in f ? f.factText : row.fact_text;
  // Same exclusions as the approve check: the line this draft replaces is not a duplicate of it.
  const check = checkFactText(text, await loadCheckContext(trx, { excludeIds: [row.id, row.supersedes_id] }));
  const patch = { fact_text: text, text_sha256: sha256(text), check_result: checkResult(check), warnings_acknowledged: false, updated_at: trx.fn.now() };
  if ('topic' in f) patch.topic = f.topic;
  if ('question' in f) patch.question = f.question;
  if ('ownerWords' in f) patch.owner_words = f.ownerWords;
  if ('sourceRef' in f) patch.source_ref = f.sourceRef;
  if ('source' in f) patch.source = f.source; // validated against SOURCES in cleanFields
  let updated;
  try {
    [updated] = await trx('company_fact_bank').where({ id: row.id }).update(patch).returning('*');
  } catch (err) {
    throw mapWriteError(err);
  }
  await addEvent(trx, row.id, 'edited', actor, { text_changed: text !== row.fact_text });
  return updated;
}

async function editApprovedRow(trx, row, f, actor) {
  if (!('factText' in f) || f.factText === row.fact_text) throw new FactError('TEXT_UNCHANGED', 409);
  const pending = await trx('company_fact_bank').where({ supersedes_id: row.id, status: 'draft' }).first('id');
  if (pending) throw new FactError('EDIT_IN_PROGRESS', 409, { draftId: pending.id });
  const check = checkFactText(f.factText, await loadCheckContext(trx, { excludeIds: [row.id] }));
  return insertDraft(trx, {
    topic: 'topic' in f ? f.topic : row.topic,
    question: 'question' in f ? f.question : row.question,
    fact_text: f.factText,
    text_sha256: sha256(f.factText),
    source: 'source' in f ? f.source : row.source,
    source_ref: 'sourceRef' in f ? f.sourceRef : row.source_ref,
    owner_words: 'ownerWords' in f ? f.ownerWords : null,
    check_result: checkResult(check),
    supersedes_id: row.id,
    created_by: actor.id || null,
  }, actor, { action: 'drafted', detail: { supersedes_id: row.id } });
}

/** A draft is edited in place; an approved row is never touched: its edit is a NEW draft that supersedes it. */
/** What the editor (or the discard button) saw when it opened, as sent: { baseTextSha256, baseUpdatedAt, expectStatus }, every part optional. */
function openedState(input) {
  const open = input && typeof input === 'object' ? input : {};
  const given = (key) => open[key] !== undefined && open[key] !== null;
  // A precondition that is sent but malformed is a bad request, never silently ignored (an ignored guard would let the write through).
  if (given('baseTextSha256') && !(typeof open.baseTextSha256 === 'string' && /^[0-9a-f]{64}$/i.test(open.baseTextSha256.trim()))) throw new FactError('INVALID_PRECONDITION', 400);
  if (given('baseUpdatedAt') && !(typeof open.baseUpdatedAt === 'string' && !Number.isNaN(Date.parse(open.baseUpdatedAt)))) throw new FactError('INVALID_PRECONDITION', 400);
  if (given('expectStatus') && !['draft', 'approved'].includes(open.expectStatus)) throw new FactError('INVALID_PRECONDITION', 400);
  return {
    base: given('baseTextSha256') ? open.baseTextSha256.trim().toLowerCase() : '',
    baseUpdatedAt: given('baseUpdatedAt') ? Date.parse(open.baseUpdatedAt) : NaN,
    expectStatus: given('expectStatus') ? open.expectStatus : '',
  };
}

/** Under the row lock: the row must still be the one that was opened. Status first, then the wording, then any other field. */
function assertRowAsOpened(row, { base, baseUpdatedAt, expectStatus }) {
  // A draft that was approved meanwhile is never "edited" into a replacement draft.
  if (expectStatus && expectStatus !== row.status) throw new FactError('STATUS_CHANGED', 409, { status: row.status });
  // The wording it opened: a concurrent edit of the wording is refused, never overwritten.
  if (base && base !== row.text_sha256) throw new FactError('STALE_TEXT', 409);
  // The row as it was when opened (its updated_at, which every write moves; milliseconds, the precision JSON carries): a concurrent edit of
  // any field, such as the owner's words, is refused too.
  if (!Number.isNaN(baseUpdatedAt) && baseUpdatedAt !== new Date(row.updated_at).getTime()) throw new FactError('STALE_FACT', 409);
}

async function editFact(id, patch, actor, { dbi = db } = {}) {
  const f = cleanFields(patch, { requireAll: false });
  const opened = openedState(patch);
  return dbi.transaction(async (trx) => {
    const row = await lockFact(trx, id);
    if (row.status === 'retired') throw new FactError('RETIRED_USE_RESTORE', 409);
    assertRowAsOpened(row, opened);
    return row.status === 'draft' ? editDraftRow(trx, row, f, actor) : editApprovedRow(trx, row, f, actor);
  });
}

/** A retired line returns only as a new draft; the retired row and its history stay. */
async function restoreAsDraft(id, actor, { dbi = db } = {}) {
  return dbi.transaction(async (trx) => {
    const row = await lockFact(trx, id);
    if (row.status !== 'retired') throw new FactError('NOT_RETIRED', 409);
    const check = checkFactText(row.fact_text, await loadCheckContext(trx));
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

/** `baseTextSha256` and `baseUpdatedAt` (what the page showed when Discard was pressed): another admin's newer version is never deleted. */
async function discardDraft(id, actor, { dbi = db, baseTextSha256, baseUpdatedAt } = {}) {
  const opened = openedState({ baseTextSha256, baseUpdatedAt });
  return dbi.transaction(async (trx) => {
    const row = await lockFact(trx, id);
    if (row.status !== 'draft') throw new FactError('NOT_A_DRAFT', 409);
    assertRowAsOpened(row, opened);
    await trx('company_fact_bank').where({ id }).del();
    await addEvent(trx, id, 'discarded', actor, { text_sha256: row.text_sha256 });
    return { id, discarded: true };
  });
}

/* ── Approve and retire ───────────────────────────────────────────────── */

async function approvedTextsExcept(trx, excludeId) {
  const q = trx('company_fact_bank').where({ status: 'approved' }).orderBy('approved_at', 'asc').select('fact_text');
  if (excludeId) q.whereNot('id', excludeId);
  return (await q).map((r) => ({ text: r.fact_text }));
}

/** Every approve-time check, on the server. Throws BLOCKED (with codes) or WARNINGS_NOT_ACKNOWLEDGED. */
async function approveChecks(trx, row, { acknowledgeWarnings, reviewedWarnings = null }) {
  // Other drafts count too, as in the draft check: a case or punctuation variant of this line must be discarded before this one is approved.
  const ctx = await loadCheckContext(trx, { statuses: ['draft', 'approved'], excludeIds: [row.id, row.supersedes_id] });
  const check = checkFactText(row.fact_text, ctx);
  const others = await approvedTextsExcept(trx, row.supersedes_id);
  if (others.length >= MAX_ACTIVE_FACTS) check.blocks.push('bank_full');
  if (!check.blocks.length && sectionHasBannedCopy([...others.map((o) => o.text), row.fact_text])) check.blocks.push('section_banned_copy');
  if (check.blocks.length) throw new FactError('BLOCKED', 422, { blocks: check.blocks, warnings: check.warnings.map((w) => w.code) });
  // A tick covers the warnings the owner saw: one the checks found since (a widened screen, a changed bank) needs its own look.
  const unseen = reviewedWarnings ? check.warnings.some((w) => !reviewedWarnings.includes(w.code)) : false;
  if (check.warnings.length && (!acknowledgeWarnings || unseen)) {
    throw new FactError('WARNINGS_NOT_ACKNOWLEDGED', 409, { warnings: check.warnings });
  }
  return check;
}

async function retireSuperseded(trx, row, actor) {
  if (!row.supersedes_id) return null;
  const old = await lockFact(trx, row.supersedes_id);
  // The original was retired after this replacement was drafted: approving it would publish a stale replacement as a standalone line.
  if (old.status !== 'approved') throw new FactError('ORIGINAL_NOT_APPROVED', 409, { originalId: old.id });
  await trx('company_fact_bank').where({ id: old.id }).update({
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
  if (!actor || !actor.isOwner || !actor.id) throw new FactError('OWNER_ONLY', 403);
  const ownerWords = cleanLine(input && input.ownerWords, 500) || null;
  const acknowledgeWarnings = Boolean(input) && input.acknowledgeWarnings === true;
  // Optional: the warning codes the owner was shown and ticked for. When sent, every warning the server finds now must be among them.
  const reviewedWarnings = Array.isArray(input && input.reviewedWarnings) ? input.reviewedWarnings.filter((c) => typeof c === 'string') : null;
  const reviewedSha = input && typeof input.textSha256 === 'string' ? input.textSha256.trim().toLowerCase() : '';
  if (!reviewedSha) throw new FactError('REVIEWED_TEXT_REQUIRED', 400);
  const approved = await dbi.transaction(async (trx) => {
    // One approval at a time bank-wide: the cap and the duplicate compare read the whole approved set, which two
    // concurrent approvals would each see without the other's row. Held to the end of this transaction.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [BANK_LOCK_KEY]);
    const row = await lockFact(trx, id);
    if (row.status !== 'draft') throw new FactError('NOT_A_DRAFT', 409);
    // The owner approves the wording the page showed: an edit since then is refused, never approved under his name.
    // `row` is the row as locked (FOR UPDATE) in this transaction. The hash is computed from its text here, never taken from a stored
    // column: the reviewed hash, the stored hash and the locked text must all agree before anything is retired or approved.
    const lockedSha = sha256(String(row.fact_text || '').trim());
    if (lockedSha !== reviewedSha) throw new FactError('STALE_TEXT', 409);
    if (row.text_sha256 !== lockedSha) throw new FactError('HASH_MISMATCH', 409);
    const check = await approveChecks(trx, row, { acknowledgeWarnings, reviewedWarnings });
    const supersededId = await retireSuperseded(trx, row, actor);
    const [updated] = await trx('company_fact_bank').where({ id }).update({
      status: 'approved',
      approved_by: actor.id || null,
      approved_at: trx.fn.now(),
      owner_words: ownerWords || row.owner_words,
      check_result: checkResult(check, acknowledgeWarnings ? check.warnings.map((w) => w.code) : []),
      warnings_acknowledged: Boolean(check.warnings.length && acknowledgeWarnings),
      updated_at: trx.fn.now(),
    }).returning('*');
    // owner + text_sha256 are what snapshot load trusts: the approval was made by the owner account, for exactly this wording.
    await addEvent(trx, id, 'approved', actor, { superseded_id: supersededId, warnings: check.warnings.map((w) => w.code), owner: true, text_sha256: row.text_sha256 });
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
    const [updated] = await trx('company_fact_bank').where({ id }).update({
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

const MAX_PAGE = 500;
const encodeCursor = (createdAtText, id) => Buffer.from(`${createdAtText}|${id}`).toString('base64url');
// The timestamp as Postgres prints a timestamptz ("2026-11-25 19:07:04.123456+00") and a canonical UUID: anything else is refused here, and a date that fits the shape but not the calendar is refused by Postgres (class 22), which listFacts maps to the same code.
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::?\d{2})?$/;
const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decodeCursor(cursor) {
  const [ts, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  if (!CURSOR_TS_RE.test(ts || '') || !CURSOR_ID_RE.test(id || '')) throw new FactError('INVALID_CURSOR', 400);
  return { ts, id };
}

/**
 * One page of facts, newest first, in a stable (created_at, id) order. `limit` is 1 to 500 (default 500); `cursor` is the
 * `nextCursor` of the previous page. Returns { facts, nextCursor } where nextCursor is null on the last page. The cursor carries
 * the timestamp as the database prints it (microseconds), so no row is skipped or repeated at a page edge.
 */
async function listFacts({ status, limit, cursor } = {}, { dbi = db } = {}) {
  if (status && status !== 'all' && !STATUSES.includes(status)) throw new FactError('INVALID_STATUS', 400);
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || MAX_PAGE, 1), MAX_PAGE);
  const q = dbi('company_fact_bank').select('*', dbi.raw('created_at::text AS cursor_ts')).orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(size + 1);
  if (status && status !== 'all') q.where({ status });
  if (cursor) {
    const at = decodeCursor(cursor);
    q.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [at.ts, at.id]);
  }
  let rows;
  try {
    rows = await q;
  } catch (err) {
    // A cursor the shape checks passed but Postgres refuses (an impossible date): a data exception (class 22) is the caller's cursor, not a fault.
    if (cursor && String(err && err.code).startsWith('22')) throw new FactError('INVALID_CURSOR', 400);
    throw err;
  }
  const page = rows.slice(0, size);
  const last = rows.length > size ? page[page.length - 1] : null;
  const facts = page.map(({ cursor_ts: _cursorTs, ...fact }) => fact);
  return { facts, nextCursor: last ? encodeCursor(last.cursor_ts, last.id) : null };
}

async function getFact(id, { dbi = db } = {}) {
  const row = await dbi('company_fact_bank').where({ id }).first();
  if (!row) throw new FactError('NOT_FOUND', 404);
  return row;
}

/** Every event of one fact, oldest first. Also answers for a discarded draft (events outlive the row). */
async function factHistory(id, { dbi = db } = {}) {
  return dbi('company_fact_bank_events as e').leftJoin('technicians as t', 't.id', 'e.actor_id').where('e.fact_id', id)
    .orderBy([{ column: 'e.at', order: 'asc' }, { column: 'e.id', order: 'asc' }]).select('e.*', 't.name as actor_name');
}

/* ── Snapshot ─────────────────────────────────────────────────────────── */

let state = { facts: Object.freeze([]), loadedAt: 0 };
// Every wording the owner ever approved (approved now, or retired after approval), by text hash, with the windows it was live: not a list of live lines. See getEverApprovedHashes.
let approvedHashes = { map: new Map(), loadedAt: 0 };
let generation = 0;
let startedReads = 0; // refreshes started, in order
let appliedRead = 0; // the newest-started read whose result is in `state`
let refreshTimer = null;
let lazyStartInTests = false; // test hook: Jest skips the lazy start unless a test turns it on
let stopped = false; // stopBankRefresh() ran: a later read does not start the refresh again
let lastDropKey = '';

/**
 * The owner approvals in the history: Map of fact id -> list of { actor, sha } from 'approved' events that record owner === true
 * and the text hash that was approved (approveFact writes both, after checking actor.isOwner).
 */
async function readApprovers(dbi, ids) {
  const approvers = new Map();
  if (!ids.length) return approvers;
  const events = await dbi('company_fact_bank_events').where({ action: 'approved' }).whereIn('fact_id', ids).select('fact_id', 'actor_id', 'detail');
  for (const e of events) {
    const detail = e.detail && typeof e.detail === 'object' ? e.detail : {};
    if (detail.owner !== true) continue;
    if (!approvers.has(e.fact_id)) approvers.set(e.fact_id, []);
    approvers.get(e.fact_id).push({ actor: e.actor_id, sha: detail.text_sha256 });
  }
  return approvers;
}

/**
 * Every wording with an OWNER approval event, whatever became of the row afterwards (still approved, retired, replaced): a Map of text_sha256
 * -> windows [from, to] in epoch ms, `to` null while the line is live. A window opens at an owner 'approved' event and closes at that fact's next
 * 'retired' event (events are append-only, so the map only grows and a window only closes). A stored texting draft carries its bank section as
 * plain text; the map lets its readers accept a parsed line only when it is exact owner wording AND the owner had approved it by the time the
 * draft was built (see wasApprovedAt), so a line retired long before cannot be revived by a section forged into a newer draft.
 */
async function readEverApprovedHashes(dbi) {
  const events = await dbi('company_fact_bank_events').whereIn('action', ['approved', 'retired']).select('fact_id', 'action', 'detail', 'at');
  const ms = (at) => { const t = at == null ? 0 : new Date(at).getTime(); return Number.isFinite(t) ? t : 0; };
  const byFact = new Map();
  for (const e of events) {
    if (!byFact.has(e.fact_id)) byFact.set(e.fact_id, []);
    byFact.get(e.fact_id).push(e);
  }
  const out = new Map();
  for (const list of byFact.values()) {
    list.sort((x, y) => ms(x.at) - ms(y.at));
    let open = null;
    for (const e of list) {
      const detail = e.detail && typeof e.detail === 'object' ? e.detail : {};
      if (e.action === 'retired') {
        if (open) open[1] = ms(e.at);
        open = null;
      } else if (detail.owner === true && typeof detail.text_sha256 === 'string' && /^[0-9a-f]{64}$/.test(detail.text_sha256)) {
        if (!out.has(detail.text_sha256)) out.set(detail.text_sha256, []);
        open = [ms(e.at), null];
        out.get(detail.text_sha256).push(open);
      }
    }
  }
  return out;
}

/** True when the owner ticked for every warning code the screens find today (the acknowledgement stored with the approval). */
function warningsCovered(row, warnings) {
  if (row.warnings_acknowledged !== true) return false;
  const acked = row.check_result && Array.isArray(row.check_result.acknowledged_warnings) ? row.check_result.acknowledged_warnings : [];
  return warnings.every((w) => acked.includes(w.code));
}

/** Why a stored approved row must not be served, or '' when it may be. Codes only. */
function loadProblem(row, check, approvers) {
  if (row.text_sha256 !== sha256(String(row.fact_text || '').trim())) return 'hash_mismatch';
  // Provenance: a named approver, an approval time, and an OWNER approval event in the history by that same person for this exact wording
  // (an import, or a row and event written by a non-owner, has none).
  const ownerApproved = (approvers.get(row.id) || []).some((a) => a.actor === row.approved_by && a.sha === row.text_sha256);
  if (!row.approved_by || !row.approved_at || !ownerApproved) return 'no_approval_record';
  if (check.blocks.length) return check.blocks.join('+');
  // Warning words need the owner's tick; a row without it (written around the service, or newly matched by a widened screen) is not served.
  if (check.warnings.length > 0 && !warningsCovered(row, check.warnings)) return 'warnings_not_acknowledged';
  return '';
}

/** The approved rows that still pass every hard block and carry their approval, in approval order, at most MAX_ACTIVE_FACTS. */
async function verifyApprovedRows(dbi) {
  const rows = await dbi('company_fact_bank').where({ status: 'approved' }).orderBy([{ column: 'approved_at', order: 'asc' }, { column: 'id', order: 'asc' }]).select('*');
  const base = await loadCheckContext(dbi, { statuses: [], excludeIds: [] });
  const approvers = await readApprovers(dbi, rows.map((r) => r.id));
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const row of rows) {
    const problem = loadProblem(row, checkFactText(row.fact_text, { ...base, bankKeys: seen }), approvers) || (kept.length >= MAX_ACTIVE_FACTS ? 'bank_full' : '');
    if (problem) {
      dropped.push(`${row.id}:${problem}`);
      continue;
    }
    seen.add(normalise(row.fact_text));
    kept.push(Object.freeze({ id: row.id, topic: row.topic, text: row.fact_text.trim(), sha: row.text_sha256, approvedAt: row.approved_at }));
  }
  // The whole ordered list, as a reader renders it: lines that pass alone can fail together once a retire changes which lines sit side by side.
  if (kept.length && sectionHasBannedCopy(kept.map((f) => f.text))) {
    dropped.push('section:section_banned_copy');
    kept.length = 0;
  }
  const dropKey = dropped.join(',');
  if (dropKey && dropKey !== lastDropKey) logger.error(`[company-facts-bank] approved rows dropped at load (codes only): ${dropKey}`);
  lastDropKey = dropKey;
  return { kept: Object.freeze(kept), consideredIds: rows.map((r) => r.id) };
}

const loadVerifiedFacts = async (dbi) => (await verifyApprovedRows(dbi)).kept;

/**
 * Reload the snapshot. A failed read keeps the last copy (it ages out after STALE_MS). A read is applied only when no
 * invalidate() ran since it started AND no read that started after it has already been applied, so a slow read can never
 * put back a line a newer read (or a retire) removed. The copy's age counts from when its read STARTED.
 */
async function refreshBankFacts({ dbi = db, now = Date.now } = {}) {
  const startedIn = generation;
  startedReads += 1;
  const myRead = startedReads;
  const startedAt = now();
  try {
    const facts = await loadVerifiedFacts(dbi);
    const everApproved = await readEverApprovedHashes(dbi);
    if (startedIn === generation && myRead > appliedRead) {
      appliedRead = myRead;
      state = { facts, loadedAt: startedAt };
      approvedHashes = { map: everApproved, loadedAt: startedAt };
    }
  } catch (err) {
    logger.warn(`[company-facts-bank] snapshot refresh failed (code ${err?.code || 'unknown'}); keeping the last copy until it goes stale`);
  }
  // Through the age-checked getter: a failed read must not hand a caller a copy past its five minutes.
  return freshFacts(now());
}

/**
 * A fresh, verified read of the approved rows (what a snapshot load would keep), without touching the snapshot. Throws when the read fails.
 * Answers { facts, consideredIds } from ONE read: every approved row it looked at, and the ones it kept.
 */
const readVerifiedFacts = async ({ dbi = db } = {}) => {
  const { kept, consideredIds } = await verifyApprovedRows(dbi);
  return { facts: kept, consideredIds };
};

// The age-checked copy, with no side effect: what refreshBankFacts hands back and what getApprovedBankFacts serves.
function freshFacts(now) {
  if (!state.loadedAt || now - state.loadedAt > STALE_MS) return [];
  return state.facts;
}

/**
 * Every wording the owner ever approved, as a Map of sha256(trimmed text) -> live windows. SYNC, same age rule as the snapshot: empty before
 * the first load and after STALE_MS (fail closed: nothing is then recognized as owner wording). A retire closes a window but never removes
 * the hash, so a stored draft that carries a since-retired line still reads it as owner wording. An invalidate() keeps the map (it only grows).
 */
function getEverApprovedHashes({ now = Date.now() } = {}) {
  if (!approvedHashes.loadedAt || now - approvedHashes.loadedAt > STALE_MS) return new Map();
  return approvedHashes.map;
}

/**
 * True when the owner approved this wording (hash) at or before `at` and had not retired it more than STALE_MS before `at` (a process may
 * render a line from a snapshot up to STALE_MS old, so a draft built just after a retire still carries it). `at` defaults to now: a reader
 * with no draft time accepts only a line that is live now. `at: 'any'` skips the time (a size or topic check that grants nothing).
 */
function wasApprovedAt(sha, at = Date.now(), opts = {}) {
  const windows = getEverApprovedHashes(opts).get(sha);
  if (!windows) return false;
  if (at === 'any') return true;
  const t = at instanceof Date ? at.getTime() : Number(at);
  return Number.isFinite(t) && windows.some(([from, to]) => t >= from && (to === null || t < to + STALE_MS));
}

/**
 * The approved lines every reader may use right now. SYNC. Empty before the first load and after STALE_MS.
 * The first read in a process that never started the refresh (managed dev, a process without the scheduler) starts it, once:
 * that read still returns [] and never waits for the load, so a call or a draft is never held up. Jest skips this unless a test turns it on.
 */
function getApprovedBankFacts({ now = Date.now() } = {}) {
  if (!refreshTimer && !stopped && (process.env.NODE_ENV !== 'test' || lazyStartInTests)) startBankRefresh();
  return freshFacts(now);
}

/** After an approve or retire in THIS process: drop the copy (fail closed), then reload at once. */
function invalidate(opts = {}) {
  generation += 1;
  state = { facts: Object.freeze([]), loadedAt: 0 };
  return refreshBankFacts(opts);
}

/** Boot hook (scheduler.js, before the GATE_CRON_JOBS return): load now, then every minute. Idempotent; a first read starts it too. */
function startBankRefresh() {
  if (refreshTimer) return;
  stopped = false;
  refreshBankFacts().catch(() => {});
  refreshTimer = setInterval(() => { refreshBankFacts().catch(() => {}); }, REFRESH_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

function stopBankRefresh() {
  stopped = true;
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
  BANK_SECTION_HEADER,
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
  getEverApprovedHashes,
  wasApprovedAt,
  readVerifiedFacts,
  refreshBankFacts,
  renderBankFactsLines,
  renderBankFactsSection,
  bankVersionHash,
  invalidate,
  startBankRefresh,
  stopBankRefresh,
  _test: { setLazyStart: (on) => { lazyStartInTests = on === true; }, sha256, normalise, countSentences, sectionHasBannedCopy, hasNumberInFact, loadVerifiedFacts, resetSnapshot: () => { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; stopped = false; state = { facts: Object.freeze([]), loadedAt: 0 }; approvedHashes = { map: new Map(), loadedAt: 0 }; generation += 1; appliedRead = 0; lastDropKey = ''; } },
};
