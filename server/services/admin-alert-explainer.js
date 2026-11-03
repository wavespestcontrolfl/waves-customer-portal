'use strict';

// "What to do" (owner 2026-11-02, GATE_ALERT_EXPLAINER): "I want the show full text to be a brief description that I
// can understand ... what actual things I need to do ... if it's a customer, the customer needs to be named."
//
// Hundreds of emitters write admin rows, and a long body is cut into `detail` word for word, so "Show full text" used to
// read back raw check output. This module writes one plain-words summary per row instead: what happened, one to three
// steps, and who fixes it (the owner, or Claude for engineering work). An AI writes it from the row's own text and the
// customer's name (read from the database by admin-alert-customer.js, never guessed) the first time an admin opens it;
// it is kept on the row (notifications.explainer) for the content version it was written from, so the next open is
// instant and a row whose text changes gets a new one. Internal, admin-only copy: TEXT_POLICIES.routineAnswer (lane
// alert_explainer). When both providers fail the caller gets a summary built from the row's own words, never a blank,
// and nothing is saved, so the next open asks again. Sends nothing to anyone and changes nothing but the summary.
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const NotificationService = require('./notification-service');
const { customersForAlerts } = require('./admin-alert-customer');
const { cutAtWord, firstSentence } = require('./admin-alert-compose');
const { stripEmoji } = require('../utils/strip-emoji');
const { formatETDayDate, formatETTime } = require('../utils/datetime-et');

const STORE_VERSION = 1; // shape of notifications.explainer; a stored summary of another shape reads as none
const PROMPT_VERSION = 'alert-explainer-v1';
const HAPPENED_MAX = 300;
const STEP_MAX = 160;
const MAX_STEPS = 3;
const MAX_FULL_TEXT_CHARS = 4000;
const FIXERS = ['you', 'claude'];
// A who the emitter stamped decides the fixer; an unstamped row is the model's read.
const STAMPED_FIXER = { person: 'you', claude: 'claude' };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['happened', 'steps', 'fixer'],
  properties: {
    happened: { type: 'string', description: 'One or two short sentences: what happened and why it matters.' },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'One to three concrete steps, in the order to do them, each starting with a verb.',
    },
    fixer: { type: 'string', enum: FIXERS },
  },
};

const SYSTEM = `You explain one alert from the admin portal of Waves, a family-owned pest control and lawn care company in Southwest Florida. The owner reads your answer on a phone between jobs, so it must be short and in plain words.

Answer with JSON: happened, steps, fixer.
- happened: one or two short sentences. Say what happened and why it matters, as you would tell a busy owner.
- steps: one to three concrete steps, in the order to do them. Each starts with a verb and names the person and the record to open, for example "Open Jane Doe's lawn plan and remove the extra visit".
- fixer: "claude" when the fix is engineering work that needs no decision from the owner and no contact with a customer: a code bug, a broken check or sync, a broken link between records, a data repair in the database. Otherwise "you". When it is "claude", the first step is "Nothing for you: Claude can fix this." and the next steps say what Claude should fix.

Rules:
- Use the customer's name when one is given. Never invent a name, number, date, amount or fact that the alert does not state.
- No ids, codes, table or column names, file names, setting names, check names or timestamps. Say what they mean instead.
- Keep counts and amounts the alert states.
- If the alert does not say enough to know what to do, the step says what to look at.
- Never tell the owner to text, email or call a customer unless the alert itself asks for that.`;

const clean = (value, max) => {
  const text = (stripEmoji(String(value ?? '')) || '').replace(/\s+/g, ' ').trim();
  return text ? cutAtWord(text, max) : '';
};

const metaOf = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
};

// The parts of a model answer the bell shows, or null when it is not usable.
function parseExplainer(json) {
  if (!json || typeof json !== 'object') return null;
  const happened = clean(json.happened, HAPPENED_MAX);
  const steps = (Array.isArray(json.steps) ? json.steps : []).map((s) => clean(s, STEP_MAX)).filter(Boolean).slice(0, MAX_STEPS);
  const fixer = FIXERS.includes(json.fixer) ? json.fixer : null;
  return happened && steps.length && fixer ? { happened, steps, fixer } : null;
}

// The page a link opens, without its ids ("/admin/customers"): the model names the page, never the id.
const pageOf = (link) => String(link || '').split(/[?#]/)[0] || '';

// An alert's words with phone numbers, emails and street addresses masked, as every bell body is (the registry's
// redactor, read at call time), line breaks kept. The customer's name is the one detail the summary needs.
const redacted = (text) => require('./notification-triggers').__private.redactSensitiveText(String(text || '').trim());

function promptText(row, customer) {
  const meta = metaOf(row.metadata);
  const createdAt = row.created_at ? new Date(row.created_at) : null;
  const raised = createdAt && !Number.isNaN(createdAt.getTime()) ? `${formatETDayDate(createdAt)} at ${formatETTime(createdAt)}` : '';
  const stamped = STAMPED_FIXER[meta.who];
  const fullText = redacted(row.detail);
  return [
    `Headline: ${redacted(row.title)}`,
    `Short text: ${redacted(row.body) || '(none)'}`,
    `Full text:\n${fullText ? fullText.slice(0, MAX_FULL_TEXT_CHARS) : '(none)'}`,
    `Customer: ${customer?.name || 'none named'}`,
    `Page it opens: ${pageOf(row.link) || '(none)'}`,
    `Kind: ${row.category || 'unknown'}${meta.area ? `, area ${meta.area}` : ''}`,
    raised ? `Raised: ${raised}` : null,
    stamped ? `The system marks this alert as work for ${stamped === 'claude' ? 'Claude: answer fixer "claude"' : 'the owner: answer fixer "you"'}.` : null,
  ].filter(Boolean).join('\n');
}

// A summary from the row's own words, for when no model answered: the short text (or the first sentence of the full
// text), and where to look.
function fallbackExplainer(row) {
  const meta = metaOf(row.metadata);
  const happened = clean(row.body || firstSentence(String(row.detail || '').split('\n').find((l) => l.trim()) || '') || row.title, HAPPENED_MAX);
  const steps = [row.link ? 'Tap the alert to open the record it is about.' : 'Read the original text below.'];
  return { happened, steps, fixer: STAMPED_FIXER[meta.who] || 'you', fallback: true };
}

// What the bell shows from a stored summary, or null when it is missing, of another shape, or written for other text.
function servedExplainer(stored, version) {
  const s = metaOf(stored);
  if (s.v !== STORE_VERSION || !version || s.version !== version) return null;
  return parseExplainer(s);
}

async function writeExplainer(row, customer) {
  const { dispatchWithFallback } = require('./llm/call');
  const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.routineAnswer, {
    laneId: 'alert_explainer',
    promptVersion: PROMPT_VERSION,
    system: SYSTEM,
    text: promptText(row, customer),
    jsonMode: true,
    jsonSchema: SCHEMA,
    maxTokens: 700,
    timeoutMs: 30_000,
  }, { validate: (result) => (parseExplainer(result?.json) ? null : 'invalid_explainer'), reserveFallbackBudget: true });
  const parsed = response?.ok ? parseExplainer(response.json) : null;
  if (!parsed) return null;
  const stamped = STAMPED_FIXER[metaOf(row.metadata).who];
  const shown = { ...parsed, fixer: stamped || parsed.fixer };
  try {
    await NotificationService.saveAdminExplainer(row.id, row.version, {
      v: STORE_VERSION, version: row.version, ...shown,
      provider: response.provider || null, model: response.model || null, at: new Date().toISOString(),
    });
  } catch (err) {
    // The error code only: a database error's message carries the summary, and the summary names the customer.
    logger.warn(`[alert-explainer] summary not saved: ${NotificationService.safeErrorSummary(err)}`);
  }
  return shown;
}

// One write at a time per row and text: a double tap, or two admins opening the same alert, share one model call.
const inflight = new Map();
// A write that failed is not tried again for a minute: during a provider outage each open serves the alert's own
// words at once instead of paying for, and waiting on, another failing call.
const FAILURE_COOLDOWN_MS = 60_000;
const recentFailures = new Map(); // `${id}:${version}` -> when the write failed

function coolingDown(key, now) {
  for (const [k, at] of recentFailures) if (now - at >= FAILURE_COOLDOWN_MS) recentFailures.delete(k);
  return recentFailures.has(key);
}

// The bell's "What to do" for one admin row: { status, body }. 404 when the row is gone or out of the caller's scope.
// body: { explainer: { happened, steps, fixer, fallback? }, customer: { id, name } | null, version }. `version` is the
// content version the summary was written for: the bell shows and keeps it only on a row it holds at that version, so a
// summary of text that changed meanwhile (a refresh during the model call, whose save the version fence refused) never
// lands on the newer text.
async function explainAdminAlert(id, { role, technicianId = null } = {}) {
  const row = await NotificationService.getAdminNotificationForExplainer(id, { role, technicianId });
  if (!row) return { status: 404, body: { error: 'not_found' } };
  const customer = (await customersForAlerts(db, [row])).get(String(row.id)) || null;
  const answer = (explainer) => ({ status: 200, body: { explainer, customer, version: row.version } });
  const cached = servedExplainer(row.explainer, row.version);
  if (cached) return answer(cached);

  const key = `${row.id}:${row.version}`;
  if (!inflight.has(key) && coolingDown(key, Date.now())) return answer(fallbackExplainer(row));
  if (!inflight.has(key)) {
    inflight.set(key, writeExplainer(row, customer)
      .catch((err) => { logger.warn(`[alert-explainer] model read failed: ${NotificationService.safeErrorSummary(err)}`); return null; })
      .then((shown) => { if (!shown) recentFailures.set(key, Date.now()); return shown; })
      .finally(() => inflight.delete(key)));
  }
  return answer((await inflight.get(key)) || fallbackExplainer(row));
}

// GATE_ALERT_EXPLAINER, read at call time; a missing or throwing reader reads as off.
function explainerLive() {
  try { return require('../config/feature-gates').alertExplainerLive?.() === true; } catch { return false; }
}

// The bell list's persisted rows with what "What to do" needs, for the admin role while the gate is on: the customer
// an alert names (`customer`), that the row can be explained (`explainable`) and its saved summary when it was written
// for the text shown (`explainer`). The "Send to Claude" mark (`sendToClaude`) is not here: it needs no explainer gate,
// so the list route adds it for every admin row (withSendToClaudeFields, admin-alert-send-to-claude.js). The stored
// column itself never leaves the server. Never throws: a failed name read serves the rows without names.
async function withExplainerFields(rows, { role } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const bare = list.map(({ explainer: _stored, ...row }) => row);
  if (!list.length || role !== 'admin' || !explainerLive()) return bare;
  let customers = new Map();
  try { customers = await customersForAlerts(db, list); } catch (err) { logger.warn(`[alert-explainer] names not read: ${NotificationService.safeErrorSummary(err)}`); }
  return bare.map((row, i) => {
    const customer = customers.get(String(row.id));
    const explainer = servedExplainer(list[i].explainer, row.version);
    return { ...row, explainable: true, ...(customer ? { customer } : {}), ...(explainer ? { explainer } : {}) };
  });
}

module.exports = {
  explainAdminAlert,
  explainerLive,
  withExplainerFields,
  servedExplainer,
  _private: { parseExplainer, promptText, fallbackExplainer, recentFailures, FAILURE_COOLDOWN_MS, SCHEMA, SYSTEM, STORE_VERSION },
};
