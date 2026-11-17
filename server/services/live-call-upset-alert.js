'use strict';

/**
 * Upset-caller alert on a live call (GATE_LIVE_CALL_UPSET_ALERT, dark; owner 2026-11-16 "ok build all, use haiku").
 *
 * live-call-transcription.js stores each final utterance in call_live_utterances. After a CALLER utterance is
 * stored, this module decides whether to read the last two minutes of the call with Claude Haiku 5.5. When the
 * caller sounds upset or angry and the owner is not the one on the call, the owner gets ONE bell row plus a phone
 * banner (bell-banners.js kind live_call_upset) so he can step in while the call is live.
 *
 * Cadence (the claim is a compare-and-swap UPDATE on call_log.metadata.live_transcription, so two webhooks racing
 * admit one check): 3 or more new caller utterances since the last check, at least 45 s since it, at most 8 checks
 * per call, and nothing once upset_alert_at is stamped. A refusal, bad JSON or an API error is no alert (the
 * check still counts toward the 8). An ended call (terminal status, ended_at or stopped_at) is never checked, and is
 * rechecked right before the alert. A write that returns null or no id gives the claim back. Fire and forget: nothing here throws or delays the webhook's 200.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { toE164 } = require('../utils/phone');
const { ledgerCall } = require('./llm-dispatch-metrics');
const { anthropicText } = require('./llm/call');
const { anthropicMaxTokens, anthropicEffortConfig } = require('./llm/anthropic-wire');
const { TERMINAL_CALL_STATUSES } = require('../utils/call-timeline');
const { raiseAdminAlert, firstSentence, cutAtWord, breaksAlertRules, MAX_WHY_CHARS } = require('./admin-alert-compose');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MIN_NEW_UTTERANCES = 3;
const MIN_GAP_MS = 45 * 1000;
const MAX_CHECKS = 8;
const WINDOW_MS = 2 * 60 * 1000;
const MAX_INPUT_CHARS = 1500;
const MOODS = new Set(['calm', 'concerned', 'upset', 'angry']);
const FALLBACK_WHY = 'The caller sounds upset about how the call is going.';

const SYSTEM_PROMPT = `You read the last two minutes of a live phone call to a pest control company. "Caller:" is the customer or prospect. "Agent:" is the Waves staff member.
Decide how the CALLER sounds right now. Frustration with a bug problem alone is normal; judge the caller's mood toward the call or the company.
Reply with ONLY this JSON: {"mood": "calm" | "concerned" | "upset" | "angry", "reason": "<one plain sentence, 110 characters or fewer, no phone numbers, no card or account digits, no quotes>"}
Use "upset" or "angry" only when the caller clearly is: raised frustration, a complaint about service or billing, a threat to cancel or leave a review, or insults.`;

const gateOn = () => require('../config/feature-gates').isEnabled('liveCallUpsetAlert');

function meta(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')) || {}; } catch { return {}; }
}

// A call is over once Twilio reported a terminal status, the status callback stamped metadata.ended_at, or the
// transcription-stopped event stamped live_transcription.stopped_at. live_transcription itself only proves the
// transcription was claimed; it stays on the row after hangup.
function callEnded(row) {
  const m = meta(row?.metadata);
  return TERMINAL_CALL_STATUSES.has(String(row?.status || '')) || !!m.ended_at || !!m.live_transcription?.stopped_at;
}

// The owner's cell is ADAM_PHONE (the same env the dial list and the CSR name map read).
function ownerAnswered(acceptance) {
  const owner = toE164(process.env.ADAM_PHONE);
  const answered = toE164(acceptance?.answered_by_number);
  return !!owner && !!answered && owner === answered;
}

// Decides whether a check is due, then stamps it with a compare-and-swap on upset_checks: of two webhooks that read
// the same count, one UPDATE matches and wins. Cheap checks first, so most utterances cost no query beyond the row.
async function claimCheck(callSid, live, now) {
  const checks = Number(live.upset_checks) || 0;
  if (live.upset_alert_at || checks >= MAX_CHECKS) return false;
  const last = Date.parse(live.upset_checked_at);
  if (Number.isFinite(last) && now.getTime() - last < MIN_GAP_MS) return false;
  const [{ n }] = await db('call_live_utterances').where({ call_sid: callSid, speaker: 'caller' }).count({ n: '*' });
  const callerCount = Number(n) || 0;
  if (callerCount - (Number(live.upset_checked_count) || 0) < MIN_NEW_UTTERANCES) return false;
  const won = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("COALESCE((metadata -> 'live_transcription' ->> 'upset_checks')::int, 0) = ?", [checks])
    .whereRaw("(metadata -> 'live_transcription') ->> 'upset_alert_at' IS NULL")
    .update({
      metadata: db.raw(
        "jsonb_set(metadata, '{live_transcription}', (metadata -> 'live_transcription') || ?::jsonb, true)",
        [JSON.stringify({ upset_checks: checks + 1, upset_checked_at: now.toISOString(), upset_checked_count: callerCount })],
      ),
    });
  return won > 0;
}

// The last two minutes, oldest first, "Caller:" / "Agent:", cut to the newest 1,500 characters.
async function transcriptWindow(callSid) {
  const rows = await db('call_live_utterances')
    .where('call_sid', callSid)
    .orderBy([{ column: 'spoken_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(40)
    .select('speaker', 'text', 'spoken_at');
  if (!rows.length) return '';
  const newest = new Date(rows[0].spoken_at).getTime();
  const lines = rows
    .filter((r) => newest - new Date(r.spoken_at).getTime() <= WINDOW_MS && r.text)
    .reverse()
    .map((r) => `${r.speaker === 'caller' ? 'Caller' : 'Agent'}: ${r.text}`);
  return lines.join('\n').slice(-MAX_INPUT_CHARS);
}

// { mood, reason } or null (no key, refusal, bad JSON, API error). Never throws.
async function classify(transcript) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20 * 1000, maxRetries: 0 });
    const response = await ledgerCall('anthropic', MODELS.LIVE_CALL, () => client.messages.create({
      model: MODELS.LIVE_CALL,
      ...anthropicEffortConfig(MODELS.LIVE_CALL),
      // Haiku 5.5 thinks by default and the thinking spends from this cap, so it is not sized to the reply alone.
      max_tokens: anthropicMaxTokens(MODELS.LIVE_CALL, 2048),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
    }), { laneId: 'live_call_upset' });
    if (response?.stop_reason === 'refusal') return null;
    const text = anthropicText(response);
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!MOODS.has(parsed?.mood)) return null;
    return { mood: parsed.mood, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch (err) {
    logger.warn(`[live-call-upset] classify failed: ${err?.status || err?.name || 'error'}`);
    return null;
  }
}

// One plain sentence inside the why budget; the model's words are masked like every bell body and replaced
// by a fixed line when they still break the notification rules.
function whyFrom(reason) {
  const { redactedWords } = require('./admin-alert-names');
  const plain = firstSentence(redactedWords(reason))
    .replace(/\+?\d[\d\s().-]{4,}\d|\d{4,}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,])/g, '$1');
  const words = cutAtWord(plain, MAX_WHY_CHARS).trim();
  return words && !breaksAlertRules(words) ? words : FALLBACK_WHY;
}

async function raiseAlert(call, acceptance, reason) {
  const callSid = call.twilio_call_sid;
  // The call may have ended while the model ran: one fresh read, so the owner is not paged to join a dead call.
  const fresh = await db('call_log').where('twilio_call_sid', callSid).first('status', 'metadata');
  if (!fresh || callEnded(fresh)) return false;
  // Once per call: the first caller to stamp upset_alert_at raises it.
  const stamped = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'live_transcription') ->> 'upset_alert_at' IS NULL")
    .update({
      metadata: db.raw(
        "jsonb_set(metadata, '{live_transcription}', (metadata -> 'live_transcription') || jsonb_build_object('upset_alert_at', ?::text), true)",
        [new Date().toISOString()],
      ),
    });
  if (!stamped) return false;
  try {
    const name = String(acceptance?.csr_name || '').replace(/[^\p{L}\p{N} '.-]/gu, '').trim().slice(0, 20);
    const written = await raiseAdminAlert('live_call_upset', {
      area: 'Comms',
      action: name ? `step in on ${name}'s upset caller` : 'step in on an upset caller',
      why: whyFrom(reason),
      severity: 'needs-you',
      link: `/admin/communications#tab=calls&call=${encodeURIComponent(call.id)}`,
      subject: { type: 'call', id: String(call.id) },
      doneWhen: 'call_ended',
      who: 'person',
    }, { bell: true, dedupeKey: `live-call-upset:${callSid}`, bannerKind: 'live_call_upset' });
    // notifyAdmin swallows a database failure and resolves null. A row (also a dedupe hit, which is the standing
    // alert) or an intentional suppression (bell policy, internal test customer: id null, suppressed true) is
    // delivered; nothing else is, so it takes the same release path as a rejection.
    if (!written || (!written.id && !written.suppressed)) throw new Error('admin alert was not written');
  } catch (err) {
    // The alert never reached the owner: give the claim back so a later check may try again.
    await db('call_log').where('twilio_call_sid', callSid).update({
      metadata: db.raw("jsonb_set(metadata, '{live_transcription}', (metadata -> 'live_transcription') || '{\"upset_alert_at\": null}'::jsonb, true)"),
    }).catch(() => {});
    throw err;
  }
  return true;
}

/**
 * Check one call after a caller utterance was stored. Resolves { checked, alerted, reason? }; never throws.
 */
async function checkCall(callSid) {
  try {
    if (!gateOn()) return { checked: false, reason: 'gate_off' };
    const call = await db('call_log').where('twilio_call_sid', callSid).first('id', 'twilio_call_sid', 'status', 'metadata');
    const callMeta = meta(call?.metadata);
    if (!call || !callMeta.live_transcription) return { checked: false, reason: 'not_live' };
    if (callEnded(call)) return { checked: false, reason: 'call_ended' };
    if (ownerAnswered(callMeta.forward_acceptance)) return { checked: false, reason: 'owner_on_call' };
    if (!(await claimCheck(callSid, callMeta.live_transcription, new Date()))) return { checked: false, reason: 'not_due' };
    const transcript = await transcriptWindow(callSid);
    if (!transcript) return { checked: true, alerted: false };
    const verdict = await classify(transcript);
    if (!verdict || (verdict.mood !== 'upset' && verdict.mood !== 'angry')) return { checked: true, alerted: false };
    return { checked: true, alerted: await raiseAlert(call, callMeta.forward_acceptance, verdict.reason) };
  } catch (err) {
    logger.warn(`[live-call-upset] check failed: ${err?.code || err?.name || 'error'}`);
    return { checked: false, reason: 'error' };
  }
}

// Fire and forget: the webhook never waits on this.
function afterCallerUtterance(callSid) {
  checkCall(callSid).catch(() => {});
}

module.exports = { afterCallerUtterance, checkCall, _test: { whyFrom, ownerAnswered, callEnded } };
