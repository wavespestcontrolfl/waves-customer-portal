'use strict';

/**
 * Live call transcription (GATE_LIVE_CALL_TRANSCRIPTION, dark; owner 2026-11-16 "ok build all").
 *
 * When a staff member presses 1 to take an inbound call (/inbound-forward-accept), Twilio Real-Time
 * Transcription starts on the CALLER's call: the parent CallSid that call_log is keyed on, both
 * tracks. The inbound track is the caller; the outbound track is what the caller hears, which is
 * the staff member once the legs bridge. Each final utterance posts to
 * /api/webhooks/twilio/live-transcription and lands in call_live_utterances, card-number scrubbed.
 * This module only collects the text. The features that read it come in later PRs.
 *
 * Spend: Twilio bills real-time transcription by the minute ($0.027/min, read 2026-11-16), so the
 * gate is the owner's flip. Starting after press 1 skips the greeting, the ringing, voicemail and
 * spam. One start per call: both cells can press 1 on one ring, so a conditional claim on
 * call_log.metadata.live_transcription admits exactly one start.
 *
 * Never on the connect path: the accept route calls startLiveTranscription after its TwiML is sent,
 * and every failure here is logged, stamped and swallowed.
 */

const twilio = require('twilio');
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { createEditTracker, scrubPansTracked, trackedEditList } = require('../utils/pan-scrub');

const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const WEBHOOK_PATH = '/api/webhooks/twilio/live-transcription';
// Transcribing the caller's call: inbound = the caller, outbound = what the caller hears (staff).
const SPEAKER_BY_TRACK = { inbound_track: 'caller', outbound_track: 'staff' };
// Each new utterance is scrubbed together with the lines spoken in the 90 s before and after it (up
// to 30 each side), so a card number read in pieces ("4242" … "okay" … "4242" …) is caught, even
// when a line arrives late. The scrub is utils/pan-scrub's, the one the post-call transcript uses
// (scrubLines below).
const SCRUB_WINDOW_MS = 90 * 1000;
const SCRUB_WINDOW_ROWS = 30;
// A short code-shaped utterance (an expiry or a CVV) soon after a masked card number is masked
// too: the masked text no longer shows the card to the window scrub. The link is the same speaker's
// latest masked line within the gap, so a staff question in between ("And the security code?")
// does not break it. Same shape and gap rule as the post-call scrub's code-tail absorb.
const CODE_TAIL_RE = /^[\s,./:-]*(?:(?:\d{1,4}|zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,./:-]*){1,4}$/i;
const CODE_TAIL_GAP_MS = 30 * 1000;
const MAX_TEXT = 4000;
// The post-call card-number quarantine ran on this call: purgeLiveUtterances stamped it, or the
// recording's own scrub flagged a card number (transcription_metadata.pan_detected).
const QUARANTINED_SQL = "((metadata #>> '{live_transcription,quarantined_at}') IS NOT NULL"
  + " OR COALESCE(transcription_metadata ->> 'pan_detected', '') = 'true') AS quarantined";

function maskSid(sid) {
  const value = String(sid || '');
  return value.length > 8 ? `${value.slice(0, 2)}…${value.slice(-6)}` : 'none';
}

function callbackUrl() {
  const domain = process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com';
  return `https://${domain}${WEBHOOK_PATH}`;
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function eventTime(body) {
  const at = new Date(body?.Timestamp);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

// Merge keys into call_log.metadata.live_transcription for a call this module claimed. The start
// path and the webhook write different keys, so a webhook event that lands before the REST answer
// never loses its keys, and the reverse.
async function stampLiveState(conn, callSid, patch) {
  return conn('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
    .update({
      metadata: conn.raw(
        "jsonb_set(metadata, '{live_transcription}', (metadata -> 'live_transcription') || ?::jsonb, true)",
        [JSON.stringify(patch)],
      ),
      updated_at: new Date(),
    });
}

function startParams(language) {
  return {
    StatusCallbackUrl: callbackUrl(),
    StatusCallbackMethod: 'POST',
    Track: 'both_tracks',
    InboundTrackLabel: 'caller',
    OutboundTrackLabel: 'staff',
    TranscriptionEngine: 'google',
    SpeechModel: 'telephony',
    LanguageCode: language === 'es' ? 'es-US' : 'en-US',
    PartialResults: 'false',
    EnableAutomaticPunctuation: 'true',
    ProfanityFilter: 'false',
  };
}

async function requestStart(accountSid, authToken, callSid, language) {
  try {
    const client = twilio(accountSid, authToken);
    const response = await client.request({
      method: 'post',
      uri: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Transcriptions.json`,
      data: startParams(language),
    });
    const body = parseJson(response?.body);
    if (response?.statusCode >= 200 && response.statusCode < 300 && body.sid) {
      return { status: 'started', transcription_sid: String(body.sid) };
    }
    return {
      status: 'start_failed',
      error_code: body.code || response?.statusCode || null,
      error: String(body.message || 'no transcription sid').slice(0, 200),
    };
  } catch (err) {
    return { status: 'start_failed', error_code: null, error: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * Start live transcription on the caller's call. Returns { started, reason?, status? }; never
 * throws for a Twilio failure (the failure is stamped on the call instead).
 */
async function startLiveTranscription({ parentCallSid, language = null } = {}) {
  if (!isEnabled('liveCallTranscription')) return { started: false, reason: 'gate_off' };
  const callSid = String(parentCallSid || '');
  if (!CALL_SID_RE.test(callSid)) return { started: false, reason: 'no_call_sid' };
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return { started: false, reason: 'no_twilio_credentials' };

  const requestedAt = new Date().toISOString();
  const claimed = await db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'live_transcription') IS NULL")
    .update({
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{live_transcription}', ?::jsonb, true)",
        [JSON.stringify({ status: 'starting', requested_at: requestedAt })],
      ),
      updated_at: new Date(),
    });
  if (!claimed) return { started: false, reason: 'already_claimed_or_no_row' };

  const outcome = await requestStart(accountSid, authToken, callSid, language);
  try {
    await stampLiveState(db, callSid, outcome);
  } catch (err) {
    logger.warn(`[live-transcription] state stamp failed for ${maskSid(callSid)}: ${err.message}`);
  }
  if (outcome.status !== 'started') {
    logger.warn(`[live-transcription] start failed for ${maskSid(callSid)}: ${outcome.error_code || ''} ${outcome.error}`);
    return { started: false, reason: 'twilio_refused', status: outcome.status };
  }
  logger.info(`[live-transcription] started for ${maskSid(callSid)}`);
  return { started: true, status: outcome.status };
}

// The window's lines joined and scrubbed once, each mask put back on the line it came from: a mask
// that spans two lines (a card number read in two pieces) goes on the first of them and the covered
// part of the next is removed. Every other character stays on its own line, so each line keeps its
// speaker and time (utils/pan-scrub scrubSegments would move a cross-line hit into the first line).
function scrubLines(texts) {
  const starts = [];
  let joined = '';
  texts.forEach((text, i) => { joined += (i ? '\n' : ''); starts.push(joined.length); joined += text; });
  const edits = trackedEditList(scrubPansTracked(createEditTracker(joined)).tracker);
  const overlaps = (e, i) => e.start < starts[i] + texts[i].length && e.end > starts[i];
  const owners = edits.map((e) => texts.findIndex((_, i) => overlaps(e, i)));
  return texts.map((text, i) => {
    let out = '';
    let cursor = 0;
    let masked = false;
    edits.forEach((e, k) => {
      if (!overlaps(e, i)) return;
      const from = Math.max(e.start - starts[i], 0);
      out += text.slice(cursor, from) + (owners[k] === i ? e.text : '');
      cursor = Math.min(e.end - starts[i], text.length);
      masked = true;
    });
    return masked ? { text: (out + text.slice(cursor)).replace(/\s+/g, ' ').trim(), masked } : { text, masked };
  });
}

// The window scrub for one new utterance, oldest first. Returns the scrubbed text of every segment
// (the new one included) and whether each one had something masked.
function scrubWindow(recent, incoming) {
  // Spoken order; the new utterance (id null) sorts after a stored one spoken at the same instant.
  const byId = (a, b) => (a.id === null ? 1 : b.id === null ? -1 : Number(a.id) - Number(b.id));
  const segments = [...recent, incoming].sort((a, b) => (a.spokenAt - b.spokenAt) || byId(a, b));
  // All lines in spoken order, then each speaker's own lines again: a staff line ("Okay, go ahead.")
  // between two halves of the caller's card number must not hide it.
  const scrubbed = scrubLines(segments.map((s) => s.text));
  for (const speaker of new Set(segments.map((s) => s.speaker))) {
    const mine = segments.map((s, i) => (s.speaker === speaker ? i : -1)).filter((i) => i >= 0);
    scrubLines(mine.map((i) => scrubbed[i].text)).forEach((r, k) => {
      scrubbed[mine[k]] = { text: r.text, masked: scrubbed[mine[k]].masked || r.masked };
    });
  }
  const out = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const { text } = scrubbed[i];
    const anchor = out.slice(0, i).reverse().find((p) => p.speaker === seg.speaker && p.panMasked);
    const codeTail = !!anchor && seg.spokenAt - anchor.spokenAt <= CODE_TAIL_GAP_MS
      && /\S/.test(text) && CODE_TAIL_RE.test(text);
    out.push({ ...seg, text: codeTail ? '[code removed]' : text, panMasked: seg.panMasked || codeTail || scrubbed[i].masked });
  }
  return out;
}

async function storeUtterance(callSid, body) {
  if (String(body.Final).toLowerCase() !== 'true') return { stored: false, reason: 'partial' };
  const transcriptionSid = String(body.TranscriptionSid || '');
  const sequenceId = Number.parseInt(body.SequenceId, 10);
  const speaker = SPEAKER_BY_TRACK[body.Track];
  if (!transcriptionSid || !Number.isInteger(sequenceId) || !speaker) return { stored: false, reason: 'malformed' };
  const data = parseJson(body.TranscriptionData);
  const raw = typeof data.transcript === 'string' ? data.transcript.trim().slice(0, MAX_TEXT) : '';
  if (!raw) return { stored: false, reason: 'empty' };
  const confidence = Number.isFinite(Number(data.confidence)) && data.confidence !== null ? Number(data.confidence) : null;
  const spokenAt = eventTime(body);

  return db.transaction(async (trx) => {
    // One writer per call: two utterances of one call never scrub against a stale window.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`call_live_utterances:${callSid}`]);
    const claimed = await trx('call_log')
      .where('twilio_call_sid', callSid)
      .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
      .first('id', trx.raw(QUARANTINED_SQL));
    if (!claimed) return { stored: false, reason: 'not_started_here' };
    // A quarantined call keeps no live text: a late callback or a redelivery stores nothing.
    if (claimed.quarantined) return { stored: false, reason: 'quarantined' };

    // The rows spoken around this one, not the newest rows: a line that arrives late (after later
    // lines were stored) is scrubbed with its own neighbors.
    const columns = ['id', 'speaker', 'text', 'pan_masked', 'spoken_at'];
    const earlier = await trx('call_live_utterances')
      .where('call_sid', callSid)
      .where('spoken_at', '<=', spokenAt)
      .where('spoken_at', '>=', new Date(spokenAt.getTime() - SCRUB_WINDOW_MS))
      .orderBy([{ column: 'spoken_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(SCRUB_WINDOW_ROWS)
      .select(columns);
    const later = await trx('call_live_utterances')
      .where('call_sid', callSid)
      .where('spoken_at', '>', spokenAt)
      .where('spoken_at', '<=', new Date(spokenAt.getTime() + SCRUB_WINDOW_MS))
      .orderBy([{ column: 'spoken_at', order: 'asc' }, { column: 'id', order: 'asc' }])
      .limit(SCRUB_WINDOW_ROWS)
      .select(columns);
    const recent = [...earlier.reverse(), ...later].map((r) => ({
      id: r.id, speaker: r.speaker, text: r.text || '', panMasked: !!r.pan_masked, spokenAt: new Date(r.spoken_at).getTime(),
    }));
    const incoming = { id: null, speaker, text: raw, panMasked: false, spokenAt: spokenAt.getTime() };
    const scrubbed = scrubWindow(recent, incoming);

    const inserted = await trx('call_live_utterances')
      .insert({
        call_sid: callSid,
        transcription_sid: transcriptionSid,
        sequence_id: sequenceId,
        speaker,
        text: scrubbed.find((s) => s.id === null).text,
        confidence,
        language: body.LanguageCode ? String(body.LanguageCode).slice(0, 16) : null,
        pan_masked: scrubbed.find((s) => s.id === null).panMasked,
        spoken_at: spokenAt,
      })
      .onConflict(['transcription_sid', 'sequence_id'])
      .ignore()
      .returning('id');
    if (!inserted.length) return { stored: false, reason: 'duplicate' };

    const before = new Map(recent.map((r) => [r.id, r]));
    const changed = scrubbed.filter((s) => s.id !== null && (s.text !== before.get(s.id).text || s.panMasked !== before.get(s.id).panMasked));
    for (const seg of changed) {
      await trx('call_live_utterances').where('id', seg.id).update({ text: seg.text, pan_masked: seg.panMasked, updated_at: new Date() });
    }
    const panMasked = scrubbed.some((s) => s.panMasked && (s.id === null || changed.includes(s)));
    if (panMasked) await stampLiveState(trx, callSid, { pan_detected: true });
    return { stored: true, panMasked };
  });
}

/**
 * Record one Twilio Real-Time Transcription callback (transcription-started / -content / -stopped
 * / -error). Only a call this module claimed is written to; anything else is ignored.
 */
async function recordLiveTranscriptionEvent(body = {}) {
  const callSid = String(body.CallSid || '');
  if (!CALL_SID_RE.test(callSid)) return { stored: false, reason: 'bad_call_sid' };
  const event = String(body.TranscriptionEvent || '');
  if (event === 'transcription-content') return storeUtterance(callSid, body);
  const at = eventTime(body).toISOString();
  if (event === 'transcription-started') await stampLiveState(db, callSid, { live_at: at });
  else if (event === 'transcription-stopped') await stampLiveState(db, callSid, { stopped_at: at });
  else if (event === 'transcription-error') {
    await stampLiveState(db, callSid, {
      event_error_at: at,
      event_error_code: body.TranscriptionErrorCode ? String(body.TranscriptionErrorCode).slice(0, 16) : null,
      event_error: String(body.TranscriptionError || '').slice(0, 200),
    });
  } else return { stored: false, reason: 'ignored_event' };
  return { stored: false, reason: event };
}

/**
 * The post-call card-number quarantine found a card number on this call: drop its live text too.
 * The live scrub ran on a different transcript, so it may have missed what the post-call scrub saw.
 * It takes storeUtterance's per-call lock and stamps quarantined_at first: an insert in flight
 * finishes before the delete, and every later callback (a redelivery included, whose dedupe row the
 * delete removes) finds the stamp and stores nothing.
 */
async function purgeLiveUtterances(callSid) {
  if (!CALL_SID_RE.test(String(callSid || ''))) return 0;
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`call_live_utterances:${callSid}`]);
    await stampLiveState(trx, callSid, { quarantined_at: new Date().toISOString() });
    return trx('call_live_utterances').where('call_sid', callSid).del();
  });
}

/**
 * The retry for a purge that failed: quarantineCardRecording swallows a purge error, but the call
 * keeps transcription_metadata.pan_detected, so live text left on such a call is the debt. The
 * 5-minute recording job (scheduler.js) runs this; each call found is purged again. Never throws.
 */
async function purgeQuarantinedLiveText({ limit = 25 } = {}) {
  try {
    const result = await db.raw(
      `SELECT c.twilio_call_sid AS call_sid FROM call_log c
        WHERE COALESCE(c.transcription_metadata ->> 'pan_detected', '') = 'true'
          AND EXISTS (SELECT 1 FROM call_live_utterances u WHERE u.call_sid = c.twilio_call_sid)
        LIMIT ?`,
      [limit],
    );
    let purged = 0;
    for (const { call_sid: callSid } of result?.rows || []) purged += await purgeLiveUtterances(callSid);
    return { purged };
  } catch (err) {
    logger.warn(`[live-transcription] quarantine retry failed: ${err?.code || err?.name || 'error'}`);
    return { purged: 0 };
  }
}

module.exports = {
  startLiveTranscription,
  recordLiveTranscriptionEvent,
  purgeLiveUtterances,
  purgeQuarantinedLiveText,
  WEBHOOK_PATH,
  _test: { scrubWindow, scrubLines, startParams, CODE_TAIL_RE },
};
