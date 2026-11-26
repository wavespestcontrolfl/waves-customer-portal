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
 * The same one Haiku call also returns the office's next step, what the staff member promised the caller, and the
 * words of one phone alert (owner 2026-11-26 "build both", no new gate: it rides this one). They are saved beside the
 * text as early_summary { text, next_step, promises, alert_title, alert_line, at, model }; the Calls tab keeps showing
 * the next step and the promises after the recording pipeline's summary replaces the text. When a staff member who is
 * not the owner took the call (forward_acceptance names someone but not ADAM_PHONE), the saved summary raises ONE
 * admin alert (category live_call_next_step, one per call). A failed alert never undoes the saved summary.
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
const { raiseAdminAlert, cutAtWord, breaksAlertRules, MAX_WHY_CHARS, MAX_HEADLINE_CHARS } = require('./admin-alert-compose');
const { staffAnswered, staffNameOf } = require('./live-call-upset-alert');

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
const MAX_NEXT_STEP_CHARS = 90;
const MAX_PROMISES = 4;
const MAX_PROMISE_CHARS = 120;
const MAX_ALERT_TITLE_CHARS = 45;
const MAX_ALERT_LINE_CHARS = 80;

const SYSTEM_PROMPT = `You read a finished phone call to Waves, a pest control company, for the office staff. "Caller:" is the customer or prospect. "Agent:" is the Waves staff member. The text is a live machine transcript, so some words may be wrong.
Write in English, even when the call was in Spanish. Use only what the text says; do not guess. Never include card numbers, account numbers or security codes.
Reply with ONLY this JSON object, no code fence:
{"summary": "<2 or 3 plain sentences: what the caller wanted, what was agreed or done, and the next step if one was named>",
"next_step": "<one plain sentence, ${MAX_NEXT_STEP_CHARS} characters or fewer, starting with a verb: what the office should do next; null if nothing is left to do>",
"promises": [<at most ${MAX_PROMISES} exact word-for-word quotes, copied from one Agent line, of something the Agent promised the caller, such as "I'll text you the quote in a few minutes."; [] if none>],
"alert_title": "<${MAX_ALERT_TITLE_CHARS} characters or fewer, starts lower case, verb first, such as "text Dana E. a roach quote"; the caller's first name and last initial only if said; null when next_step is null>",
"alert_line": "<ONE sentence, ${MAX_ALERT_LINE_CHARS} characters or fewer: who called, what they want, what was promised; no exclamation mark, no dates, no codes>"}`;

const gateOn = () => require('../config/feature-gates').isEnabled('callEarlySummary');

function mergeLiveState(patch) {
  return db.raw(
    "jsonb_set(metadata, '{live_transcription}', (metadata -> 'live_transcription') || ?::jsonb, true)",
    [JSON.stringify(patch)],
  );
}

// The call's live text is in card-number quarantine: the live-text module's one rule (quarantined_at, or the
// recording scrub's transcription_metadata.pan_detected, which can land before its purge runs). Required lazily:
// that module requires this one from its stopped-event hook.
const notQuarantinedSql = () => `NOT ${require('./live-call-transcription').QUARANTINE_WHERE_SQL}`;

// Claims the call's one run: of two stopped events, one UPDATE matches. A call the recording pipeline already
// processed (ai_extraction set) is skipped: its own summary is there. A quarantined call is never claimed.
async function claim(callSid, now) {
  const won = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereNull('ai_extraction')
    .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
    .whereRaw(notQuarantinedSql())
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
function cleanText(text, max, ellipsis = true) {
  const plain = scrubPans(typeof text === 'string' ? text : '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain || /^(?:null|none|n\/a)$/i.test(plain)) return null;
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = cut.lastIndexOf(' ');
  return `${(end > max / 2 ? cut.slice(0, end) : cut).trim()}${ellipsis ? '…' : ''}`;
}
const cleanSummary = (text) => cleanText(text, MAX_SUMMARY_CHARS);

// What the model returned, as { summary, next_step, promises, alert_title, alert_line } with every string cleaned
// and capped, or null when there is no summary. A reply in a code fence still parses; a bare-text reply is the
// summary alone; a reply that looks like JSON but does not parse is no summary (raw braces never reach the office).
function parseReply(raw) {
  const plain = String(raw || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  let obj = null;
  try { obj = JSON.parse(plain.slice(plain.indexOf('{'), plain.lastIndexOf('}') + 1)); } catch { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const text = plain.startsWith('{') ? null : cleanSummary(plain);
    return text ? { summary: text, next_step: null, promises: [], alert_title: null, alert_line: null } : null;
  }
  const summary = cleanSummary(obj.summary);
  if (!summary) return null;
  const nextStep = cleanText(obj.next_step, MAX_NEXT_STEP_CHARS);
  return {
    summary,
    next_step: nextStep,
    promises: (Array.isArray(obj.promises) ? obj.promises : []).map((p) => cleanText(p, MAX_PROMISE_CHARS)).filter(Boolean).slice(0, MAX_PROMISES),
    // Screened whole, then cut (bannerWords): a title or line that fails is null, so the alert uses fixed copy.
    alert_title: nextStep ? cleanText(bannerWords(cleanText(obj.alert_title, 1000, false)), MAX_ALERT_TITLE_CHARS, false) : null,
    alert_line: cleanText(bannerWords(cleanText(obj.alert_line, 1000, false)), MAX_ALERT_LINE_CHARS, false),
  };
}

// The parsed reply (see parseReply), or null (no key, refusal, a reply cut by the token cap, an API error). Never throws.
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
    return parseReply(anthropicText(response));
  } catch (err) {
    logger.warn(`[live-call-early-summary] summarize failed: ${err?.status || err?.name || 'error'}`);
    return null;
  }
}

// Re-read right before the model call: a card number the recording scrub flagged after the claim keeps the text
// from the model. true = quarantined (or the row is gone).
async function quarantinedNow(callSid) {
  const row = await db('call_log').where('twilio_call_sid', callSid).whereRaw(notQuarantinedSql()).first('id');
  return !row;
}

// Saved only while the call is not quarantined and its live text still exists. A quarantine stamps quarantined_at,
// deletes the text and drops the summary in one transaction; a save waiting on that row lock is re-checked against
// the stamped row, so a summary that finishes during or after a quarantine is never saved. The recording scrub's
// pan_detected flag, which can land before that purge runs, blocks the save too.
async function saveSummary(callSid, { summary, ...extras }, now) {
  const saved = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
    .whereRaw(notQuarantinedSql())
    .whereRaw('EXISTS (SELECT 1 FROM call_live_utterances WHERE call_sid = ?)', [callSid])
    .update({ metadata: mergeLiveState({ early_summary: { text: summary, ...extras, at: now.toISOString(), model: MODELS.LIVE_CALL } }) });
  return saved > 0;
}

// The alert's why: the staff name, then the model's one-line account of the call (or the summary's first sentence),
// cut to the 110-character budget. A line the notification rules refuse (a second sentence, a date, a code) is
// skipped for the next one; the last resort is a fixed line.
// Words that may go on a lock screen, judged on the WHOLE model text before any cut (a cut can drop the word "gate"
// and leave the code): names redacted as every alert does, and none at all when the text holds an access code (gate,
// door, alarm), a card number, a security code, an SSN, or any run of 3+ digits (a code with no keyword, a phone
// number, an address number). Those fall back to fixed copy; the details stay on the Calls tab behind the login.
const DIGIT_RUN_RE = /\d(?:[\s.-]?\d){2,}/;
function bannerWords(words) {
  const { redactedWords } = require('./admin-alert-names');
  const plain = redactedWords(words);
  if (!plain || DIGIT_RUN_RE.test(plain)) return '';
  const { redactAccessCodes } = require('./context-aggregator');
  return redactAccessCodes(plain) === plain && scrubPans(plain) === plain ? plain : '';
}

// The alert's why: the staff name, then the model's one-line account of the call when the whole line may go on a
// lock screen, cut to the 110-character budget; else a fixed line.
function whyFor(name, reply) {
  const lead = `${name || 'The office'}'s call: `;
  const why = reply.alert_line ? `${lead}${cutAtWord(reply.alert_line, MAX_WHY_CHARS - lead.length)}` : '';
  return why && !breaksAlertRules(why) ? why : `${lead.trim().replace(/:$/, '')} just ended.`;
}

// The alert's action (the bell title after "Comms — "): the model's title, or a fixed line when it breaks the rules.
function actionFor(name, reply) {
  const room = MAX_HEADLINE_CHARS - 'Comms — '.length;
  const title = reply.alert_title ? cutAtWord(reply.alert_title, room) : '';
  return title && !breaksAlertRules(title) ? title : `read ${name || 'the office'}'s call summary`;
}

// Why a call raises no office-call alert, or null when it may. A phone banner cannot be taken back, so:
// - only a known staff number that is not the owner's (an unknown answerer is not proof);
// - no warm transfer, ever tried on the call (a second staff member on the same Agent track: the name would be wrong;
//   the transfers count stays after a later hold replaces the transfer state);
// - no card talk anywhere in the live text (every utterance, not the head and tail the model read): a card-pause
//   stamp, a masked card number or card words. Those are the calls a later card-number quarantine can clear.
async function officeAlertBlock(conn, callSid, meta) {
  if (!staffAnswered(meta?.forward_acceptance)) return 'not_staff';
  const hold = meta?.conference_path?.hold;
  if (hold?.transfer || Number(hold?.transfers) > 0) return 'transfer';
  if (meta?.live_transcription?.card_pause) return 'card';
  const { isCardIntent } = require('./live-call-card-pause');
  const rows = await conn('call_live_utterances').where('call_sid', callSid).select('text', 'pan_masked');
  return (rows || []).some((r) => isCardIntent(r.text, r.pan_masked)) ? 'card' : null;
}

// ONE admin alert per call answered by a staff member who is not the owner (see officeAlertBlock). A needs-you row
// when the call left a next step, else an FYI row. A quarantined call raises nothing: the insert runs under the purge's
// lock after a re-check, and a purge after it deletes the row. Never throws: the saved summary stands.
async function alertOfficeCall(callSid, reply) {
  try {
    await db.transaction(async (trx) => {
      // The lock the live-text writer and the purge share (live-call-transcription.js): every check below reads the
      // call as it stands under it, so a late card utterance or a quarantine either lands first (and blocks) or waits
      // for this commit (and the purge then deletes the row). The banner sends only after the commit.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`call_live_utterances:${callSid}`]);
      const call = await trx('call_log').where('twilio_call_sid', callSid).whereRaw(notQuarantinedSql()).first('id', 'metadata', 'customer_id');
      let meta = call?.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
      if (!call || (await officeAlertBlock(trx, callSid, meta))) return;
      await raiseOfficeAlert(trx, callSid, call, staffNameOf(meta.forward_acceptance), reply);
    });
  } catch (err) {
    logger.warn(`[live-call-early-summary] next-step alert failed: ${err?.code || err?.name || 'error'}`);
  }
}

// customerId rides in the metadata so an internal test customer's call rings nobody (notification-service.js).
function raiseOfficeAlert(trx, callSid, call, name, reply) {
  return raiseAdminAlert('live_call_next_step', {
      area: 'Comms',
      action: actionFor(name, reply),
      why: whyFor(name, reply),
      severity: reply.next_step ? 'needs-you' : 'fyi',
      link: `/admin/communications#tab=calls&call=${encodeURIComponent(call.id)}`,
      subject: { type: 'call', id: String(call.id) },
      doneWhen: 'office_followed_up',
      who: 'person',
    }, { bell: true, fyiRow: true, dedupeKey: `live-call-next-step:${callSid}`, bannerKind: 'live_call_next_step', trx,
    ...(call.customer_id ? { metadata: { customerId: call.customer_id } } : {}) });
}

// The promises the staff side really said: a model quote is kept only when it is a contiguous quote of one "Agent:"
// line (case, curly quotes, punctuation and spacing aside), and what is saved is that staff line itself, cut to the
// promise budget: so a caller's words, a model's guess, a flipped refusal ("cannot" read as "can") or a dropped
// condition ("only if the manager approves") never shows under a staff member's name.
const normalized = (t) => String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
function groundedPromises(promises, transcript) {
  const agentLines = String(transcript || '').split('\n').filter((l) => l.startsWith('Agent: ')).map((l) => l.slice(7).trim());
  const kept = [];
  for (const p of promises) {
    const quote = normalized(p);
    const line = quote.length >= 8 && agentLines.find((l) => ` ${normalized(l)} `.includes(` ${quote} `));
    const shown = line ? cleanText(line, MAX_PROMISE_CHARS) : null;
    if (shown && !kept.includes(shown)) kept.push(shown);
  }
  return kept;
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
    if (await quarantinedNow(callSid)) return { written: false, reason: 'quarantined' };
    const parsed = await summarize(text);
    if (!parsed) return { written: false, reason: 'no_summary' };
    const reply = { ...parsed, promises: groundedPromises(parsed.promises, text) };
    const written = await saveSummary(callSid, reply, now());
    if (written) await alertOfficeCall(callSid, reply);
    return { written, reason: null };
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

module.exports = { afterCallStopped, writeEarlySummary, _test: { cleanSummary, parseReply, groundedPromises, transcriptFor, SETTLE_MS, HEAD_CHARS, TAIL_CHARS } };
