/**
 * Re-service answers (step S2a of the consolidated re-service report, owner
 * 2026-11-02, GATE_RESERVICE_ASKS).
 *
 * The tech answers each thing the customer told us (the items
 * services/reservice-asks.js gathers) on the Fast Complete sheet. This module
 * is the pure half the /complete route uses: it checks the posted answers and
 * builds the block that freezes onto the service record. No DB, no clock.
 *
 * Answer kinds:
 *   treated      products the tech used for it (ids must be on this completion)
 *   checked_none the tech looked and found nothing
 *   noted        the tech saw it and noted it
 *   not_today    not done today; the reason is for the office, never the customer
 *   hidden       the tech hid the ask from the customer's report
 *   answered     one free sentence the customer will read
 */
// The COMPLETE report-copy screen (AGENTS.md), never the findBannedCustomerCopy subset: a typed answer prints on the
// customer's report, so a bare "safe", bare "infestation" or a gate code must stop here.
const { customerCopyViolations } = require('./service-report/technician-report-copy');

const MAX_ANSWERS = 20;
const MAX_ITEM_ID_CHARS = 120;
const MAX_REASON_CHARS = 160;
const MAX_TEXT_CHARS = 200;
const MAX_PRODUCT_IDS = 20;
const ANSWER_KINDS = Object.freeze(['treated', 'checked_none', 'noted', 'not_today', 'hidden', 'answered']);
// 2: items from an account with several properties carry `accountWide` (reservice-asks.js). A version-1 freeze has no
// such marker, so the customer's report never reads it (reservice-asks-report.js).
const FREEZE_VERSION = 2;

const URL_RE = /\b(?:https?:\/\/|www\.)\S*/i;
// Seven or more digits with only spaces, dots, dashes or brackets between them.
const PHONE_RE = /\d(?:[\s().+-]*\d){6,}/;

const fail = (error) => ({ ok: false, error });
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

function productIdSet(productIds) {
  const list = productIds instanceof Set ? [...productIds] : (Array.isArray(productIds) ? productIds : []);
  return new Set(list.filter((id) => id != null && id !== '').map(String));
}

function checkTreated(entry, allowedIds) {
  const raw = entry.productIds;
  if (!Array.isArray(raw) || !raw.length) return fail('Pick the product you used for each item marked treated.');
  if (raw.length > MAX_PRODUCT_IDS) return fail('Too many products on one item.');
  const ids = [];
  for (const id of raw) {
    const key = id == null ? '' : String(id).trim();
    if (!key || !allowedIds.has(key)) return fail('A product on an answer is not one of the products on this visit.');
    if (!ids.includes(key)) ids.push(key);
  }
  return { ok: true, value: { productIds: ids } };
}

function checkNotToday(entry) {
  const reason = trimmed(entry.reason);
  if (!reason) return fail('Say why an item was not done today.');
  if (reason.length > MAX_REASON_CHARS) return fail(`Keep the reason to ${MAX_REASON_CHARS} characters or fewer.`);
  return { ok: true, value: { reason } };
}

function checkAnswered(entry) {
  const text = trimmed(entry.text);
  if (!text) return fail('Write the sentence the customer will read.');
  if (text.length > MAX_TEXT_CHARS) return fail(`Keep the answer to ${MAX_TEXT_CHARS} characters or fewer.`);
  if (URL_RE.test(text)) return fail('Leave web links out of the answer.');
  if (PHONE_RE.test(text)) return fail('Leave phone numbers out of the answer.');
  if (customerCopyViolations(text).length) return fail('That wording cannot go to a customer. Rewrite the answer.');
  return { ok: true, value: { text } };
}

function checkEntry(entry, allowedIds, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('An answer is not readable.');
  const itemId = trimmed(entry.itemId);
  if (!itemId || itemId.length > MAX_ITEM_ID_CHARS) return fail('An answer does not name its item.');
  if (seen.has(itemId)) return fail('An item has more than one answer.');
  if (!ANSWER_KINDS.includes(entry.answer)) return fail('An answer is not one of the allowed kinds.');
  let extra = { ok: true, value: {} };
  if (entry.answer === 'treated') extra = checkTreated(entry, allowedIds);
  else if (entry.answer === 'not_today') extra = checkNotToday(entry);
  else if (entry.answer === 'answered') extra = checkAnswered(entry);
  if (!extra.ok) return extra;
  return { ok: true, value: { itemId, answer: entry.answer, ...extra.value } };
}

/**
 * @param {*} raw the posted `reserviceAnswers` body field
 * @param {{ productIds?: Array|Set }} opts the completion's own product ids
 * @returns {{ ok: true, answers: object[] } | { ok: false, error: string }}
 */
function validateReserviceAnswers(raw, { productIds } = {}) {
  if (raw == null) return { ok: true, answers: [] };
  if (typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.items)) {
    return fail('The answers are not readable.');
  }
  if (raw.items.length > MAX_ANSWERS) return fail(`Too many answers (${MAX_ANSWERS} is the most).`);
  const allowedIds = productIdSet(productIds);
  const seen = new Set();
  const answers = [];
  for (const entry of raw.items) {
    const checked = checkEntry(entry, allowedIds, seen);
    if (!checked.ok) return checked;
    seen.add(checked.value.itemId);
    answers.push(checked.value);
  }
  return { ok: true, answers };
}

/**
 * The block that freezes onto the service record: what the customer told us
 * (every gathered item, answered or not) and what the tech answered. Answers
 * for an id the gather did not return are dropped. A not_today reason is an
 * office note and lives apart from the answers a customer report may read.
 *
 * @returns {{ freeze: object, dropped: number }}
 */
function buildReserviceAsksFreeze({ gathered, answers, gatheredAt } = {}) {
  const items = Array.isArray(gathered?.items) ? gathered.items : [];
  const known = new Set(items.map((item) => item?.id));
  const kept = {};
  const officeNotes = {};
  let dropped = 0;
  for (const entry of Array.isArray(answers) ? answers : []) {
    if (!known.has(entry.itemId)) {
      dropped += 1;
      continue;
    }
    const slot = { answer: entry.answer };
    if (entry.productIds) slot.productIds = entry.productIds;
    if (entry.text) slot.text = entry.text;
    kept[entry.itemId] = slot;
    if (entry.answer === 'not_today' && entry.reason) officeNotes[entry.itemId] = entry.reason;
  }
  const stamp = gatheredAt instanceof Date ? gatheredAt.toISOString() : (gatheredAt ?? null);
  return {
    freeze: {
      version: FREEZE_VERSION,
      gatheredAt: stamp,
      lane: gathered?.lane ?? null,
      // The customer's words print on their report, so each item carries the complete screen's verdict: a line that
      // fails it ("is the spray safe for my cat?") stays on the record for the office and never prints as written.
      items: items.map((item) => ({ ...item, printable: customerCopyViolations(item?.text).length === 0 })),
      answers: kept,
      officeNotes,
    },
    dropped,
  };
}

module.exports = {
  validateReserviceAnswers,
  buildReserviceAsksFreeze,
  ANSWER_KINDS,
  MAX_ANSWERS,
  MAX_REASON_CHARS,
  MAX_TEXT_CHARS,
};
