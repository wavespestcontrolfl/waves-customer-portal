/**
 * The "Waves Tech" voice line's session (GATE_TECH_VOICE_LINE, dark): a
 * technician who called the line from their own cell, admitted before
 * Twilio answered (services/tech-voice-line.js), talks to this class over
 * ConversationRelay. relay-server.js picks it from the call's call_log
 * source ('tech_voice'), proven at the WebSocket upgrade, never from a
 * setup-frame label.
 *
 * No model. Every reply is fixed wording or a read from an existing
 * service, so nothing here can invent a fact, a name or a code:
 *
 *   PIN       keypad digits, then pound (services/tech-voice-pin.js: three
 *             tries a call, a five-try lockout per technician, 45 seconds).
 *   READY     one command per utterance (COMMANDS below):
 *               "next stop" / "access" / "last treatment"
 *                   -> tech-instant-answers.js answer(), the tech IB chips'
 *               "gate code"  -> access-code-capture.js listForVisit() for
 *                   the stop, in a technician's scope (never an admin's),
 *                   with one audit_log disclosure event (never the code)
 *               "any replies" -> tech-set-texts.js setTextReply()
 *               "text gate locked" / "dog outside" / "garage"
 *                   -> read back the customer's first name, the street and
 *                   the full text; "yes" sends it through
 *                   tech-line-texts.js sendSetText() (GATE_TECH_SET_TEXTS)
 *   CONFIRM   yes or no for that one text.
 *
 * The stop is tech-instant-answers.js pickStop(): the stop the technician
 * is at (newest arrival first), else the next open stop of today's route.
 * Nothing is recorded or kept: no transcript, no lead, and the call_log row
 * never gains answered_by or call_outcome (a later inbound row with either
 * would read as a callback in missed-call-bell.js buildCalledBackSql).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { techVoiceLineLive } = require('../../config/feature-gates');
const { TECH_VOICE_SOURCE } = require('./relay-protocol');
const { applyAssignable } = require('../technician-eligibility');
const { checkTechVoicePin } = require('../tech-voice-pin');
const { pickStop, answer } = require('../tech-instant-answers');
const { techLineContext } = require('../tech-line');
const { setTextReply } = require('../tech-set-texts');
const { prepareSetText, sendSetText, visitCustomer } = require('../tech-line-texts');

const PIN_TIMEOUT_MS = 45 * 1000;
const PIN_TRIES_PER_CALL = 3;
const MAX_PIN_DIGITS = 8;

const SAY = Object.freeze({
  ready: 'Ready. Say next stop, access, last treatment, gate code, any replies, or a set text like gate locked.',
  what_next: 'What next?',
  help: 'Say next stop, access, last treatment, gate code, or any replies. To text the customer, say gate locked, dog outside, or garage. Say goodbye to hang up.',
  pin_retry: 'That PIN is not right. Enter it again, then press pound.',
  pin_wrong_final: 'That PIN is not right. Goodbye.',
  pin_none: 'No PIN is set for you yet. Ask the office to set one. Goodbye.',
  pin_locked: 'This PIN is locked for now. Call the office. Goodbye.',
  pin_timeout: 'No PIN was entered. Goodbye.',
  pin_keypad: 'Enter your PIN on the keypad, then press pound.',
  unavailable: 'The Waves tech line is not available right now. Goodbye.',
  no_stop: 'You have no open stop today.',
  no_codes: 'There is no code on file for this stop.',
  codes_failed: 'I could not read the codes for this stop. Check the app.',
  codes_off: 'Access codes are turned off right now. Check the app or call the office.',
  confirm_again: 'Say yes to send it, or no.',
  not_sent: 'Not sent. What next?',
  sent: 'Sent. What next?',
  unknown: 'Sorry, I did not get that. Say help to hear the commands.',
  failed: 'Something went wrong. Check the app, or call the office.',
  goodbye: 'Goodbye.',
});

// One command per utterance, first match wins. The code command comes first
// so "gate code" or "garage code" asks for a code, never a set text.
const COMMANDS = [
  { re: /\b(codes?|combo|combination|keypad|lock ?box)\b/i, run: 'code' },
  { re: /\bgates?\b.*\b(lock|locked|closed|shut)\b|\b(locked|closed|shut)\b.*\bgates?\b/i, run: 'setText', kind: 'gate_locked' },
  { re: /\bdogs?\b/i, run: 'setText', kind: 'dog_outside' },
  { re: /\bgarage\b/i, run: 'setText', kind: 'garage_access' },
  { re: /\b(next|current|this) (stop|customer|visit|job)\b|\bwhere am i (going|headed)\b/i, run: 'answer', kind: 'next_stop' },
  { re: /\b(last|previous) (treatment|service|visit|time)\b|\bwhat did we (do|use|spray|put down)\b/i, run: 'answer', kind: 'last_treatment' },
  { re: /\b(access|get in|entry|gate notes?)\b/i, run: 'answer', kind: 'access_notes' },
  { re: /\b(repl(y|ies|ied)|respon(d|se|ses|ded)|answer(ed)?|texted back|wrote back)\b/i, run: 'replies' },
  { re: /\b(help|commands|options|what can (i|you) (say|do))\b/i, run: 'help' },
  { re: /\b(good ?bye|bye|hang up|that'?s all|i'?m done|end (the )?call)\b/i, run: 'bye' },
];
// A text goes only on a plain yes: the whole reply, case and punctuation
// aside, is one of these phrases. A no, a "don't", a "wait" or a "but"
// anywhere means not sent ("okay, don't send it" and "yes, but wait" send
// nothing). Anything else asks again.
const YES_PHRASES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'yes please', 'send', 'send it', 'yes send', 'yes send it', 'yes send the text',
  'send the text', 'correct', 'go ahead', 'do it', 'ok', 'okay', 'ok send it', 'okay send it',
]);
const NO_RE = /\b(no|nope|not|cancel|don'?t|do not|stop|wait|hold|but|never ?mind)\b/;
function plainWords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const CODE_LABELS = {
  neighborhood_gate: 'Community gate',
  property_gate: 'Property gate',
  door: 'Door',
  lockbox: 'Lockbox',
  garage: 'Garage',
  call_box: 'Call box',
  pass: 'Visitor pass',
  other: 'Code',
};

// "4512#" -> "4 5 1 2 pound": a code is read one character at a time.
function spellCode(code) {
  return String(code || '').split('').map((ch) => ({ '#': 'pound', '*': 'star', ' ': ',' }[ch] || ch)).join(' ')
    .replace(/\s*,\s*/g, ', ');
}

function firstName(stopOrCustomer) {
  return String(stopOrCustomer?.first_name || '').trim().split(/\s+/)[0] || 'the customer';
}

// The send path's refusal, said out loud.
function refusalSpeech(out) {
  const code = out?.json?.code;
  if (out?.ambiguous || out?.json?.mayHaveSent) return 'The carrier did not confirm that text. Check the thread before sending it again.';
  if (out?.status === 404) return 'Set texts are not turned on yet.';
  if (code === 'NO_TECH_LINE') return 'You have no tech line yet, so no text went out.';
  if (code === 'VISIT_NOT_OPEN') return 'That visit is finished or is not today, so no text went out.';
  if (code === 'DUPLICATE_TEXT') return 'That text just went out to this customer.';
  if (code === 'AUTO_REPLY_IN_FLIGHT') return 'An automatic reply is going out to this customer right now. Try again in a moment.';
  if (out?.status === 403) return 'That visit is not on your route.';
  if (out?.status === 409) return 'No text went out. Check the customer in the app.';
  return 'The text did not go out. Use the app, or call the office.';
}

class TechVoiceConversation {
  constructor({ callSid, send, endSession, now = () => new Date() } = {}) {
    this.callSid = callSid;
    this._send = send;
    this._endSession = endSession;
    this._now = now;
    this.state = 'PIN';
    this.ended = false;
    this._digits = '';
    this._pinTries = 0;
    this._pending = null;
    this._chain = Promise.resolve();
    this.tech = null;
    this.actor = null;
    this._ready = this._init().catch((err) => {
      logger.error(`[tech-voice] session init failed (${String(err?.code || err?.name || 'error')})`);
      return false;
    }).then((ok) => {
      if (!ok) this._enqueue(() => this._finish(SAY.unavailable));
      return ok;
    });
    this._pinTimer = setTimeout(() => this._enqueue(() => (this.state === 'PIN' ? this._finish(SAY.pin_timeout) : null)), PIN_TIMEOUT_MS);
    this._pinTimer.unref?.();
  }

  // Re-prove the call server-side: an admitted call to the line (its own
  // call_log row and an unsettled minute reservation) from a technician who
  // is still active and dispatchable.
  async _init() {
    if (!techVoiceLineLive()) return this._refuse('gate_off');
    const row = await db('call_log').where({ twilio_call_sid: this.callSid }).first('direction', 'source', 'metadata');
    if (!row || row.direction !== 'inbound' || row.source !== TECH_VOICE_SOURCE) return this._refuse('not_a_tech_voice_call');
    const meta = typeof row.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata) || {}; } catch { return {}; } })() : (row.metadata || {});
    const usage = await db('tech_voice_usage').where({ call_sid: this.callSid }).first('technician_id', 'settled_at');
    if (!usage || usage.settled_at || !meta.technician_id || String(usage.technician_id) !== String(meta.technician_id)) {
      return this._refuse('not_admitted');
    }
    const tech = await applyAssignable(db('technicians').where({ id: usage.technician_id })).first('id', 'name');
    if (!tech) return this._refuse('technician_not_assignable');
    this.tech = tech;
    // Always a technician's scope, even for an admin who works the route.
    this.actor = Object.freeze({ techRole: 'technician', technicianId: tech.id });
    return true;
  }

  _refuse(reason) {
    logger.warn(`[tech-voice] session refused: ${reason}`);
    return false;
  }

  _enqueue(step) {
    this._chain = this._chain.then(step).catch((err) => {
      logger.error(`[tech-voice] turn failed (${String(err?.code || err?.name || 'error')})`);
      this.say(SAY.failed);
    });
    return this._chain;
  }

  say(text) {
    if (this.ended || !text) return;
    try { this._send(text); } catch (err) { logger.error(`[tech-voice] send failed (${String(err?.code || err?.name || 'error')})`); }
  }

  // Say the last line, then end the session once it has had time to play.
  _finish(text) {
    if (this.ended) return;
    this.say(text);
    this.ended = true;
    clearTimeout(this._pinTimer);
    const playMs = Math.min(8000, 1200 + 70 * String(text || '').length);
    const t = setTimeout(() => { try { this._endSession({ next: 'complete' }); } catch { /* socket closing */ } }, playMs);
    t.unref?.();
  }

  handleDtmf(digit) {
    this._enqueue(() => this._onDigit(String(digit == null ? '' : digit)));
  }

  handlePrompt(text) {
    this._enqueue(() => this._onSpeech(String(text || '')));
  }

  interrupt() { /* barge-in: nothing is buffered here */ }

  async end() {
    this.ended = true;
    clearTimeout(this._pinTimer);
  }

  async _onDigit(d) {
    if (!(await this._ready) || this.ended || this.state !== 'PIN') return;
    if (d === '#') return this._submitPin();
    if (d === '*') { this._digits = ''; return; }
    if (/^\d$/.test(d)) this._digits = (this._digits + d).slice(-MAX_PIN_DIGITS);
  }

  async _submitPin() {
    const pin = this._digits;
    this._digits = '';
    const result = await checkTechVoicePin(db, { technicianId: this.tech.id, technicianName: this.tech.name, pin, now: this._now() });
    if (result.ok) {
      this.state = 'READY';
      clearTimeout(this._pinTimer);
      return this.say(SAY.ready);
    }
    if (result.reason === 'no_pin') return this._finish(SAY.pin_none);
    if (result.reason === 'locked' || result.reason === 'locked_now') return this._finish(SAY.pin_locked);
    this._pinTries += 1;
    if (this._pinTries >= PIN_TRIES_PER_CALL) return this._finish(SAY.pin_wrong_final);
    return this.say(SAY.pin_retry);
  }

  async _onSpeech(text) {
    if (!(await this._ready) || this.ended) return;
    if (this.state === 'PIN') return this.say(SAY.pin_keypad);
    if (this.state === 'CONFIRM') return this._confirm(text);
    const command = COMMANDS.find((c) => c.re.test(text));
    if (!command) return this.say(SAY.unknown);
    if (command.run === 'help') return this.say(SAY.help);
    if (command.run === 'bye') return this._finish(SAY.goodbye);
    if (command.run === 'answer') return this._answer(command.kind);
    if (command.run === 'code') return this._codes();
    if (command.run === 'replies') return this._replies();
    return this._readBackSetText(command.kind);
  }

  async _answer(kind) {
    const out = await answer(db, kind, { technicianId: this.tech.id, now: this._now() });
    this.say([`${out.title}.`, ...out.lines].join(' '));
  }

  async _codes() {
    const access = require('../access-code-capture');
    // The access-code kill switch the HTTP route honors (GATE_ACCESS_CODES_SECTION):
    // off, no code row is read or spoken, whatever the voice line's own gate says.
    if (!access.enabled()) return this.say(SAY.codes_off);
    const stop = await pickStop(db, this.tech.id, this._now());
    if (!stop) return this.say(SAY.no_stop);
    const out = await access.listForVisit(db, this.actor, stop.id);
    if (!out || !out.ok) return this.say(SAY.codes_failed);
    const spoken = out.codes.filter((c) => c.code || c.instructions);
    // The disclosure is logged; the codes are not.
    const { recordAuditEvent } = require('../audit-log');
    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: this.tech.id,
      action: 'tech_voice.access_codes_read',
      resource_type: 'scheduled_service',
      resource_id: String(stop.id),
      metadata: { call_sid: this.callSid, count: spoken.length, kinds: [...new Set(spoken.map((c) => c.kind))] },
      critical: true,
    });
    if (!spoken.length) return this.say(SAY.no_codes);
    const lines = spoken.map((c) => [
      `${CODE_LABELS[c.kind] || 'Code'}${c.code ? `: ${spellCode(c.code)}` : ''}.`,
      // A link is no use on a call (a visitor pass is one): point at the app.
      c.instructions ? String(c.instructions).replace(/https?:\/\/\S+/gi, 'the link in the app').slice(0, 200) : null,
    ].filter(Boolean).join(' '));
    this.say(`For ${firstName(stop)} at ${stop.address_line1 || 'this stop'}. ${lines.join(' ')}`);
  }

  async _replies() {
    const stop = await pickStop(db, this.tech.id, this._now());
    if (!stop) return this.say(SAY.no_stop);
    const ctx = await techLineContext(this.tech.id, { strict: true });
    if (!ctx) return this.say('You have no tech line yet, so there are no replies to read.');
    const target = await visitCustomer(this.actor, stop.id);
    if (target.error) return this.say('I could not read that customer. Check the app.');
    const out = await setTextReply(db, {
      customerId: target.customer.id, customerPhone: target.to, lineNumber: ctx.line.number, visitIds: await this._stopVisitIds(stop), now: this._now(),
    });
    const name = firstName(target.customer);
    if (out.ambiguous) return this.say(`${name} has texts about another visit too. Check the thread in the app.`);
    if (!out.setText) return this.say(`No set text went to ${name} for this stop today.`);
    if (!out.reply) return this.say(`No reply from ${name} yet.`);
    const media = out.reply.mediaCount ? ` They also sent ${out.reply.mediaCount === 1 ? 'a picture' : `${out.reply.mediaCount} pictures`}.` : '';
    return this.say(`${name} replied: ${out.reply.body || '(no words)'}.${media}`);
  }

  // `lead` prefixes a fresh read-back ("The details changed.").
  // Every member of the stop's visit on this technician's route: a set text
  // can belong to a member other than the one pickStop leads with (a member
  // finished since), as the Visit Brief's reply card passes them all.
  async _stopVisitIds(stop) {
    const row = await db('scheduled_services').where({ id: stop.id }).first('visit_id');
    if (!row || !row.visit_id) return [stop.id];
    const ids = await db('scheduled_services')
      .where({ visit_id: row.visit_id, technician_id: this.tech.id, customer_id: stop.customer_id })
      .pluck('id');
    return [...new Set([stop.id, ...ids])];
  }

  async _readBackSetText(kind, lead = '') {
    const stop = await pickStop(db, this.tech.id, this._now());
    if (!stop) return this.say(`${lead}${SAY.no_stop} No one to text.`);
    const prepared = await prepareSetText({ actor: this.actor, scheduledServiceId: stop.id, kind });
    if (!prepared.ok) return this.say(`${lead}${refusalSpeech(prepared)}`);
    // The yes is bound to exactly what was read back: this customer, phone
    // and wording (sendSetText refuses anything else).
    this._pending = {
      kind, visitId: stop.id, customerId: prepared.target.customer.id, to: prepared.target.to, body: prepared.body,
    };
    this.state = 'CONFIRM';
    return this.say(`${lead}Text ${firstName(prepared.target.customer)} at ${stop.address_line1 || 'the address on file'}: ${prepared.body} ${SAY.confirm_again}`);
  }

  async _confirm(text) {
    const said = plainWords(text);
    if (NO_RE.test(said)) {
      this._pending = null;
      this.state = 'READY';
      return this.say(SAY.not_sent);
    }
    if (YES_PHRASES.has(said)) {
      const pending = this._pending;
      this._pending = null;
      this.state = 'READY';
      const out = await sendSetText({
        actor: this.actor,
        scheduledServiceId: pending.visitId,
        kind: pending.kind,
        expect: { customerId: pending.customerId, to: pending.to, body: pending.body },
      });
      if (out.json?.code === 'SET_TEXT_CHANGED') return this._readBackSetText(pending.kind, 'The details changed. ');
      return this.say(out.status === 200 ? SAY.sent : refusalSpeech(out));
    }
    return this.say(SAY.confirm_again);
  }
}

module.exports = { TechVoiceConversation, _test: { COMMANDS, YES_PHRASES, NO_RE, spellCode, refusalSpeech, SAY, PIN_TIMEOUT_MS } };
