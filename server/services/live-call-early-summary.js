'use strict';

/**
 * Early call summary from the live text (GATE_CALL_EARLY_SUMMARY, dark; owner 2026-11-16 "ok build all, use haiku").
 * The approved plan: "The summary starts from the live text when the call ends. The recording still makes the final
 * transcript."
 *
 * When Twilio reports transcription-stopped (the call ended), this module waits a few seconds for the last
 * utterances to land, asks Claude Haiku 5.5 for a short summary of the call's live text, and saves it as
 * call_log.metadata.live_transcription.early_summary. The Calls tab shows it under the call at once; when the
 * recording pipeline writes the call's own summary, the tab shows that one instead.
 *
 * It never writes call_summary, ai_extraction, transcription or call_commitments: those feed the AI context, lead
 * synopses and customer texts, so they come only from the recording pipeline. One run per call (a compare-and-swap
 * on early_summary_claimed_at). A card-number quarantine (live-call-transcription.js purgeLiveUtterances) deletes the
 * live text and then this summary, and a summary is saved only while that text still exists, so a quarantined call
 * keeps neither. Fire and forget: nothing here throws or delays the webhook's 200.
 *
 * Spend: one Haiku call per call that had live text (well under a cent each), so the gate is the owner's flip.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { ledgerCall } = require('./llm-dispatch-metrics');
const { anthropicText } = require('./llm/call');
const { anthropicMaxTokens, anthropicEffortConfig } = require('./llm/anthropic-wire');
const { scrubPans } = require('../utils/pan-scrub');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
// Twilio can post the call's last utterances a moment after transcription-stopped.
const SETTLE_MS = 3000;
const MIN_UTTERANCES = 3;
// A long call keeps its opening (why they called) and its end (what was agreed).
const HEAD_CHARS = 2000;
const TAIL_CHARS = 6000;
const MAX_SUMMARY_CHARS = 600;

const SYSTEM_PROMPT = `You summarize a finished phone call to Waves, a pest control company, for the office staff. "Caller:" is the customer or prospect. "Agent:" is the Waves staff member. The text is a live machine transcript, so some words may be wrong.
Write 2 or 3 plain sentences in English, even when the call was in Spanish: what the caller wanted, what was agreed or done, and the next step if one was named. Use only what the text says; do not guess. Never include card numbers, account numbers or security codes.
Reply with ONLY the summary.`;

const gateOn = () => require('../config/feature-gates').isEnabled('callEarlySummary');

function mergeLiveState(patch) {
  return db.raw(
    "jsonb_set(metadata, '{live_transcription}', (metadata -> 'live_transcription') || ?::jsonb, true)",
    [JSON.stringify(patch)],
  );
}

// Claims the call's one run: of two stopped events, one UPDATE matches. A call the recording pipeline already
// processed (ai_extraction set) is skipped: its own summary is there.
async function claim(callSid, now) {
  const won = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereNull('ai_extraction')
    .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
    .whereRaw("(metadata -> 'live_transcription' ->> 'early_summary_claimed_at') IS NULL")
    .update({ metadata: mergeLiveState({ early_summary_claimed_at: now.toISOString() }) });
  return won > 0;
}

// The call's live text in spoken order, one "Caller:" / "Agent:" line per utterance.
async function transcriptFor(callSid) {
  const rows = await db('call_live_utterances')
    .where('call_sid', callSid)
    .orderBy([{ column: 'spoken_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select('speaker', 'text');
  const lines = (rows || [])
    .filter((r) => typeof r?.text === 'string' && r.text.trim())
    .map((r) => `${r.speaker === 'caller' ? 'Caller' : 'Agent'}: ${r.text.trim()}`);
  const text = lines.join('\n');
  const body = text.length <= HEAD_CHARS + TAIL_CHARS
    ? text
    : `${text.slice(0, HEAD_CHARS)}\n[…]\n${text.slice(-TAIL_CHARS)}`;
  return { text: body, utterances: lines.length };
}

// One paragraph, card numbers masked, control characters gone, cut at a word.
function cleanSummary(text) {
  const plain = scrubPans(String(text || ''))
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  if (plain.length <= MAX_SUMMARY_CHARS) return plain;
  const cut = plain.slice(0, MAX_SUMMARY_CHARS);
  const end = cut.lastIndexOf(' ');
  return `${(end > MAX_SUMMARY_CHARS / 2 ? cut.slice(0, end) : cut).trim()}…`;
}

// The summary text, or null (no key, refusal, a reply cut by the token cap, an API error). Never throws.
async function summarize(transcript) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30 * 1000, maxRetries: 0 });
    const response = await ledgerCall('anthropic', MODELS.LIVE_CALL, () => client.messages.create({
      model: MODELS.LIVE_CALL,
      ...anthropicEffortConfig(MODELS.LIVE_CALL),
      // Haiku 5.5 thinks by default and the thinking spends from this cap, so it is not sized to the reply alone.
      max_tokens: anthropicMaxTokens(MODELS.LIVE_CALL, 2048),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
    }), { laneId: 'live_call_early_summary' });
    if (response?.stop_reason === 'refusal' || response?.stop_reason === 'max_tokens') return null;
    return cleanSummary(anthropicText(response));
  } catch (err) {
    logger.warn(`[live-call-early-summary] summarize failed: ${err?.status || err?.name || 'error'}`);
    return null;
  }
}

// Saved only while the call is not quarantined and its live text still exists. A quarantine stamps quarantined_at,
// deletes the text and drops the summary in one transaction; a save waiting on that row lock is re-checked against
// the stamped row, so a summary that finishes during or after a quarantine is never saved.
async function saveSummary(callSid, summary, now) {
  const saved = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
    .whereRaw("(metadata -> 'live_transcription' ->> 'quarantined_at') IS NULL")
    .whereRaw('EXISTS (SELECT 1 FROM call_live_utterances WHERE call_sid = ?)', [callSid])
    .update({ metadata: mergeLiveState({ early_summary: { text: summary, at: now.toISOString(), model: MODELS.LIVE_CALL } }) });
  return saved > 0;
}

/**
 * Summarize one ended call's live text. Resolves { written, reason }; never throws.
 */
async function writeEarlySummary(callSid, { now = () => new Date() } = {}) {
  try {
    if (!gateOn()) return { written: false, reason: 'gate_off' };
    if (!CALL_SID_RE.test(String(callSid || ''))) return { written: false, reason: 'bad_call_sid' };
    if (!(await claim(callSid, now()))) return { written: false, reason: 'not_claimed' };
    const { text, utterances } = await transcriptFor(callSid);
    if (utterances < MIN_UTTERANCES) return { written: false, reason: 'too_short' };
    const summary = await summarize(text);
    if (!summary) return { written: false, reason: 'no_summary' };
    return { written: await saveSummary(callSid, summary, now()), reason: null };
  } catch (err) {
    logger.warn(`[live-call-early-summary] failed: ${err?.code || err?.name || 'error'}`);
    return { written: false, reason: 'error' };
  }
}

// Fire and forget, after a short wait so the call's last utterances are stored. A restart in that wait loses only
// the early summary; the recording pipeline's summary still comes.
function afterCallStopped(callSid, { settleMs = SETTLE_MS } = {}) {
  const timer = setTimeout(() => { writeEarlySummary(callSid).catch(() => {}); }, settleMs);
  if (typeof timer?.unref === 'function') timer.unref();
}

module.exports = { afterCallStopped, writeEarlySummary, _test: { cleanSummary, transcriptFor, SETTLE_MS, HEAD_CHARS, TAIL_CHARS } };
