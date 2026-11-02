// client/src/lib/fast-complete-reservice-asks.js
//
// The pure rules of the "They told us" block on the re-service Fast Complete sheets (step S2b of the
// consolidated re-service report, owner 2026-11-02, GATE_RESERVICE_ASKS): how an item is labeled and worded,
// which answers it offers, when an answer is complete, and the `reserviceAnswers` body field.
// The server's rules are server/services/reservice-answers.js; this file mirrors its length, web-link and
// phone rules so the tech sees a problem before Complete. The server's copy screen is NOT mirrored: a wording
// it refuses comes back as a 400 (`reservice_answer_invalid`) that the sheet shows like any /complete refusal.
import { formatETDate } from './timezone';

export const MAX_ANSWER_TEXT = 200;
export const MAX_REASON_TEXT = 160;
export const ASKS_HOLD = 'Answer each item in They told us.';
// The report flow's report step, where the block is not on screen: the hold says where to go.
export const ASKS_HOLD_REPORT_STEP = 'Go back to the visit and answer each item in They told us.';
export const ASKS_LOADING_HOLD = 'Loading what the customer told us…';
export const ASKS_LOAD_FAILED = 'Could not load what the customer told us.';
export const NEEDS_PRODUCT_HINT = 'Add the product first.';

export const SOURCE_LABELS = Object.freeze({
  request_form: 'Request form',
  text: 'Text',
  call: 'Call',
  office: 'Office',
  email: 'Email',
});

// Chip labels, in the order they show. `hidden` is the server's word for "Not about this visit".
export const PROBLEM_ANSWERS = Object.freeze([
  { answer: 'treated', label: 'Treated' },
  { answer: 'checked_none', label: 'Checked, none found' },
  { answer: 'noted', label: 'Noted' },
  { answer: 'not_today', label: 'Not today' },
  { answer: 'hidden', label: 'Not about this visit' },
]);
export const NOT_ABOUT_ANSWER = Object.freeze({ answer: 'hidden', label: 'Not about this visit' });

// The same two patterns the server uses (server/services/reservice-answers.js).
const URL_RE = /\b(?:https?:\/\/|www\.)\S*/i;
const PHONE_RE = /\d(?:[\s().+-]*\d){6,}/;

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// The response's items, keeping only the ones the block can draw and answer (an id and words).
export function asksItemsFrom(data) {
  const list = Array.isArray(data?.items) ? data.items : [];
  const seen = new Set();
  const items = [];
  for (const raw of list) {
    const id = clean(raw?.id);
    const text = clean(raw?.text);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      source: String(raw.source || ''),
      at: raw.at || null,
      text,
      quoted: raw.quoted === true,
      lead: clean(raw.lead) || null,
      kind: raw.kind === 'question' ? 'question' : 'problem',
      pests: (Array.isArray(raw.pests) ? raw.pests : []).map(clean).filter(Boolean),
    });
  }
  return items;
}

// `They told us · 4 items`; no items, no eyebrow.
export function asksEyebrow(count) {
  if (!(count > 0)) return '';
  return `They told us · ${count} ${count === 1 ? 'item' : 'items'}`;
}

// `Text · Oct 6`, or `Question · Oct 6` for a question; the date is the Eastern calendar day.
export function itemLabel(item) {
  const day = item?.at ? formatETDate(item.at, { month: 'short', day: 'numeric' }) : '';
  const name = item?.kind === 'question' ? 'Question' : (SOURCE_LABELS[item?.source] || 'Message');
  return day && day !== 'Invalid Date' ? `${name} · ${day}` : name;
}

// The words the tech reads: a quoted item in quotation marks, a lead before the words.
export function itemWords(item) {
  const text = clean(item?.text);
  const words = item?.quoted ? `“${text}”` : text;
  return item?.lead ? `${item.lead} ${words}` : words;
}

// A typed answer's problem in plain words, or ''. Mirrors the server's length, link and phone rules.
export function answerTextProblem(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.length > MAX_ANSWER_TEXT) return `Keep the answer to ${MAX_ANSWER_TEXT} characters or fewer.`;
  if (URL_RE.test(text)) return 'Leave web links out of the answer.';
  if (PHONE_RE.test(text)) return 'Leave phone numbers out of the answer.';
  return '';
}

export function reasonProblem(value) {
  return clean(value).length > MAX_REASON_TEXT ? `Keep the reason to ${MAX_REASON_TEXT} characters or fewer.` : '';
}

// ── Product choices for "Treated" ───────────────────────────────────────────

const singular = (word) => word.replace(/ies$/, 'y').replace(/(s|x|ch|sh|o)es$/, '$1').replace(/([^s])s$/, '$1');
const wordsOf = (value) => String(value || '').toLowerCase().split(/[^a-z]+/).filter(Boolean).map(singular);

// Hint words for a sheet row: its name, its category, and any targets the row or its catalog entry names.
function rowHints(row) {
  const product = row?.product || {};
  const lists = [row?.targets, row?.otherTargets, product.targets, product.target_pests, product.targetPests, product.pests];
  const strings = [row?.name, product.name, product.category, product.product_category];
  for (const list of lists) {
    if (Array.isArray(list)) strings.push(...list);
    else if (typeof list === 'string') strings.push(list);
  }
  return strings.filter((value) => typeof value === 'string' && value.trim());
}

// The choices "Treated" offers: the sheet's product rows that are on the completion (active), as { id, name, hints }.
export function productChoicesFrom(rows) {
  const seen = new Set();
  const choices = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.active === false || row.productId == null || row.productId === '') continue;
    const id = String(row.productId);
    if (seen.has(id)) continue;
    seen.add(id);
    choices.push({ id, name: String(row.name || row.product?.name || 'Product'), hints: rowHints(row) });
  }
  return choices;
}

// Does a pest name (`Spiders`, `German roaches`) match a product by its name, category or targets? The words of
// one side must run together inside the other ("spider" in "Spider and mite control"); plural and singular match alike.
const runsInside = (needle, hay) => needle.length > 0 && hay.some((_, at) => needle.every((word, i) => hay[at + i] === word));
function hintMatches(pest, hint) {
  const a = wordsOf(pest);
  const b = wordsOf(hint);
  return runsInside(a, b) || runsInside(b, a);
}

export function choiceMatchesPests(choice, pests) {
  const list = Array.isArray(pests) ? pests : [];
  return list.some((pest) => choice.hints.some((hint) => hintMatches(pest, hint)));
}

// The item's pest matches first, then the rest in sheet order. Every row is always offered: a row that
// matches nothing is still a product the tech may have used for it.
export function orderedChoices(choices, pests) {
  const matched = choices.filter((choice) => choiceMatchesPests(choice, pests));
  return [...matched, ...choices.filter((choice) => !matched.includes(choice))];
}

// ── Answers ─────────────────────────────────────────────────────────────────

// An answer is { answer, productIds: [], reason: '', text: '' }. Rows removed from the sheet drop out of it.
export function prunedAnswer(answer, availableIds) {
  if (!answer || !Array.isArray(answer.productIds)) return answer;
  const keep = answer.productIds.filter((id) => availableIds.has(String(id)));
  return keep.length === answer.productIds.length ? answer : { ...answer, productIds: keep };
}

// Is this item's answer ready to send?
export function answerIsComplete(answer, availableIds) {
  if (!answer?.answer) return false;
  if (answer.answer === 'treated') {
    return Array.isArray(answer.productIds) && answer.productIds.some((id) => availableIds.has(String(id)));
  }
  if (answer.answer === 'not_today') {
    const reason = clean(answer.reason);
    return !!reason && !reasonProblem(reason);
  }
  if (answer.answer === 'answered') {
    const text = clean(answer.text);
    return !!text && !answerTextProblem(text);
  }
  return ['checked_none', 'noted', 'hidden'].includes(answer.answer);
}

// Complete is held while any item is unanswered, with the words that say so. '' = nothing held.
export function asksHold({ items, answers, availableIds }) {
  if (!items.length) return '';
  return items.every((item) => answerIsComplete(prunedAnswer(answers[item.id], availableIds), availableIds)) ? '' : ASKS_HOLD;
}

// The `reserviceAnswers` body field, or {} when nothing is to be sent (no items loaded).
export function reserviceAnswersField({ items, answers, availableIds }) {
  if (!items.length) return {};
  const sent = [];
  for (const item of items) {
    const answer = prunedAnswer(answers[item.id], availableIds);
    if (!answerIsComplete(answer, availableIds)) continue;
    const entry = { itemId: item.id, answer: answer.answer };
    if (answer.answer === 'treated') {
      entry.productIds = answer.productIds.map(String).filter((id) => availableIds.has(id));
    } else if (answer.answer === 'not_today') {
      entry.reason = clean(answer.reason);
    } else if (answer.answer === 'answered') {
      entry.text = clean(answer.text);
    }
    sent.push(entry);
  }
  return sent.length ? { reserviceAnswers: { items: sent } } : {};
}
