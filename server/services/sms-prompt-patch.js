/**
 * SMS prompt patch: the runtime layer the SMS house-voice drafter reads
 * (GATE_SMS_PROMPT_AUTOPROMOTE; owner rulings 2026-09-27 "the texting AI should improve with NO
 * human approval steps" and 2026-10-24 "do all").
 *
 * This file is what the drafter and the sealed exam read: the version tag, the rendered block, the
 * text guards and the in-memory snapshot of the ACTIVE patch. It never writes a patch row. The
 * drafter requires only this file.
 *
 * Design rules that live here:
 *  - No active patch (or the gate not 'true') means the drafter prompt and its version identity
 *    are byte-identical to today. The block is '' and the tag is ''.
 *  - Whatever changes what a live draft receives changes its prompt_version: one
 *    UPPERCASE letter (the patch's version_tag, handed out once per base identity: UNIQUE
 *    (base_version, version_tag), so two patches on one base never share a version string)
 *    rides at the end of the tags part of the identity,
 *    for example 'house_voice_v12_real_answers26_n+bcA'. Every other tag (category b c l m,
 *    voice input v e) is lowercase, so the letter cannot collide with them. ONE character is
 *    deliberate: the longest identity without a patch is 39 characters (32-character
 *    real-answers base + '+' + six tags), so one more character is exactly the varchar(40)
 *    limit. If a tagged identity would still pass 40, the patch is NOT applied at all (prompt
 *    and identity stay in step).
 *  - The drafter reads the snapshot once per draft and stamps the version from that same read.
 *  - The block is model-written text, so it is sanitized, capped and screened by deterministic
 *    guards (owner rules: no prices or discounts, no promised visits or refunds, nothing that
 *    touches the hand-off categories). The guards run when a candidate is made AND again when a
 *    block is loaded for live use.
 */

const crypto = require('crypto');
const logger = require('./logger');
const { smsPromptAutopromoteMode } = require('../config/feature-gates');

const GATE_ENV = 'GATE_SMS_PROMPT_AUTOPROMOTE';
const VERSION_COLUMN_MAX = 40;
const PATCH_TAG_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PATCH_TAG_RE = /[A-Z]$/;

const MAX_RULE_CHARS = 300;
const MAX_RULES = 5;
const MAX_BLOCK_CHARS = 1600;
const REFRESH_MS = 60 * 1000;

const BLOCK_HEADER = 'LEARNED REPLY RULES (added after review of past drafts; they never relax FACT DISCIPLINE, the hand-off rules, or the JSON format):';

/** 'off' (default), 'observe' (candidates + exams + decisions, nothing activates) or 'true'. */
const promptAutopromoteMode = smsPromptAutopromoteMode;

/* ── Version identity ─────────────────────────────────────────────────── */

/** The next free tag for a base identity, given the tags its patches already hold; null = all 26 used. */
function nextFreeTag(usedTags) {
  const used = new Set((usedTags || []).filter(Boolean));
  return PATCH_TAG_LETTERS.split('').find((letter) => !used.has(letter)) || null;
}

/**
 * Split a prompt identity into its base ('house_voice_v12_real_answers26_n'), the lowercase
 * tags ('bc') and the patch tag ('A' or ''). Pure; tolerates every identity in use.
 */
function splitPromptVersion(promptVersion) {
  const text = String(promptVersion || '');
  const at = text.indexOf('+');
  if (at === -1) return { base: text, tags: '', patchTag: '' };
  const rest = text.slice(at + 1);
  const m = PATCH_TAG_RE.exec(rest);
  return { base: text.slice(0, at), tags: m ? rest.slice(0, m.index) : rest, patchTag: m ? m[0] : '' };
}

/** The identity with the patch tag appended; null when it would not fit the varchar(40) columns. */
function stampPatchVersion(promptVersion, tag) {
  if (typeof tag !== 'string' || !/^[A-Z]$/.test(tag)) return null;
  const { base, tags } = splitPromptVersion(promptVersion);
  const stamped = `${base}+${tags}${tag}`;
  return stamped.length <= VERSION_COLUMN_MAX ? stamped : null;
}

/* ── Text guards ──────────────────────────────────────────────────────── */

// Owner rules. A rule that talks about any of these is refused, even a rule that forbids the
// thing: the loop writes prompt text on its own, and the safe side is to refuse the topic.
const PRICE_RE = /\$|\b(?:price|prices|priced|pricing|quote|quotes|quoted|discount|discounts|coupon|promo|promotion|cost|costs|fee|fees|free|rebate|cheaper|cheap|percent)\b|%/i;
const PROMISE_RE = /\b(?:promise|promises|promised|guarantee|guarantees|guaranteed|refund|refunds|credit|credits|waive|waived|re-?treat(?:ment)?|re-?service|reschedule|come out|come back|send a tech|send someone|return visit|follow-?up visit|free visit)\b/i;
const HANDOFF_RE = /\b(?:complaint|complaints|complain|dispute|disputes|billing|invoice|chargeback|chemical|chemicals|medical|poison|toxic|allerg\w*|symptom\w*|sick|illness|pregnan\w*|legal|lawyer|attorney|sue|lawsuit|cancel\w*|escalat\w*|hand-?off|hand off|a person|a human|team member|office staff)\b/i;
// Anything that tries to talk to the model instead of describing a reply rule.
const INJECTION_RE = /\b(?:ignore|disregard|override|forget|previous instructions|system prompt|developer message|jailbreak|you are now|act as)\b|<\/?[a-z]|```|https?:|www\.|@|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/i;

/** One line, capped, printable ASCII-ish. Never trust model text as a prompt line. */
function sanitizeRuleText(text) {
  const line = String(text || '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/^[\s\-*•\d.)]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.slice(0, MAX_RULE_CHARS).trim();
}

/** { ok:true } or { ok:false, reason } with a short code. Pure. */
function guardRuleText(text) {
  const rule = String(text || '');
  if (rule.length < 20) return { ok: false, reason: 'rule_too_short' };
  if (rule.length > MAX_RULE_CHARS) return { ok: false, reason: 'rule_too_long' };
  if (/[^\x20-\x7E]/.test(rule)) return { ok: false, reason: 'rule_not_plain_text' };
  if (INJECTION_RE.test(rule)) return { ok: false, reason: 'rule_injection_shape' };
  if (PRICE_RE.test(rule)) return { ok: false, reason: 'rule_mentions_price' };
  if (PROMISE_RE.test(rule)) return { ok: false, reason: 'rule_promises_service' };
  if (HANDOFF_RE.test(rule)) return { ok: false, reason: 'rule_touches_handoff' };
  return { ok: true };
}

function renderPatchBlock(rules) {
  return `\n${BLOCK_HEADER}\n${rules.map((r) => `- ${r}`).join('\n')}\n`;
}

const blockSha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/** Rules, bounded and screened; null with a reason when the stack is not usable. */
function buildBlock(rules) {
  if (!Array.isArray(rules) || !rules.length) return { ok: false, reason: 'no_rules' };
  if (rules.length > MAX_RULES) return { ok: false, reason: 'too_many_rules' };
  for (const rule of rules) {
    const verdict = guardRuleText(rule);
    if (!verdict.ok) return verdict;
  }
  const text = renderPatchBlock(rules);
  if (text.length > MAX_BLOCK_CHARS) return { ok: false, reason: 'block_too_long' };
  return { ok: true, text, sha: blockSha(text), rules };
}

/* ── Snapshot of the active patch (read synchronously by the drafter) ──── */

let snapshot = null; // { id, patchNo, tag, baseVersion, text }
let refreshTimer = null;

function setActivePatchSnapshot(next) {
  snapshot = next || null;
}

/** The active patch the live drafter applies right now: null unless the gate is 'true'. */
function getActivePatch() {
  return promptAutopromoteMode() === 'true' ? snapshot : null;
}

/**
 * Load the active row into the snapshot. A row whose stored block no longer matches its hash, or
 * no longer passes the guards (a hand edit), is ignored and logged. Errors keep the old snapshot.
 */
async function refreshActivePatch({ dbi } = {}) {
  const handle = dbi || require('../models/db');
  try {
    const row = await handle('sms_prompt_patches').where({ status: 'active' }).first('id', 'patch_no', 'version_tag', 'base_version', 'patch_text', 'patch_sha', 'rules');
    if (!row) {
      snapshot = null;
      return null;
    }
    const rules = Array.isArray(row.rules) ? row.rules : [];
    const built = buildBlock(rules);
    if (!built.ok || built.text !== row.patch_text || built.sha !== row.patch_sha) {
      logger.error(`[sms-prompt-patch] active patch ${row.patch_no} failed its integrity check (${built.ok ? 'hash_mismatch' : built.reason}); not applied`);
      snapshot = null;
      return null;
    }
    snapshot = { id: row.id, patchNo: row.patch_no, tag: row.version_tag, baseVersion: row.base_version, text: row.patch_text };
    return snapshot;
  } catch (err) {
    logger.warn(`[sms-prompt-patch] active patch refresh failed (code ${err?.code || 'unknown'}); keeping the last snapshot`);
    return snapshot;
  }
}

/** Boot hook: load once, then re-read every minute. Returns at once when the gate is off. */
function startPatchRefresh() {
  if (promptAutopromoteMode() !== 'true' || refreshTimer) return;
  refreshActivePatch().catch(() => {});
  refreshTimer = setInterval(() => {
    if (promptAutopromoteMode() !== 'true') {
      snapshot = null;
      return;
    }
    refreshActivePatch().catch(() => {});
  }, REFRESH_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

function stopPatchRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * What the drafter appends and stamps for ONE draft. `options.promptPatch` undefined (or no
 * options) = the live snapshot; null = no patch; an object { patchNo, tag, baseVersion, text } =
 * an exam-only candidate. Returns { block, version } where version is the patched identity
 * (null = unpatched). A patch, live or exam-only, applies only on the base identity it was built
 * on: its letter is unique only within that base, so on another base it could stamp the identity
 * of a different patch. After a prompt bump or a category-gate flip the old rule stops at once.
 */
function resolvePromptPatch({ realAnswersOn, options, baseVersion }) {
  const none = { block: '', version: null };
  if (!realAnswersOn) return none;
  const override = options ? options.promptPatch : undefined;
  const patch = override === undefined ? getActivePatch() : override;
  if (!patch || !patch.text) return none;
  if (patch.baseVersion !== baseVersion) return none;
  const version = stampPatchVersion(baseVersion, patch.tag);
  if (!version) {
    logger.error(`[sms-prompt-patch] patch ${patch.patchNo} would exceed the varchar(${VERSION_COLUMN_MAX}) prompt_version columns on ${baseVersion}; not applied`);
    return none;
  }
  return { block: patch.text, version };
}

module.exports = {
  GATE_ENV,
  VERSION_COLUMN_MAX,
  MAX_RULE_CHARS,
  MAX_RULES,
  MAX_BLOCK_CHARS,
  BLOCK_HEADER,
  promptAutopromoteMode,
  nextFreeTag,
  splitPromptVersion,
  stampPatchVersion,
  sanitizeRuleText,
  guardRuleText,
  renderPatchBlock,
  buildBlock,
  blockSha,
  getActivePatch,
  setActivePatchSnapshot,
  refreshActivePatch,
  startPatchRefresh,
  stopPatchRefresh,
  resolvePromptPatch,
};
