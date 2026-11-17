'use strict';

/**
 * Spoken staff notes and reminders on a live call (GATE_CALL_SPOKEN_NOTES, dark; owner 2026-11-16 "ok build all, use haiku").
 *
 * Owner-approved behaviour: staff say "make a note" or "remind me". The note goes on the call record. A reminder
 * rings the bell at the time said. It never texts a customer.
 *
 * Every 2 minutes (scheduler.js job live-call-spoken-notes) one run does two things, in order:
 *   1. EXTRACT: a call whose live text stopped in the last 24 h and has no spoken_notes.checked_at is claimed
 *      with a compare-and-swap UPDATE that stamps checked_at FIRST (at most once per call, across instances and
 *      crashes). Only the STAFF side of the live text is searched for a trigger phrase. No phrase = done, no model
 *      call. A hit sends Claude Haiku 5.5 the matching staff lines with one line of context on each side. Each
 *      line carries the Eastern time it was said, so "tomorrow" or "in an hour" counts from when the staff said
 *      it, not from when this job runs (a call can be read up to 24 h after it ended, and a call just before
 *      midnight is read after it).
 *      Bad JSON, a refusal or an API error saves nothing and the call stays checked.
 *   2. RING: a saved reminder whose due time has come and has no raised_at raises ONE admin bell, then stamps
 *      raised_at with a compare-and-swap. A bell that was not written leaves it unstamped for the next run.
 *
 * Saved on call_log.metadata.live_transcription.spoken_notes:
 *   { checked_at, notes: [text], reminders: [{ text, due_at (UTC ISO), raised_at: ISO | null }] }
 *
 * Never here: a text, an email or a call to anyone; call_commitments (those rows feed customer texts);
 * call_summary, ai_extraction, transcription or call_log.notes.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { ledgerCall } = require('./llm-dispatch-metrics');
const { anthropicText } = require('./llm/call');
const { anthropicMaxTokens, anthropicEffortConfig } = require('./llm/anthropic-wire');
const { scrubPans } = require('../utils/pan-scrub');
const { raiseAdminAlert, firstSentence, cutAtWord, breaksAlertRules, MAX_WHY_CHARS, MAX_HEADLINE_CHARS } = require('./admin-alert-compose');
const { parseETDateTime, etParts, formatETTime } = require('../utils/datetime-et');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SETTLE_MS = 60 * 1000; // late final utterances still arrive for a moment after the stop event
const MAX_CALLS_PER_RUN = 10;
const RING_WINDOW_DAYS = 120;
const MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_NOTES = 5;
const MAX_REMINDERS = 3;
const MAX_NOTE_CHARS = 300;
const MAX_REMINDER_CHARS = 200;
const MAX_INPUT_CHARS = 3000;
const MAX_UTTERANCES = 600;

// Only the staff side is read for these. "reminder to" and "note that" are the spoken forms of the same asks.
const TRIGGER = /\b(?:make (?:a )?note|note that|add (?:a )?note|take (?:a )?note|remind me|set (?:a )?reminder|reminder to)\b/i;

const SYSTEM_PROMPT = `You read short excerpts of a phone call at a pest control company. "Agent:" is a Waves staff member. "Caller:" is the customer or prospect.
Find what the AGENT asked to have written down or to be reminded of, as in "make a note that ..." or "remind me to ...". Only an Agent instruction counts. A Caller who says "remind me" or "note that" is not a staff request: ignore it.
Reply with ONLY this JSON: {"notes": [{"text": "<the note, one plain sentence>"}], "reminders": [{"text": "<what to do, an instruction that starts with a verb, one plain sentence>", "due_local": "YYYY-MM-DDTHH:mm" or null}]}
Each line starts with the Eastern weekday, date and time it was said, in brackets.
Rules: due_local is Eastern time (America/New_York) as a 24-hour wall clock, worked out from the date and time of the Agent line that asks for the reminder, never from any other time ("tomorrow at 2" said on a Monday means Tuesday 14:00 when the agent is clearly asking for the afternoon; "in an hour" said at 16:10 means 17:10). Use null when the agent gave no time. Do not invent a time. Write numbers and names as the agent said them. Do not write card numbers. Use empty lists when there is nothing. At most 5 notes and 3 reminders.`;

const gateOn = () => require('../config/feature-gates').isEnabled('callSpokenNotes');

// The path every UPDATE below works on: call_log.metadata -> live_transcription -> spoken_notes.
const CHECKED_AT_SQL = "(metadata -> 'live_transcription' -> 'spoken_notes' ->> 'checked_at')";

function meta(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')) || {}; } catch { return {}; }
}

// One plain line with card numbers masked, cut to max. The live scrub can miss a number split across utterances,
// and the model can then write it whole in a note.
function plain(value, max) {
  if (typeof value !== 'string') return '';
  return scrubPans(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

// "Tuesday 2026-11-17 14:00": the Eastern weekday, date and wall-clock time of one moment.
function etStamp(at) {
  const p = etParts(at);
  const pad = (n) => String(n).padStart(2, '0');
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][p.dayOfWeek];
  return `${weekday} ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

// When a line was said. spoken_at is NOT NULL in the table; an unreadable value falls back to the run's time.
function spokenAt(u, now) {
  const at = u?.spoken_at ? new Date(u.spoken_at) : null;
  return at && Number.isFinite(at.getTime()) ? at : now;
}

/**
 * The staff lines that name a note or a reminder, each with one line of context on both sides, and each tagged
 * with the Eastern time it was said (the model works relative times out from it). '' when none.
 */
function excerptFor(utterances, now = new Date()) {
  const rows = utterances.filter((u) => u && typeof u.text === 'string' && u.text.trim());
  const keep = new Set();
  rows.forEach((u, i) => {
    if (u.speaker === 'caller' || !TRIGGER.test(u.text)) return;
    for (let k = Math.max(0, i - 1); k <= Math.min(rows.length - 1, i + 1); k += 1) keep.add(k);
  });
  if (!keep.size) return '';
  const lines = [...keep].sort((a, b) => a - b).map((i, n, all) => {
    const gap = n > 0 && i - all[n - 1] > 1 ? '...\n' : '';
    return `${gap}[${etStamp(spokenAt(rows[i], now))}] ${rows[i].speaker === 'caller' ? 'Caller' : 'Agent'}: ${rows[i].text.trim()}`;
  });
  return lines.join('\n').slice(0, MAX_INPUT_CHARS);
}

/** The model's JSON -> { notes: [text], reminders: [{ text, due_local }] }, or null when it is not usable. */
function validate(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const list = (v) => (Array.isArray(v) ? v : []);
  const notes = list(parsed.notes).map((n) => plain(n?.text, MAX_NOTE_CHARS)).filter(Boolean).slice(0, MAX_NOTES);
  const reminders = list(parsed.reminders).map((r) => {
    const text = plain(r?.text, MAX_REMINDER_CHARS);
    const due = typeof r?.due_local === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.due_local.trim()) ? r.due_local.trim() : null;
    return text ? { text, due_local: due } : null;
  }).filter(Boolean).slice(0, MAX_REMINDERS);
  return { notes, reminders };
}

/** { notes, reminders } or null (no key, refusal, bad JSON, API error). Never throws. */
async function extract(excerpt) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30 * 1000, maxRetries: 0 });
    const response = await ledgerCall('anthropic', MODELS.LIVE_CALL, () => client.messages.create({
      model: MODELS.LIVE_CALL,
      ...anthropicEffortConfig(MODELS.LIVE_CALL),
      // Haiku 5.5 thinks by default and the thinking spends from this cap, so it is not sized to the reply alone.
      max_tokens: anthropicMaxTokens(MODELS.LIVE_CALL, 2048),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: excerpt }],
    }), { laneId: 'live_call_spoken_notes' });
    if (response?.stop_reason === 'refusal') return null;
    const text = anthropicText(response);
    return validate(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  } catch (err) {
    logger.warn(`[live-call-spoken-notes] extract failed: ${err?.status || err?.name || 'error'}`);
    return null;
  }
}

/**
 * due_local (Eastern wall clock) -> a UTC ISO string. null, unparseable or already past = due now. A date more
 * than 90 days out is held to 90 days, so the ring query's window always covers it.
 */
function dueAt(dueLocal, now) {
  let due = null;
  const m = typeof dueLocal === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(dueLocal) : null;
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const calendar = new Date(Date.UTC(y, mo - 1, d));
    const real = mo >= 1 && mo <= 12 && h <= 23 && mi <= 59 && calendar.getUTCMonth() === mo - 1 && calendar.getUTCDate() === d;
    if (real) {
      const parsed = parseETDateTime(dueLocal);
      if (Number.isFinite(parsed.getTime())) due = parsed;
    }
  }
  if (!due || due.getTime() <= now.getTime()) return now.toISOString();
  return new Date(Math.min(due.getTime(), now.getTime() + MAX_AHEAD_MS)).toISOString();
}

// Stamps checked_at FIRST. Of two instances (or a retry after a crash) only one UPDATE matches.
async function claimCheck(callId, checkedAt) {
  const won = await db('call_log')
    .where('id', callId)
    .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
    .whereRaw(`${CHECKED_AT_SQL} IS NULL`)
    .update({
      metadata: db.raw(
        "jsonb_set(metadata, '{live_transcription,spoken_notes}', ?::jsonb, true)",
        [JSON.stringify({ checked_at: checkedAt, notes: [], reminders: [] })],
      ),
    });
  return won > 0;
}

async function saveResult(callId, checkedAt, result) {
  await db('call_log')
    .where('id', callId)
    .whereRaw(`${CHECKED_AT_SQL} = ?`, [checkedAt])
    .update({
      metadata: db.raw(
        "jsonb_set(metadata, '{live_transcription,spoken_notes}', (metadata -> 'live_transcription' -> 'spoken_notes') || ?::jsonb, true)",
        [JSON.stringify(result)],
      ),
    });
}

async function extractOne(call, now) {
  const checkedAt = now.toISOString();
  if (!(await claimCheck(call.id, checkedAt))) return { claimed: false };
  const utterances = await db('call_live_utterances')
    .where('call_sid', call.twilio_call_sid)
    .orderBy([{ column: 'spoken_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(MAX_UTTERANCES)
    .select('speaker', 'text', 'spoken_at');
  const excerpt = excerptFor(utterances, now);
  if (!excerpt) return { claimed: true, asked: false };
  const found = await extract(excerpt);
  if (!found || (!found.notes.length && !found.reminders.length)) return { claimed: true, asked: true, saved: false };
  await saveResult(call.id, checkedAt, {
    notes: found.notes,
    reminders: found.reminders.map((r) => ({ text: r.text, due_at: dueAt(r.due_local, now), raised_at: null })),
  });
  return { claimed: true, asked: true, saved: true };
}

async function extractPending(now) {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const settled = new Date(now.getTime() - SETTLE_MS);
  const calls = await db('call_log')
    .modify((qb) => require('./voice-agent/relay-protocol').whereNotSandboxCall(qb)) // a bake-off call takes no staff notes
    .whereRaw("(metadata -> 'live_transcription' ->> 'stopped_at') IS NOT NULL")
    .whereRaw("(metadata -> 'live_transcription' ->> 'stopped_at')::timestamptz > ?", [since.toISOString()])
    .whereRaw("(metadata -> 'live_transcription' ->> 'stopped_at')::timestamptz <= ?", [settled.toISOString()])
    .whereRaw(`${CHECKED_AT_SQL} IS NULL`)
    .orderBy('created_at', 'asc')
    .limit(MAX_CALLS_PER_RUN)
    .select('id', 'twilio_call_sid');
  const out = { checked: 0, asked: 0, saved: 0 };
  for (const call of calls) {
    try {
      const r = await extractOne(call, now);
      if (!r.claimed) continue;
      out.checked += 1;
      if (r.asked) out.asked += 1;
      if (r.saved) out.saved += 1;
    } catch (err) {
      logger.warn(`[live-call-spoken-notes] extract failed for a call: ${err?.code || err?.name || 'error'}`);
    }
  }
  return out;
}

// One plain sentence for the headline: the reminder's own words, masked like every bell body.
function actionFrom(text) {
  const { redactedWords } = require('./admin-alert-names');
  const words = firstSentence(redactedWords(text))
    .replace(/\+?\d[\d\s().-]{4,}\d|\d{4,}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .replace(/[.]+$/, '')
    .trim();
  const room = MAX_HEADLINE_CHARS - 'Comms — '.length;
  const cut = cutAtWord(words, room).trim();
  return cut && !breaksAlertRules(cut) ? cut : 'do the reminder you set on a call';
}

function whyFrom(callCreatedAt) {
  const at = callCreatedAt ? new Date(callCreatedAt) : null;
  const when = at && Number.isFinite(at.getTime()) ? `your ${formatETTime(at)} call` : 'a call';
  const why = `Reminder you set on ${when}; open the call to see the notes.`;
  return why.length <= MAX_WHY_CHARS && !breaksAlertRules(why) ? why : 'Reminder you set on a call; open the call to see the notes.';
}

// Stamps raised_at with a compare-and-swap on that one reminder. 1 = this run stamped it.
async function stampRaised(callId, index, raisedAt) {
  const path = ['live_transcription', 'spoken_notes', 'reminders', String(index), 'raised_at'];
  const won = await db('call_log')
    .where('id', callId)
    .whereRaw("(metadata #>> ARRAY['live_transcription','spoken_notes','reminders', ?::text, 'raised_at']) IS NULL", [String(index)])
    .update({ metadata: db.raw('jsonb_set(metadata, ?::text[], to_jsonb(?::text), false)', [`{${path.join(',')}}`, raisedAt]) });
  return won > 0;
}

// A saved reminder whose due time has come and that has not rung yet.
function dueUnrung(r, nowMs) {
  const due = Date.parse(r?.due_at);
  return Boolean(r && !r.raised_at && r.text && Number.isFinite(due) && due <= nowMs);
}

// Raises one reminder's bell, then stamps its raised_at. 1 = this run stamped it. Throws when the bell was not
// written, so the caller leaves it unstamped for the next run.
async function ringOne(call, r, index, now) {
  const written = await raiseAdminAlert('live_call_reminder', {
    area: 'Comms',
    action: actionFrom(r.text),
    why: whyFrom(call.created_at),
    severity: 'needs-you',
    link: `/admin/communications#tab=calls&call=${encodeURIComponent(call.id)}`,
    subject: { type: 'call', id: String(call.id) },
    doneWhen: 'reminder_done',
    who: 'person',
  }, { bell: true, dedupeKey: `spoken-reminder:${call.id}:${index}` });
  // notifyAdmin swallows a database failure and resolves null (live-call-upset-alert.js reads it the same way). A
  // row (also a dedupe hit: the standing bell) or an intentional suppression (bell policy, internal test customer:
  // id null, suppressed true) is delivered. Anything else is not.
  if (!written || (!written.id && !written.suppressed)) throw Object.assign(new Error('admin alert was not written'), { code: 'not_written' });
  return (await stampRaised(call.id, index, now.toISOString())) ? 1 : 0;
}

// Only calls that hold a reminder that is due now and not rung: a call whose reminders are all still in the future
// never takes one of the 50 places, so it cannot hold back a due reminder on a newer call. due_at and now are both
// toISOString() output, so the string compare is a time compare.
async function ringDue(now) {
  const since = new Date(now.getTime() - RING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const calls = await db('call_log')
    .modify((qb) => require('./voice-agent/relay-protocol').whereNotSandboxCall(qb)) // a bake-off call rings no reminder
    .where('created_at', '>', since)
    .whereRaw(
      "jsonb_path_exists(metadata, ?::jsonpath, jsonb_build_object('now', ?::text))",
      ['$.live_transcription.spoken_notes.reminders[*] ? (@.raised_at == null && @.due_at <= $now)', now.toISOString()],
    )
    .orderBy('created_at', 'asc')
    .limit(50)
    .select('id', 'created_at', 'metadata');
  let raised = 0;
  for (const call of calls) {
    const reminders = meta(call.metadata).live_transcription?.spoken_notes?.reminders;
    if (!Array.isArray(reminders)) continue;
    for (let i = 0; i < reminders.length; i += 1) {
      if (!dueUnrung(reminders[i], now.getTime())) continue;
      try {
        raised += await ringOne(call, reminders[i], i, now);
      } catch (err) {
        // Not stamped: the next run tries again, and the dedupe key keeps it to one row.
        logger.warn(`[live-call-spoken-notes] reminder bell failed: ${err?.code || err?.name || 'error'}`);
      }
    }
  }
  return { raised };
}

/** One 2-minute run. Gate off: nothing is read and nothing is called. Never throws. */
async function run(now = new Date()) {
  if (!gateOn()) return { skipped: 'gate_off' };
  const out = { checked: 0, asked: 0, saved: 0, raised: 0 };
  try { Object.assign(out, await extractPending(now)); } catch (err) {
    logger.warn(`[live-call-spoken-notes] extract pass failed: ${err?.code || err?.name || 'error'}`);
  }
  try { Object.assign(out, await ringDue(now)); } catch (err) {
    logger.warn(`[live-call-spoken-notes] ring pass failed: ${err?.code || err?.name || 'error'}`);
  }
  return out;
}

module.exports = { run, _test: { excerptFor, validate, dueAt, TRIGGER, actionFrom, whyFrom, SYSTEM_PROMPT } };
