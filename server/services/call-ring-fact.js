'use strict';

/**
 * Ring fact (GATE_CALL_RING_FACT, owner 2026-11-16 "ok build all", live-call suite part 8): "On half the
 * calls for 2 weeks, the caller hears one fact, then the ring. It stays only if hang-ups before the answer
 * do not rise." This module holds the arm / fact choice for the conference ring and the read-only report
 * that compares the two arms. The TwiML is in routes/twilio-voice-webhook.js (appendCallerConference and
 * POST /conference-wait). The facts are the owner-approved FACTS of call-hold-script.js; nothing new is
 * said to a caller here. No customer data is stored: the stamp holds the arm, an index and a time.
 */

const crypto = require('crypto');
const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const { FACTS } = require('./call-hold-script');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const ARMS = ['fact', 'ring'];
const FACT_COUNT = FACTS.length;

// Read through the module object at call time: a suite that mocks feature-gates as a bare object reads off.
const live = () => typeof featureGates.callRingFactLive === 'function' && featureGates.callRingFactLive();

// The same CallSid always gets the same answer (a stable SHA-256), so a redelivered /conference-enter gets
// the arm the first delivery got. The first digest byte's low bit picks the arm (half each); the next two
// bytes pick the fact, so the fact does not follow the arm.
function choose(callSid) {
  const digest = crypto.createHash('sha256').update(String(callSid || '')).digest();
  return { arm: ARMS[digest[0] & 1], fact: ((digest[1] << 8) | digest[2]) % FACT_COUNT };
}

// The wait route's query value: a whole number 0..FACT_COUNT-1, nothing else (no "1e1", no " 3", no "-0").
function parseFactIndex(raw) {
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) return null;
  const index = Number(raw);
  return index < FACT_COUNT ? index : null;
}

// The stamp value for conference_path.ring_fact.
const stampFor = (choice, now = new Date()) => ({ arm: choice.arm, fact: choice.fact, at: now.toISOString() });

const COUNT_FIELDS = ['total', 'answered', 'voicemail', 'hung_up_before_answer'];
const blankCounts = () => Object.fromEntries(COUNT_FIELDS.map((f) => [f, 0]));

/**
 * ringFactReport({ since }) — read only. Per arm, the calls stamped since `since` (a Date or an ISO string):
 *   total                  calls with conference_path.ring_fact.arm = this arm
 *   answered               a staff member pressed 1: conference_path.accepted_leg_sid is set. A star-key hold
 *                          voicemail after the press 1 is still an answered call.
 *   voicemail              no press 1 and conference_path.voicemail_at is set: the ring ran out (no-answer,
 *                          busy, failed) and the caller was sent to the voicemail
 *   hung_up_before_answer no press 1, no voicemail_at, and conference_path.closed_at is set. closed_at is
 *                          written when the caller's call ends (closeForCallerEnd, from /call-status) while
 *                          the claim is still open, so the caller hung up while the phones rang. A caller
 *                          who leaves during the voicemail is a voicemail, not a hang-up: voicemail_at
 *                          is written first and closes the claim to the ring's own voicemail path.
 * A call in none of the three (still ringing, or a state the rows do not settle) shows only in total.
 * The decision the owner set: keep the fact only if hung_up_before_answer / total does not rise
 * against the ring arm. Sandbox calls (relay sandbox and tech voice sources) are not counted.
 */
async function ringFactReport({ since }) {
  const from = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(from.getTime())) throw new Error('ringFactReport needs a valid since');
  const rows = await whereNotSandboxCall(db('call_log'), 'source')
    .where('created_at', '>=', from)
    .whereRaw("(metadata #>> '{conference_path,ring_fact,arm}') IN ('fact', 'ring')")
    .select(
      db.raw("metadata #>> '{conference_path,ring_fact,arm}' AS arm"),
      db.raw("(metadata #>> '{conference_path,accepted_leg_sid}') IS NOT NULL AS accepted"),
      db.raw("(metadata #>> '{conference_path,voicemail_at}') IS NOT NULL AS voicemail"),
      db.raw("(metadata #>> '{conference_path,closed_at}') IS NOT NULL AS closed"),
    );
  const report = { since: from.toISOString(), fact: blankCounts(), ring: blankCounts() };
  for (const row of rows) {
    const arm = report[row.arm];
    if (!arm) continue;
    arm.total += 1;
    if (row.accepted) arm.answered += 1;
    else if (row.voicemail) arm.voicemail += 1;
    else if (row.closed) arm.hung_up_before_answer += 1;
  }
  return report;
}

module.exports = { ARMS, FACT_COUNT, live, choose, parseFactIndex, stampFor, ringFactReport };
