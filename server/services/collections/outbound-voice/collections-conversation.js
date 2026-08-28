/**
 * CollectionsConversation — the relay-leg session mode for outbound
 * late-payment calls (PR B). Constructed by relay-server when the setup
 * frame's customParameters carry session_mode 'collections'; that hint is
 * UNVERIFIED input, so _init re-proves the mode server-side: the
 * AUTHENTICATED CallSid must resolve to a call_log row this lane originated
 * (direction 'outbound', source 'collections_voice', a linked collection
 * case). Anything else — including the master gate being off — ends the
 * session with a fixed polite close that never mentions any balance.
 *
 * STATE MACHINE (ruled): VESTIBULE happens before this session exists (the
 * fixed DTMF TwiML stage); this class owns
 *
 *   RIGHT_PARTY → VERIFY → DISCLOSE → RESOLUTION
 *
 * with STATE-KEYED tools (the #3373 fence pattern): a tool that is not valid
 * in the current state is refused IN CODE — the refusal is the tool result,
 * the prompt is not the enforcement layer.
 *
 * HARD LINES IN CODE:
 *  - RIGHT_PARTY: no balance/account detail exists in the prompt or any
 *    reachable tool until the named customer is confirmed (FCCPA third-party
 *    disclosure). Wrong party ⇒ fixed generic close + review card.
 *  - VERIFY: the second factor is SUPPLIED BY the customer (street number or
 *    billing ZIP) and compared server-side — never recited-and-agreed. The
 *    expected values never appear in prompt, tool results, or logs. No
 *    pest-service details to an unverified voice.
 *  - DISCLOSE: the balance figure comes from the openBalanceSummary read
 *    made at session init (read-only; the policy engine already decided
 *    collectibility at dial time).
 *  - Security interrupt: card/bank/routing/SSN/CVV/OTP in a caller utterance
 *    triggers FIXED copy and the utterance reaches the model only scrubbed.
 *  - Never negotiate/settle/threaten; external language is "open balance" /
 *    "billing follow-up" — model output is screened against
 *    FORBIDDEN_SPOKEN_RE before emission (fixed fallback line replaces it).
 *  - No <Pay>, no payment collection on-call. The ONE comm write is the
 *    pay-link SMS behind GATE_VOICE_LATE_PAYMENT_PAYLINK (rail-guard
 *    consulted, record-then-send through the contact ledger).
 *  - Human escape hatch in EVERY state: press 0 or ask for a human —
 *    staffed hours warm-transfer via the relay action route, otherwise a
 *    callback card. Always possible.
 */

const Anthropic = require('@anthropic-ai/sdk');
const MODELS = require('../../../config/models');
const db = require('../../../models/db');
const logger = require('../../logger');
const script = require('./script');
const { isVoiceLatePaymentEnabled, isPayLinkEnabled } = require('./gates');
const { isStaffedHours } = require('./staffed-hours');
const { callSupervision } = require('./supervision');
const { writeCallOutcome } = require('./outcomes');
const flags = require('./flags');
const { invoiceAmountDue } = require('../../invoice-helpers');
const { etCalendarDayOf } = require('../../../utils/datetime-et');
const { anchorInvoiceOf, orderByDue, dueDayOf, invoiceDaysOverdue, accountDaysOverdue, dunningTierForOverdue, registerForTier } = require('../account-anchor');

// The pay link is a /pay/:token SMS, and InvoiceService.sendViaSMS only
// CLAIMS its SEND_CLAIMABLE_STATUSES (the one sendability authority). The
// eligible set also admits legacy 'unpaid' rows, which the send path would
// refuse after the customer already agreed (gh r1) — the link rides the
// oldest-due SENDABLE invoice instead; the dunning clock still anchors on
// the oldest-due invoice of any status.
function linkAnchorOf(invoices = []) {
  const { SEND_CLAIMABLE_STATUSES } = require('../../invoice');
  return orderByDue(invoices).find((inv) => SEND_CLAIMABLE_STATUSES.includes(String(inv.status || ''))) || null;
}

const MODEL = process.env.VOICE_RELAY_MODEL || MODELS.VOICE;
const VOICE_EFFORT = 'low'; // live phone call — same rationale as relay-conversation
const MAX_TOOL_ROUNDS = 4;
const MAX_CALL_TURNS = 30;
const STREAM_TIMEOUT_MS = 20000;
const MAX_TOKENS = 512;
const TOOL_TIMEOUT_MS = 3000;
const WRITE_TOOL_TIMEOUT_MS = 8000;
const VERIFY_MAX_ATTEMPTS = 2;

const STATES = ['RIGHT_PARTY', 'VERIFY', 'DISCLOSE', 'RESOLUTION'];

// Tools valid per state — THE fence. record_do_not_call and the human escape
// are reachable from every state (an opt-out or a human request must always
// be honorable); everything else unlocks strictly forward.
const STATE_TOOLS = {
  RIGHT_PARTY: ['confirm_right_party', 'record_do_not_call', 'transfer_to_human', 'end_call'],
  VERIFY: ['verify_identity', 'record_do_not_call', 'transfer_to_human', 'end_call'],
  DISCLOSE: ['get_balance_details', 'record_do_not_call', 'transfer_to_human', 'end_call'],
  RESOLUTION: [
    'record_payment_intent', 'record_dispute', 'record_do_not_call',
    'send_pay_link', 'transfer_to_human', 'end_call',
  ],
};

// Write tools: speech on the same turn is suppressed until the result is
// known (the #3373 no-speech-before-a-write rule), and they get the longer
// timeout with a do-not-retry degradation.
const WRITE_TOOLS = new Set([
  'confirm_right_party', 'verify_identity', 'record_payment_intent',
  'record_dispute', 'record_do_not_call', 'send_pay_link', 'transfer_to_human', 'end_call',
]);

const TOOLS = [
  {
    name: 'confirm_right_party',
    description: 'Record whether the person on the line is the named customer. Call this as soon as they answer the question. wrong_party = a different person; customer_unavailable = right household but the customer cannot come to the phone.',
    input_schema: {
      type: 'object',
      properties: {
        result: { type: 'string', enum: ['confirmed', 'wrong_party', 'customer_unavailable'] },
        number_unknown: { type: 'boolean', description: 'true only if the answerer says the customer is not known at this number' },
      },
      required: ['result'],
    },
  },
  {
    name: 'verify_identity',
    description: 'Check a verification detail the customer just SAID OUT LOUD themselves — their street number, or their billing ZIP code. Never suggest or read out any value; ask them to provide it.',
    input_schema: {
      type: 'object',
      properties: {
        street_number: { type: 'string', description: 'the house/street number the customer stated' },
        billing_zip: { type: 'string', description: 'the 5-digit billing ZIP the customer stated' },
      },
    },
  },
  {
    name: 'get_balance_details',
    description: 'Get the open balance amount and invoice context to share with the verified customer.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'record_payment_intent',
    description: 'Record the date the customer says they intend to make the payment (their words, as a calendar date).',
    input_schema: {
      type: 'object',
      properties: {
        intended_payment_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['intended_payment_date'],
    },
  },
  {
    name: 'record_dispute',
    description: 'The customer disputes the charge or says the bill is wrong. Records the dispute, puts all billing follow-up on hold, and alerts the office. Use their own words in the summary.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
  {
    name: 'record_do_not_call',
    description: 'The person asks us to stop automated calls (or all calls). Records it immediately.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['automated_calls', 'all_calls'] },
        verbatim_request: { type: 'string' },
      },
      required: ['scope'],
    },
  },
  {
    name: 'send_pay_link',
    description: 'Text the customer a secure payment link for the open invoice. Only after they EXPLICITLY agree to receive a text — pass their agreeing words verbatim.',
    input_schema: {
      type: 'object',
      properties: {
        customer_agreement_verbatim: {
          type: 'string',
          description: "The customer's own words agreeing to receive the text, e.g. 'yes, text it to me'.",
        },
      },
      required: ['customer_agreement_verbatim'],
    },
  },
  {
    name: 'transfer_to_human',
    description: 'The person wants a human. During office hours this connects them; after hours it files a callback for the office.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'end_call',
    description: 'Politely end the call after saying goodbye.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ── Security interrupt patterns (beyond PANs, which pan-scrub owns) ────────
const SENSITIVE_UTTERANCE_RE = new RegExp(
  [
    '\\b\\d{3}[- ]\\d{2}[- ]\\d{4}\\b', // SSN shape
    '\\b(?:social security|ssn)\\b',
    '\\brouting (?:number|#)\\b',
    // Ordinary phrasing too (gh prb-r14): "my routing is 021000021" and
    // "my checking account is 123456789" carry no "number" label and are
    // too short for the PAN scrubber.
    '\\brouting\\b[^.]{0,25}\\d{4,}',
    '\\b(?:checking|savings|bank)\\s+account\\b[^.]{0,25}\\d{4,}',
    '\\baccount number\\b[^.]{0,20}\\d{4,}',
    '\\bcvv\\b|\\bsecurity code\\b|\\bcard number\\b',
    '\\b(?:one[- ]time|verification) (?:code|password|pin)\\b',
    // Unqualified "my PIN is 1234" / "the code is 123456" (gh prb-r16) —
    // too short for the PAN scrubber. ZIP/area/postal codes are carved out
    // (verification turns legitimately say "my zip code is 34208").
    '(?<!zip )(?<!area )(?<!postal )\\b(?:pin|passcode|password|code)\\b[^.]{0,15}\\d{3,}',
  ].join('|'),
  'i',
);

function utteranceHasSensitiveDetails(text) {
  try {
    const { scrubPansDetailed } = require('../../../utils/pan-scrub');
    // { text, count } — count > 0 means a PAN/CVV was found and scrubbed.
    if (scrubPansDetailed(String(text || '')).count > 0) return true;
  } catch { /* fall through to the regex screen */ }
  return SENSITIVE_UTTERANCE_RE.test(String(text || ''));
}

const HUMAN_REQUEST_RE = /\b(human|real person|actual person|representative|operator|speak (?:to|with) (?:someone|somebody|a person)|talk (?:to|with) (?:someone|somebody|a person))\b/i;

// Spoken opt-outs recorded IN CODE (combo escapes + the turn-cap failsafe).
// Widened (gh prb-r8); broad-scope phrasing (gh prb-r11) additionally writes
// do_not_call — "all calls"/"do not contact" is not an automated-only ask.
// "stop these automated calls" / "stop the robot calls" / "stop the calls"
// ride the `stop … calls` arm (gh prb-r14) — the model must never be the
// only thing standing between a stop request and the flag.
const SPOKEN_OPT_OUT_RE = /\b(stop calling|stop(?: \w+){0,2} calls|don'?t call|do not call|no more calls|take me off|remove me from|never call|revoke (my )?consent|opt(-| )?out|quit calling|don'?t contact|do not contact)\b/i;
const BROAD_OPT_OUT_RE = /\b(?:all|any) calls?\b|\bdon'?t contact\b|\bdo not contact\b|\bnever call\b|\bno more calls\b|\btake me off\b|\bremove me from\b/i;

// The consequences (A2's account dunning sequence, GATE_ACCOUNT_DUNNING)
// exist ONLY as state on customer_dunning_sequences: hold_applied_at = the
// service hold A2 actually placed (tier 30); consequence_due_at = the
// cancellation deadline it actually set (tier 60). customers.service_paused_at
// is NOT a scheduling hold (it only stops the dues cron — see migration
// 20260801200000), so it never authorizes "service is paused". Until the
// table ships, or when the read fails, both are null — and null is never
// spoken. Read-only, best-effort.
async function readDunningState(customerId) {
  if (!customerId) return { holdAppliedAt: null, consequenceDueAt: null };
  try {
    const row = await db('customer_dunning_sequences').where({ customer_id: customerId }).first('hold_applied_at', 'consequence_due_at');
    return {
      holdAppliedAt: row && row.hold_applied_at ? row.hold_applied_at : null,
      consequenceDueAt: row && row.consequence_due_at ? row.consequence_due_at : null,
    };
  } catch {
    return { holdAppliedAt: null, consequenceDueAt: null }; // table absent (pre-A2) or unreadable ⇒ no consequence
  }
}

// The three registers (owner ruling 2026-08-28). Consequence sentences are
// spoken ONLY when the gated truth is present in the tool result — the
// prompt never carries them on its own.
const REGISTER_RULES = {
  friendly: [
    '- REGISTER: FRIENDLY REMINDER. Assume they simply missed or forgot the invoice. Warm, brief, no pressure; no mention of holds, cancellation, or consequences of any kind.',
  ],
  firm: [
    '- REGISTER: FIRM. Be direct and matter-of-fact: the account is past due. No cheerfulness, no exclamation marks, shorter sentences. State a consequence ONLY if the balance tool result explicitly authorizes it — otherwise state none.',
  ],
  final: [
    '- REGISTER: FINAL NOTICE. Calm, direct, serious; this is the last automated call about this balance. State the consequence ONLY if the balance tool result explicitly authorizes it, using its exact wording — otherwise say only that this is a final reminder and the office will follow up.',
  ],
};

function buildSystemPrompt({ firstName, today, register = 'friendly' }) {
  const who = firstName || 'the customer';
  return [
    'You are Sandy, the automated billing assistant for Waves Pest Control, on a RECORDED outbound phone call about an open balance. Keep every reply to one or two short spoken sentences. Never use emojis or read out symbols.',
    // The current ET calendar date rides the prompt (gh prb-r11): without
    // it, "this Friday" becomes a guessed YYYY-MM-DD that passes the 90-day
    // validator and lands next_eligible_at on the wrong day.
    ...(today ? [`Today's date is ${today} (US Eastern). Use it to convert any relative date the customer gives ("this Friday", "in two weeks") into the exact calendar date before calling record_payment_intent.`] : []),
    '',
    'NON-NEGOTIABLE RULES:',
    `- FIRST confirm you are speaking with ${who} (call confirm_right_party). Until confirmed AND verified, never mention any balance, invoice, service, or account detail of any kind.`,
    '- If it is the wrong person, apologize for the interruption and end the call without saying why you called.',
    '- After confirmation, verify identity: ask the customer to tell you their street number OR their billing ZIP code, then call verify_identity with what they said. NEVER read out, suggest, or confirm any address, ZIP, or account detail yourself — they must supply it.',
    '- Only after verification, use get_balance_details and share the open balance plainly and courteously: state the TOTAL account balance, then name each open invoice briefly (service and date) as the tool lists them, and ask to take care of the full balance today. If they can only cover part of it, accept that gracefully and record the date they give for the rest.',
    '- Never mention late fees, interest, or collection costs — Waves charges none on this account.',
    ...(REGISTER_RULES[register] || REGISTER_RULES.friendly),
    '- Say "open balance" or "billing follow-up". NEVER say "collections", "debt", or "delinquent". Never threaten, pressure, negotiate, settle, or discount. You have no authority over amounts.',
    '- NEVER take a payment or any card, bank, or account numbers on this call. ALWAYS offer to text the secure payment link (send_pay_link) — the balance tool result says what it covers; send it as soon as they agree to receive the text.',
    '- If they give a date they intend to pay, record it with record_payment_intent and thank them. Do not press for a date if they do not offer one; asking once is fine.',
    '- If they dispute the bill, use record_dispute and assure them the office will review it before any further notices.',
    '- If they ask you to stop calling, use record_do_not_call immediately and confirm it is done.',
    '- If they ask for a human at any point, use transfer_to_human.',
    '- Answer no questions about services, schedules, or account history on this call — offer the office number for anything beyond the balance.',
    '- If a tool refuses an action, accept the refusal — do not retry or work around it.',
    '- End the call with end_call once the conversation is complete.',
  ].join('\n');
}

let anthropic = null;
function getClient() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

class CollectionsConversation {
  constructor({ callSid, from, to, send, endSession, now = () => new Date() } = {}) {
    this.callSid = callSid;
    this.from = from;
    this.to = to;
    this._send = send;
    this._endSession = endSession;
    this._now = now;
    this.state = 'RIGHT_PARTY';
    this.verified = false;
    this.verifyAttempts = 0;
    this.disclosed = false;
    this.payLinkSent = false;
    this.ended = false;
    this.messages = [];
    this._turns = [];
    this._startedAt = Date.now();
    this._turnCount = 0;
    this._chain = Promise.resolve();
    this._captures = {};
    this._outcome = null;
    this._ctx = null; // { callLogId, caseId, caseVersion, customer, balance }
    this._contextReady = this._init().catch((err) => {
      logger.error(`[collections-voice] session init failed callSid=${this.callSid}: ${err.message}`);
      return false;
    });
  }

  // ── init: re-prove the session mode server-side ──────────────────────────
  async _init() {
    if (!isVoiceLatePaymentEnabled()) return this._refuse('gated_off');
    const row = await db('call_log')
      .where({ twilio_call_sid: this.callSid })
      .first();
    if (!row || row.direction !== 'outbound' || row.source !== 'collections_voice') {
      return this._refuse('not_a_collections_call');
    }
    const meta = typeof row.metadata === 'string'
      ? (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })()
      : (row.metadata || {});
    if (!meta.collectionCaseId) return this._refuse('no_case_linkage');
    // Admin-approved calls may ride the owner call-window override for the
    // staffed-hours (transfer vs callback) branch; autodial calls never do.
    // Immutable call_log stamp from origination only (codex #3560 P2/P0 +
    // hook) — the case's approved_by is mutable; stamp-less = unsupervised.
    this._supervised = callSupervision(meta);
    const caseRow = await db('collection_cases').where({ id: meta.collectionCaseId }).first();
    const customer = caseRow
      ? await db('customers').where({ id: caseRow.customer_id }).whereNull('deleted_at')
        .first('id', 'first_name', 'last_name', 'phone', 'address_line1', 'zip')
      : null;
    if (!caseRow || !customer) return this._refuse('case_or_customer_missing');
    // The case must belong to the authenticated call row's customer (gh
    // prb-r8): a repointed/merged case id in metadata must never hand this
    // session another customer's balance.
    if (String(caseRow.customer_id) !== String(row.customer_id)) {
      return this._refuse('case_customer_mismatch');
    }

    // ONE session EVER per collections call (gh prb-r8): a reconnect's
    // fresh token passes the burn check, so the atomic claim on the call
    // row is the boundary — the conditional UPDATE lands once; a duplicate
    // socket refuses. Deliberately simpler than the inbound lane's
    // generation ladder (DECISIONS-PRB #14): losing a genuinely dropped
    // call is the safe direction for a supervised outbound pilot, never
    // two live sessions double-writing.
    const claimed = await db('call_log')
      .where({ id: row.id })
      .whereRaw("COALESCE(metadata->>'collections_session_claimed_at', '') = ''")
      .update({
        metadata: db.raw(
          "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ collections_session_claimed_at: new Date().toISOString() })],
        ),
      });
    if (!claimed) return this._refuse('session_already_claimed');

    // From here on THIS session holds the one-ever claim (gh prb-r9): a
    // fallible read failing now would otherwise refuse the session with a
    // plain complete frame, no failure handoff, and _persist skipping on a
    // null _ctx — the case stranded in 'dialing' forever. Reconcile it in
    // the failure path itself: the fenced relay_failed outcome returns the
    // case to the review queue (onlyIfNoOutcome is belt-and-braces — we
    // hold the claim, so no live session is mid-conversation on this call).
    try {
      // Balance from the SAME eligible-invoice authority the policy used at
      // dial time (codex prb-r1: openBalanceSummary omits legacy 'unpaid'
      // rows the policy admits — a customer approved solely for one was told
      // their account was settled). Read-only; the policy decided
      // collectibility at dial, this only supplies data.
      const { loadEligibleInvoices } = require('../contact-policy');
      const eligibleInvoices = await loadEligibleInvoices(customer.id);
      const balance = {
        total: eligibleInvoices.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0),
        count: eligibleInvoices.length,
        invoices: eligibleInvoices,
      };

      this._ctx = {
        callLogId: row.id,
        caseId: caseRow.id,
        caseVersion: caseRow.case_version,
        customer,
        balance,
        // register / holdActive / consequenceDueAt / payLinkCoversAccount —
        // refreshed again at disclosure time (see _accountState).
        ...(await this._accountState(customer.id, eligibleInvoices)),
        // The number this call was DIALED to (gh prb-r16): verification and
        // SMS consent happened on this number — a send must never follow a
        // mid-call phone edit to a number that did neither.
        dialedPhone: row.to_phone || null,
        // The pay-link target is the LIVE eligible set's OLDEST-DUE invoice
        // (gh prb-r5 + hook r2): the balance disclosed in-call is computed
        // from it, and a link to a snapshot invoice paid since dialing would
        // contradict the spoken figure. Snapshot ids stay on the case row.
        invoiceId: linkAnchorOf(eligibleInvoices)?.id || null,
      };
      return true;
    } catch (err) {
      logger.error(`[collections-voice] post-claim init failed callSid=${this.callSid} callLog=${row.id}: ${err.message}`);
      await writeCallOutcome(row.id, { outcome: 'relay_failed', onlyIfNoOutcome: true })
        .catch((outcomeErr) => logger.error(`[collections-voice] post-claim init reconciliation failed callLog=${row.id}: ${outcomeErr.message}`));
      return this._refuse('init_failed_post_claim');
    }
  }

  _refuse(reason) {
    logger.warn(`[collections-voice] refusing collections session callSid=${this.callSid}: ${reason}`);
    this._refused = reason;
    return false;
  }

  say(text) {
    if (this.ended || !text) return;
    // Pre-DISCLOSURE, ANY balance/invoice vocabulary is withheld (gh
    // prb-r4; tightened prb-r15): verification alone does not license a
    // figure — until get_balance_details has SUCCEEDED (this.disclosed),
    // any spoken amount would be model-invented, not the live authority's.
    let screened = text;
    // (The fixed SECURITY_INTERRUPT is exempt — it names "payment link"
    // without confirming any balance exists.)
    if (!this.disclosed && screened !== script.SECURITY_INTERRUPT
        && script.PRE_VERIFY_FORBIDDEN_RE.test(screened)) {
      screened = this.verified
        ? 'Let me pull up the exact details first — one moment.'
        : script.PRE_VERIFY_DEFLECTION;
    }
    // Belt-and-braces language screen on EVERYTHING spoken (model or fixed).
    const line = script.FORBIDDEN_SPOKEN_RE.test(screened)
      ? 'Our office can go over the details with you directly. Is there anything else I can help with?'
      : screened;
    this._turns.push({ role: 'agent', text: line, at: Date.now() });
    try { this._send(line); } catch (e) { logger.error(`[collections-voice] send failed: ${e.message}`); }
  }

  handlePrompt(text) {
    this._chain = this._chain
      .then(() => this._handlePrompt(text))
      .catch((err) => logger.error(`[collections-voice] turn failed callSid=${this.callSid}: ${err.message}`));
  }

  handleDtmf(digit) {
    if (String(digit) === '0') {
      // Preempt the RUNNING model turn too (gh prb-r6): the loop checks
      // this flag between steps and short-circuits to the escape instead
      // of speaking or executing writes first.
      this._escapeRequested = true;
      this._chain = this._chain
        // Session proof first (gh prb-r3): a 0 pressed immediately after
        // relay setup must not run the escape before _ctx carries the
        // call-log linkage — the outcome would persist nowhere.
        .then(() => this._contextReady)
        // Session proof FAILED (gate off / no valid linkage) ⇒ no action
        // (gh prb-r7): a press-0 must not run the escape ladder for a
        // session the door refused.
        .then((ok) => (ok === false || this._refused ? undefined : this._humanEscape()))
        .catch((err) => logger.error(`[collections-voice] dtmf escape failed: ${err.message}`));
    }
  }

  interrupt() { /* barge-in: nothing buffered server-side to cancel */ }

  // The follow-up promise needs an artifact, EVERYWHERE (gh prb-r15/r16):
  // shared by the tool-timeout, tool-error, and round-exhaustion paths.
  // Returns the card (truthy = the promise may be spoken) or null. A card
  // counts ONLY with a real id (gh prb-r19): notifyAdmin can resolve the
  // truthy suppressed sentinel { id: null, suppressed: true } when the
  // bell policy mutes the category — no row exists, so no promise.
  async _fileFollowUpCard(detail) {
    try {
      const NotificationService = require('../../notification-service');
      const card = await NotificationService.notifyAdmin(
        'billing',
        'Follow-up needed after automated billing call',
        detail,
        { link: `/admin/customers/${this._ctx?.customer?.id}`, metadata: { source: 'collections_voice', callLogId: this._ctx?.callLogId } },
      );
      return card && card.id ? card : null;
    } catch (cardErr) {
      logger.error(`[collections-voice] follow-up card failed: ${cardErr.message}`);
      return null;
    }
  }

  // Same rule for every other card site in this file.
  static _cardPersisted(card) {
    return Boolean(card && card.id) ? card : null;
  }

  // Grounding sources (gh prb-r12): what the CALLER actually said, for
  // code-level checks that must never trust a model-authored paraphrase.
  _lastCallerText() {
    for (let i = this._turns.length - 1; i >= 0; i--) {
      if (this._turns[i].role === 'caller') return String(this._turns[i].text || '');
    }
    return '';
  }

  // Complete digit TOKENS the caller spoke (gh prb-r13): substring matching
  // authenticated values the caller never supplied as that factor (street
  // "12" inside a mis-said ZIP "34212"). A candidate grounds only as an
  // exact spoken token, or as the whole turn's digits run together (the
  // "3 4 2 0 8" transcription shape).
  _recentCallerDigitTokens(turnsBack = 2) {
    const tokens = new Set();
    let seen = 0;
    for (let i = this._turns.length - 1; i >= 0 && seen < turnsBack; i--) {
      if (this._turns[i].role !== 'caller') continue;
      seen++;
      const text = String(this._turns[i].text || '');
      const turnTokens = text.match(/\d+/g) || [];
      turnTokens.forEach((t) => tokens.add(t));
      // The joined form is added ONLY for a genuinely spaced-digit answer:
      // individual digits separated by whitespace and nothing else (gh
      // prb-r15 — "41, 28" is two separate values, not one spoken number;
      // punctuation or multi-digit groups never join). A mixed answer just
      // re-asks for bare digits.
      if (turnTokens.length > 1 && /^\d(?:\s+\d)*$/.test(text.trim())) tokens.add(turnTokens.join(''));
    }
    return tokens;
  }

  // Spoken opt-out recorded in CODE — shared by the combo human-escape
  // branch and the turn-cap failsafe (gh prb-r11). Broad phrasing carries
  // the FULL scope: do_not_call is written too, independently, and the
  // fallback card names every flag that failed.
  async _recordSpokenOptOut(rawText) {
    if (!SPOKEN_OPT_OUT_RE.test(rawText)) return;
    // A NEGATED or corrective phrasing must not opt anyone out (gh
    // prb-r19): "please don't stop calling me" / "I never said stop
    // calling" embed the trigger phrase but express the opposite intent.
    if (/\b(don'?t stop|do not stop|never said|didn'?t (?:say|mean|ask)|did not (?:say|mean|ask)|keep calling|not asking (?:you )?to stop|no need to stop)\b/i.test(rawText)) {
      return;
    }
    // An explicit automated-only qualifier ("remove me from the automated
    // call list") narrows the scope (gh prb-r12): do_not_call would block
    // permitted manual calls contrary to the caller's stated ask.
    const automatedOnly = /\b(automated|automatic|robo\w*|recorded|these (?:automated )?calls)\b/i.test(rawText);
    const broad = !automatedOnly && BROAD_OPT_OUT_RE.test(rawText);
    const rev = await flags.revokeAutomatedVoiceConsent(this._ctx.customer.id, {
      reason: 'spoken opt-out during a billing follow-up call (recorded in code)',
    }).catch(() => ({ ok: false }));
    let dnc = { ok: true };
    if (broad) {
      dnc = await flags.writeFlag({
        customerId: this._ctx.customer.id,
        flag: 'do_not_call',
        reason: 'broad spoken opt-out ("all calls"/"do not contact") during a billing follow-up call',
      }).catch(() => ({ ok: false }));
    }
    if ((rev && rev.ok) || (broad && dnc && dnc.ok)) this._captures.consentRevoked = true;
    const revFailed = !(rev && rev.ok);
    const dncFailed = broad && !(dnc && dnc.ok);
    // Full-scope completion is tracked SEPARATELY (gh prb-r16): a broad
    // request whose do_not_call half failed must not be confirmed as done —
    // manual calls remain permitted until the fallback card is worked.
    this._optOutFullyRecorded = !revFailed && !dncFailed;
    if (revFailed || dncFailed) {
      const flagsNeeded = [
        ...(revFailed ? ['automated_voice_consent_revoked'] : []),
        ...(dncFailed ? ['do_not_call'] : []),
      ].join(' AND ');
      try {
        const NotificationService = require('../../notification-service');
        await NotificationService.notifyAdmin(
          'billing',
          'Opt-out needs manual action',
          `A customer asked to stop ${broad ? 'ALL calls' : 'automated calls'} on a billing follow-up call, and a durable flag write failed. Please set ${flagsNeeded} by hand.`,
          { link: `/admin/customers/${this._ctx.customer.id}`, metadata: { source: 'collections_voice', callLogId: this._ctx.callLogId } },
        );
      } catch (cardErr) {
        logger.error(`[collections-voice] spoken opt-out fallback card failed: ${cardErr.message}`);
      }
    }
  }

  async _handlePrompt(rawText) {
    if (this.ended) return;
    const ok = await this._contextReady;
    if (!ok || !this._ctx) {
      // Fail closed: no context = a fixed close with zero account content.
      this.say(script.RELAY_FAILURE_CLOSE);
      return this._finish('relay_failed', { endSession: true });
    }
    // Human escape by phrase — any state, checked in CODE before the model
    // AND before the turn cap (gh prb-r11): an opt-out or human request on
    // the capped turn must still be honored, never swallowed by a goodbye.
    if (HUMAN_REQUEST_RE.test(rawText)) {
      // "Stop calling me and let me speak to a person" (gh prb-r7): the
      // opt-out half must be RECORDED before the escape ends the session —
      // the model never sees this utterance.
      await this._recordSpokenOptOut(rawText);
      // The SAME whole-utterance sensitive screen the model path gets (gh
      // prb-r9): the escape capture rides a durable admin card, and a PAN
      // scrub alone would forward an SSN/routing/account number verbatim.
      if (utteranceHasSensitiveDetails(rawText)) {
        this._captures.humanEscapeUtterance = '[utterance withheld — sensitive detail]';
      } else {
        try {
          const { scrubPans } = require('../../../utils/pan-scrub');
          this._captures.humanEscapeUtterance = scrubPans(String(rawText)).slice(0, 200);
        } catch { this._captures.humanEscapeUtterance = null; }
      }
      return this._humanEscape();
    }

    if (++this._turnCount > MAX_CALL_TURNS) {
      // The cap's goodbye must not swallow a spoken opt-out either (gh
      // prb-r11): the model is out of turns, so the code records it.
      await this._recordSpokenOptOut(rawText);
      this.say('Thanks for your time today. Goodbye.');
      return this._finish(this._defaultOutcome(), { endSession: true });
    }

    // Security interrupt: fixed copy, and the model sees only scrubbed text.
    let callerText = String(rawText || '');
    // Cross-TURN screen (gh prb-r18): a PAN read in pauses ("4242 4242" …
    // "4242 4242") arrives as fragments no single-turn check can see — the
    // same split-turn shape the transcript writer already handles with
    // scrubSegments. When the joined window trips, the current turn is
    // withheld AND the prior fragments are sanitized out of the model
    // history, so the next request cannot carry a reconstructable number.
    let crossTurnSensitive = false;
    if (!utteranceHasSensitiveDetails(callerText)) {
      try {
        const { scrubSegments } = require('../../../utils/pan-scrub');
        // Five prior turns, not two (gh prb-r19): a card read in four
        // natural STT chunks ("4242" ×4) must land inside one window.
        const priorTexts = [];
        for (let i = this._turns.length - 1; i >= 0 && priorTexts.length < 5; i--) {
          if (this._turns[i].role === 'caller') priorTexts.unshift(String(this._turns[i].text || ''));
        }
        if (priorTexts.length) {
          crossTurnSensitive = scrubSegments(
            [...priorTexts, callerText].map((t) => ({ text: t })),
          ).count > 0;
        }
      } catch { /* best-effort; the single-turn screens still ran */ }
    }
    if (crossTurnSensitive) {
      const WITHHELD = '[utterance withheld — sensitive detail]';
      let sanitized = 0;
      for (let i = this.messages.length - 1; i >= 0 && sanitized < 5; i--) {
        const m = this.messages[i];
        if (m.role === 'user' && typeof m.content === 'string' && /\d/.test(m.content)) {
          m.content = WITHHELD;
          sanitized++;
        }
      }
      for (let i = this._turns.length - 1, s = 0; i >= 0 && s < 5; i--) {
        if (this._turns[i].role === 'caller' && /\d/.test(String(this._turns[i].text || ''))) {
          this._turns[i].text = WITHHELD;
          s++;
        }
      }
      this._turns.push({ role: 'caller', text: WITHHELD, at: Date.now() });
      this.say(script.SECURITY_INTERRUPT);
      this.messages.push({ role: 'user', content: `${WITHHELD}\n[system note: the caller tried to share payment details; you already told them you cannot take payment information on this call.]` });
      return;
    }
    if (utteranceHasSensitiveDetails(callerText)) {
      // An opt-out RIDING a sensitive utterance ("stop calling me, my SSN
      // is …") must still be recorded (gh prb-r12): this branch withholds
      // the utterance and returns before the model ever sees it, so the
      // code is the only place the stop request can land. The recorder
      // writes only FIXED reason strings — nothing sensitive persists.
      const optedOut = SPOKEN_OPT_OUT_RE.test(callerText);
      if (optedOut) await this._recordSpokenOptOut(callerText);
      try {
        const { scrubPans } = require('../../../utils/pan-scrub');
        // The WHOLE utterance is withheld on any sensitive match (gh
        // prb-r3): a partial, label-anchored replace left trailing digits
        // and second values (routing number + SSN) in the transcript.
        callerText = SENSITIVE_UTTERANCE_RE.test(callerText)
          ? '[utterance withheld — sensitive detail]'
          : scrubPans(callerText);
      } catch {
        callerText = '[caller shared sensitive payment details — withheld]';
      }
      this._turns.push({ role: 'caller', text: callerText, at: Date.now() });
      this.say(script.SECURITY_INTERRUPT);
      this.messages.push({ role: 'user', content: `${callerText}\n[system note: the caller tried to share payment details; you already told them you cannot take payment information on this call.${this._captures.consentRevoked ? ' They also asked to stop these calls — that has been recorded; acknowledge it.' : ''}]` });
      return;
    }

    // An ORDINARY spoken opt-out persists deterministically BEFORE the
    // model sees it (gh prb-r13): the model may answer with plain text or
    // end the call without ever emitting record_do_not_call, and the
    // suppression must not depend on it. The model is told it is done so
    // it confirms instead of re-recording.
    let modelContent = callerText;
    if (SPOKEN_OPT_OUT_RE.test(callerText)) {
      await this._recordSpokenOptOut(callerText);
      if (this._captures.consentRevoked) {
        // Partial persistence gets partial copy (gh prb-r16): the model
        // must not confirm a broad stop whose do_not_call half failed.
        modelContent = this._optOutFullyRecorded
          ? `${callerText}\n[system note: the caller's stop-calling request has already been recorded in code — confirm it is done; do not call record_do_not_call again unless they ask for a different scope.]`
          : `${callerText}\n[system note: part of the caller's stop request was recorded, but part could not be — tell them a person will make sure the full request is honored; do not say it is fully done.]`;
      }
    }
    this._turns.push({ role: 'caller', text: callerText, at: Date.now() });
    this.messages.push({ role: 'user', content: modelContent });
    await this._modelTurn();
  }

  _activeTools() {
    const names = new Set(STATE_TOOLS[this.state] || []);
    return TOOLS.filter((t) => names.has(t.name));
  }

  // ONE clock per customer: the register (friendly / firm / final) comes
  // from the OLDEST-due open invoice, and the consequence lines are gated on
  // TRUE state — never asserted (owner ruling + FCCPA: no consequence the
  // system does not carry out). Read at init AND again at disclosure (hook
  // P1): a payment, a cleared hold, or a withdrawn deadline during
  // verification must not leave a stale authorization. Fail closed: an
  // unreadable hold / deadline is NO consequence.
  async _accountState(customerId, invoices) {
    const tier = dunningTierForOverdue(accountDaysOverdue(this._now(), invoices));
    // Consequence state = what A2 actually did (hook r5): a placed hold, a
    // set deadline. Nothing else authorizes a consequence sentence.
    const { holdAppliedAt, consequenceDueAt } = await readDunningState(customerId);
    const holdActive = Boolean(holdAppliedAt);
    // The pay link is /pay/:token of the OLDEST-DUE open invoice. Under
    // GATE_PAY_INCLUDE_BALANCE that page bundles the customer's other open
    // self-pay invoices into ONE combined charge (pay-combined.js, owner
    // ruling 2026-08-16) — but its selection can degrade (gate off, payer
    // anchor, incomplete sibling read, live PI on a sibling, over-cap,
    // dunning-stopped rows). Ask the SAME selector /pay uses (hook r2 P1):
    // what she promises and what the ledger records is what the link would
    // actually collect. Any failure degrades to the anchor alone.
    const anchor = linkAnchorOf(invoices);
    let payLinkInvoiceIds = anchor ? [String(anchor.id)] : [];
    if (anchor && invoices.length > 1) {
      try {
        const PayCombined = require('../../pay-combined');
        const siblings = await PayCombined.combinedEligibleSiblings(
          { ...anchor, customer_id: customerId }, // open-balance rows carry no customer_id
          { reusePaymentIntentId: anchor.stripe_payment_intent_id || null },
        );
        // Intersect with the refreshed snapshot (hook r4): the probe is a
        // second live read — an invoice joining between the two must not be
        // recorded or promised while the spoken itemization omits it.
        const snapshot = new Set(invoices.map((inv) => String(inv.id)));
        if (Array.isArray(siblings)) {
          payLinkInvoiceIds.push(...siblings.map((inv) => String(inv.id)).filter((id) => snapshot.has(id) && !payLinkInvoiceIds.includes(id)));
        }
      } catch (err) {
        logger.warn(`[collections-voice] combined pay-link scope probe failed callSid=${this.callSid}: ${err.message} — anchor invoice only`);
      }
    }
    const covered = new Set(payLinkInvoiceIds);
    const payLinkCoversAccount = invoices.length > 0 && invoices.every((inv) => covered.has(String(inv.id)));
    return { tier, register: registerForTier(tier), holdActive, consequenceDueAt, payLinkInvoiceIds, payLinkCoversAccount };
  }

  // The FRESH eligible set → balance, link anchor, register/hold/deadline
  // and pay-link scope, in one place (disclosure, send time, credit-cover
  // re-read). Returns { incomplete, fresh }; on an incomplete read NOTHING
  // is updated — the caller discloses/sends nothing on a partial account.
  // Denials that are about THIS call's own existence or timing — they were
  // satisfied at dial time and cannot legitimately re-deny a connected call
  // (the 24h/7d windows would find this very call's ledger row; the call
  // window can close while the customer is on the line).
  static get MID_CALL_IGNORED_DENIALS() {
    return new Set(['outside_call_window', 'contact_within_24h', 'voice_contact_within_7d', 'live_conversation_within_7d']);
  }

  // The FRESH eligible set → balance, link anchor, register/hold/deadline
  // and pay-link scope, in one place (disclosure, send time, credit-cover
  // re-read). `callable` = the LIVE contact policy still allows this
  // account (hook r7: a payment-plan flag, a microdeposit-pending invoice,
  // a joined older invoice, a cleared anchor, a missing touch floor — every
  // account-shaped denial the policy knows, not a hand-rolled subset).
  // Returns { incomplete, fresh, callable, notCallable }; on an incomplete
  // read NOTHING is updated — the caller discloses/sends nothing.
  async _refreshBalance() {
    const ContactPolicy = require('../contact-policy');
    let incomplete = null;
    const fresh = await ContactPolicy.loadEligibleInvoices(this._ctx.customer.id, { onIncomplete: (reason) => { incomplete = reason; } });
    if (incomplete) return { incomplete, fresh, callable: false, notCallable: 'incomplete' };
    let notCallable = null;
    if (fresh.length) {
      const verdict = await ContactPolicy.evaluate(this._ctx.customer.id, {
        channel: 'voice', purpose: 'late_payment', now: this._now(),
        supervisedDial: this._supervised === true, excludeCollectionCaseId: this._ctx.caseId,
      });
      // The verdict's own set must be the set we are about to disclose —
      // two reads that disagree are an incomplete picture, not a total.
      if (Array.isArray(verdict.eligibleInvoiceIds)) {
        const a = fresh.map((inv) => String(inv.id)).sort().join(',');
        const b = verdict.eligibleInvoiceIds.map(String).sort().join(',');
        if (a !== b) return { incomplete: 'policy set differs from the loaded set', fresh, callable: false, notCallable: 'incomplete' };
      }
      const live = (verdict.denialReasons || []).filter((r) => !CollectionsConversation.MID_CALL_IGNORED_DENIALS.has(String(r).split(':')[0]));
      if (!verdict.allowed && live.length) notCallable = live[0];
    }
    this._ctx.balance = {
      total: fresh.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0),
      count: fresh.length,
      invoices: fresh,
    };
    this._ctx.invoiceId = linkAnchorOf(fresh)?.id || null;
    Object.assign(this._ctx, await this._accountState(this._ctx.customer.id, fresh));
    return { incomplete: null, fresh, callable: fresh.length > 0 && !notCallable, notCallable };
  }

  // ONE neutral copy for a refreshed account the policy no longer allows
  // (hook r7): the anchor may have been paid, stopped, re-dated or joined
  // by an older invoice — nothing here is proven, so nothing is asserted.
  _notCallableCopy(notCallable, { atSend = false } = {}) {
    logger.info(`[collections-voice] account no longer callable mid-call callSid=${this.callSid}: ${notCallable}`);
    return `${atSend ? 'Do not send the link: ' : ''}The account has changed since we dialed and this call may not collect on it now. Do NOT state any figure, do NOT ask for payment or offer a link, and do NOT say anything was paid, is current, or is settled. Say the office will follow up, thank the customer, and end politely.`;
  }

  _ensureSystemBlocks() {
    if (this._systemBlocks && this._promptRegister === this._ctx.register) return;
    // ET calendar day + weekday via datetime-et / an explicit timeZone —
    // never raw new Date() ET math (the timestamptz trap).
    let today = null;
    try {
      const now = this._now();
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(now);
      today = `${weekday}, ${etCalendarDayOf(now)}`;
    } catch (err) {
      logger.warn(`[collections-voice] ET date for prompt failed: ${err.message}`);
    }
    this._promptRegister = this._ctx.register;
    this._systemBlocks = [{
      type: 'text',
      text: buildSystemPrompt({ firstName: this._ctx.customer.first_name, today, register: this._ctx.register }),
      cache_control: { type: 'ephemeral' },
    }];
  }

  async _modelTurn() {
    this._ensureSystemBlocks();
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (this.ended) return;
      let msg;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch { /* no-op */ } }, STREAM_TIMEOUT_MS);
      try {
        const stream = getClient().messages.stream(
          {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: this._systemBlocks,
            thinking: { type: 'disabled' },
            output_config: { effort: VOICE_EFFORT },
            // Tools are STATE-KEYED per round: the model never even sees a
            // tool that is invalid in the current state, and _executeTool
            // re-checks membership anyway (defense in depth — the fence is
            // in code twice, never in prompt).
            tools: this._activeTools(),
            messages: this.messages,
          },
          { signal: controller.signal },
        );
        msg = await stream.finalMessage();
      } catch (err) {
        if (timedOut) {
          this.say('Sorry, that took a moment — could you say that again?');
          return;
        }
        logger.error(`[collections-voice] anthropic error callSid=${this.callSid}: ${err.message}`);
        this.say('Sorry, I had trouble there. Could you say that again?');
        return;
      } finally {
        clearTimeout(timer);
      }

      // The socket may have closed while finalMessage was pending (gh
      // prb-r4): a late model response must neither speak nor run writes.
      if (this.ended) return;
      // A pressed-0 escape outranks the in-flight turn (gh prb-r6).
      if (this._escapeRequested) return;

      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      // Speech is deferred for writes AND for get_balance_details (gh
      // prb-r9): text emitted alongside the balance lookup was written
      // BEFORE the model saw the fresh figure — the asserted balance
      // authority is the tool result, so the model speaks only after it.
      const hasPendingWrite = msg.stop_reason === 'tool_use'
        && msg.content.some((b) => b.type === 'tool_use'
          && (WRITE_TOOLS.has(b.name) || b.name === 'get_balance_details'));
      this.messages.push({
        role: 'assistant',
        content: hasPendingWrite && text ? msg.content.filter((b) => b.type !== 'text') : msg.content,
      });
      if (text && !hasPendingWrite) this.say(text);

      if (msg.stop_reason === 'tool_use') {
        const results = [];
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          this._turns.push({ role: 'tool', text: block.name, at: Date.now() });
          const out = await this._executeToolBounded(block.name, block.input || {});
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
          if (this.ended) return; // a terminal tool closed the call
          // A 0 pressed while a tool ran preempts the REST of the block too
          // (gh prb-r11): no later write (a pay link, another record) may
          // execute ahead of the queued human escape, which ends the
          // session — the dangling tool_use never reaches the model again.
          if (this._escapeRequested) return;
        }
        this.messages.push({ role: 'user', content: results });
        continue;
      }
      return;
    }
    // The follow-up promise needs an artifact (gh prb-r13): exhausting the
    // tool rounds returns the case to the queue only at session end, and a
    // queue state is not an assigned follow-up. Card first; a failed card
    // drops the promise for the office-number copy.
    let exhaustionCard = null;
    try {
      const NotificationService = require('../../notification-service');
      exhaustionCard = await NotificationService.notifyAdmin(
        'billing',
        'Follow-up needed after automated billing call',
        'An automated billing follow-up call could not complete its last action (tool rounds exhausted). Please follow up with the customer.',
        { link: `/admin/customers/${this._ctx.customer.id}`, metadata: { source: 'collections_voice', callLogId: this._ctx.callLogId } },
      );
    } catch (cardErr) {
      logger.error(`[collections-voice] tool-exhaustion follow-up card failed: ${cardErr.message}`);
    }
    this.say((exhaustionCard && exhaustionCard.id)
      ? 'Sorry — that is taking me longer than it should. Our office will follow up. Is there anything else?'
      // ("website", not "invoice" — this line can be spoken PRE-verification
      // and must pass the pre-verify vocabulary screen.)
      : 'Sorry — that is taking me longer than it should. You can reach our office at the number on our website. Is there anything else?');
  }

  async _executeToolBounded(name, input) {
    const ms = WRITE_TOOLS.has(name) ? WRITE_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
    let timer;
    // A timed-out WRITE keeps running (gh prb-r7): track it so close-time
    // finalization can drain it before persisting the terminal outcome —
    // otherwise a late-settling write lands after the outcome and is
    // invisible to it.
    const op = this._executeTool(name, input);
    if (WRITE_TOOLS.has(name)) {
      this._pendingWrites = this._pendingWrites || new Set();
      this._pendingWrites.add(op);
      op.finally(() => this._pendingWrites.delete(op)).catch(() => {});
    }
    try {
      return await Promise.race([
        op,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            // The follow-up promise needs an artifact (gh prb-r15): the
            // timed-out write may never settle successfully, so the card is
            // filed BEFORE the model is told to promise anything; a failed
            // card drops the promise for the office-number wording.
            (async () => {
              const timeoutCard = await this._fileFollowUpCard(
                `A write action (${name}) timed out on an automated billing follow-up call and its outcome is unknown. Please verify and follow up with the customer.`,
              );
              resolve(timeoutCard
                ? 'That did not complete and the outcome is unknown. Do NOT retry it — tell the caller the office will follow up.'
                : 'That did not complete and the outcome is unknown. Do NOT retry it — give the caller the office number on our website; do not promise a follow-up.');
            })();
          }, ms);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      logger.error(`[collections-voice] tool ${name} failed callSid=${this.callSid}: ${err.message}`);
      // Same artifact bar as the timeout path (gh prb-r16): the failed
      // action may never be retried, and the queue is not a follow-up.
      const errorCard = await this._fileFollowUpCard(
        `A write action (${name}) failed on an automated billing follow-up call. Please verify and follow up with the customer.`,
      );
      return errorCard
        ? 'That did not work. Tell the caller the office will follow up — do not guess.'
        : 'That did not work. Give the caller the office number on our website — do not guess, and do not promise a follow-up.';
    } finally {
      clearTimeout(timer);
    }
  }

  // ── THE STATE FENCE ──────────────────────────────────────────────────────
  async _executeTool(name, input) {
    const allowed = STATE_TOOLS[this.state] || [];
    if (!allowed.includes(name)) {
      return `Refused: ${name} is not available at this stage of the call.`;
    }
    switch (name) {
      case 'confirm_right_party': return this._toolConfirmRightParty(input);
      case 'verify_identity': return this._toolVerifyIdentity(input);
      case 'get_balance_details': return this._toolGetBalance();
      case 'record_payment_intent': return this._toolRecordPaymentIntent(input);
      case 'record_dispute': return this._toolRecordDispute(input);
      case 'record_do_not_call': return this._toolRecordDoNotCall(input);
      case 'send_pay_link': return this._toolSendPayLink(input);
      case 'transfer_to_human': return this._toolTransfer();
      case 'end_call': return this._toolEndCall();
      default: return `Unknown tool.`;
    }
  }

  async _toolConfirmRightParty(input) {
    const result = String(input.result || '');
    if (result === 'confirmed') {
      // Confirmation is GROUNDED in the caller's words (gh prb-r19): a
      // model misread of "No, Pat isn't available" as confirmed would let
      // a household member — who often knows the street number — reach
      // disclosure. The caller's last turn must read affirmative and
      // non-negating; anything else re-asks.
      const t = this._lastCallerText();
      const CONFIRM_RE = /\b(yes|yeah|yep|speaking|this is (?:he|she|they|me|\w+)|that'?s me|it'?s me|correct|i am|i'?m \w+|you(?:'ve| have) (?:got|reached) (?:him|her|them|me))\b/i;
      const DENY_RE = /\b(no\b|not\b|isn'?t|is not|aren'?t|unavailable|not here|wrong|busy|out right now)\b/i;
      if (!CONFIRM_RE.test(t) || DENY_RE.test(t)) {
        return 'Refused: the caller has not clearly confirmed being the customer. Ask directly ("Am I speaking with them?") and call this tool only after a clear yes.';
      }
      this.state = 'VERIFY';
      return 'Right party confirmed. Now ask the customer to tell you their street number or billing ZIP so you can verify the account.';
    }
    if (result === 'wrong_party' || result === 'customer_unavailable') {
      this._captures.wrongParty = result === 'wrong_party';
      // The all-channel wrong_number flag must be GROUNDED in the caller's
      // words (gh prb-r18): a model misread of "they aren't available"
      // would otherwise suppress every channel until manual review. An
      // ungrounded number_unknown degrades to the ordinary wrong-party
      // review path (card / hold), never the flag.
      const saysUnknownHere = /\b(wrong number|never heard of|no (?:one|body) (?:named|called|by that name|here)|no \w+ (?:at|on) this (?:number|phone)|don'?t know (?:a |any )?(?:him|her|them|that (?:person|name)|who that is)|no such person|doesn'?t live here|not (?:his|her|their) (?:number|phone)|(?:just )?(?:got|took over) this (?:number|phone))\b/i
        .test(this._lastCallerText());
      if (input.number_unknown === true && saysUnknownHere) {
        const wn = await flags.flagWrongNumber(this._ctx.customer.id, {
          detail: 'answerer said the customer is not known at this number',
        }).catch(() => ({ ok: false }));
        if (!wn || wn.ok === false) {
          // The wrong-number report must survive (gh prb-r6): the durable
          // fallback is a collection_hold — absolute until a human reviews.
          // writeFlag resolves { ok:false } rather than rejecting (gh
          // prb-r9), so the result is CHECKED — a doubly-failed hold falls
          // to an admin card, and a failed card to a loud log.
          const hold = await flags.writeFlag({
            customerId: this._ctx.customer.id,
            flag: 'collection_hold',
            reason: 'wrong-number report on billing follow-up call; wrong_number flag write failed',
          }).catch(() => ({ ok: false }));
          if (!hold || hold.ok === false) {
            try {
              const NotificationService = require('../../notification-service');
              const card = await NotificationService.notifyAdmin(
                'billing',
                'Wrong-number report needs manual action',
                'An outbound billing follow-up call reached a number where the customer is not known, and BOTH the wrong_number flag and the collection_hold fallback failed to write. Please flag the number by hand before any further outreach.',
                { link: `/admin/customers/${this._ctx.customer.id}`, metadata: { source: 'collections_voice', callLogId: this._ctx.callLogId } },
              );
              if (!card || !card.id) throw new Error('notifyAdmin returned no persisted card');
            } catch (cardErr) {
              logger.error(`[collections-voice] WRONG-NUMBER REPORT UNPERSISTED for customer ${this._ctx.customer.id} callLog=${this._ctx.callLogId}: ${cardErr.message}`);
            }
          }
        }
      } else {
        const carded = await flags.fileFlagCard({
          customerId: this._ctx.customer.id,
          flag: 'wrong_party_review',
          detail: 'An outbound billing follow-up call was answered by someone other than the customer. No account details were shared. Review before any further outreach.',
        }).catch(() => false);
        if (!carded) {
          // The card is the only review artifact before the case returns
          // to the queue (gh prb-r4) — when it fails, the DURABLE fallback
          // is a collection_hold flag: absolute, blocks every channel
          // until a human reviews and releases it. The hold result is
          // CHECKED too (gh prb-r10 — writeFlag resolves { ok:false }
          // rather than rejecting): a doubly-failed artifact logs LOUDLY,
          // because the case would otherwise return to 'proposed' with no
          // review trace at all.
          const hold = await flags.writeFlag({
            customerId: this._ctx.customer.id,
            flag: 'collection_hold',
            reason: 'wrong-party answer on billing follow-up call; review card failed to file',
          }).catch(() => ({ ok: false }));
          if (!hold || hold.ok === false) {
            logger.error(`[collections-voice] WRONG-PARTY REVIEW UNPERSISTED for customer ${this._ctx.customer.id} callLog=${this._ctx.callLogId} — review card AND collection_hold both failed; case returns to queue with no artifact`);
          }
        }
      }
      this.say(script.WRONG_PARTY_CLOSE);
      await this._finish('wrong_party', { endSession: true });
      return 'Call ended — wrong party. Nothing about the account was shared.';
    }
    return 'Unrecognized result.';
  }

  async _toolVerifyIdentity(input) {
    const customer = this._ctx.customer;
    const expectStreet = String(customer.address_line1 || '').trim().match(/^(\d{1,8})\b/)?.[1] || null;
    const expectZip = String(customer.zip || '').trim().match(/^(\d{5})/)?.[1] || null;
    const gaveStreet = String(input.street_number || '').replace(/\D/g, '');
    const gaveZip = String(input.billing_zip || '').replace(/\D/g, '');
    // An EMPTY call (customer still deciding which factor to give) is not
    // an attempt (gh prb-r3): two of them must never end a legitimate call.
    if (!gaveStreet && !gaveZip) {
      return 'No factor was provided — ask for the street number or the billing ZIP. This did not count as an attempt.';
    }
    // The factor must be GROUNDED in what the caller actually said (gh
    // prb-r12), as a COMPLETE spoken token (gh prb-r13) — never a
    // substring of some other number they said. A spelled-out number
    // ("three four two…") fails grounding and simply re-asks for digits —
    // never consuming an attempt.
    const heard = this._recentCallerDigitTokens();
    const grounded = (v) => Boolean(v && heard.has(v));
    if ((gaveStreet && !grounded(gaveStreet)) || (gaveZip && !grounded(gaveZip))) {
      return 'That number did not come through clearly. Ask the customer to say just the digits again. This did not count as an attempt.';
    }
    const streetOk = Boolean(expectStreet && gaveStreet && gaveStreet === expectStreet);
    const zipOk = Boolean(expectZip && gaveZip && gaveZip === expectZip);
    if (streetOk || zipOk) {
      this.verified = true;
      this.state = 'DISCLOSE';
      return 'Verified. You may now use get_balance_details and share the open balance.';
    }
    this.verifyAttempts += 1;
    if (this.verifyAttempts >= VERIFY_MAX_ATTEMPTS) {
      this.say(script.verificationFailedClose());
      await this._finish('conversation_verification_failed', { endSession: true });
      return 'Verification failed — the call was ended without any account details.';
    }
    return 'That did not match. Ask them to try the other detail (street number or billing ZIP). Do not hint at any value.';
  }

  async _toolGetBalance() {
    if (!this.verified) return 'Refused: the customer is not verified.';
    // Re-read at DISCLOSURE time (gh prb-r7): the init-time snapshot ages
    // through the vestibule + right-party + verify states — a payment,
    // credit, or payer reassignment landing meanwhile must not be
    // contradicted. Fail closed: an unreadable balance discloses nothing.
    try {
      // A read that DROPPED an unprovable row or hit the bound understates
      // the account (gh r1): never present the survivors as "the total".
      const { incomplete, fresh, callable, notCallable } = await this._refreshBalance();
      if (incomplete) {
        logger.warn(`[collections-voice] disclosure-time balance read incomplete callSid=${this.callSid}: ${incomplete} — disclosing nothing`);
        return 'The balance could not be verified right now. Apologize, give the office number, and end politely — do NOT state any figure and do NOT say the account is settled.';
      }
      if (fresh.length && !callable) {
        // The refreshed account no longer clears the policy this call was
        // dialed on — never dunned here, no figure spoken.
        this.state = 'RESOLUTION';
        return this._notCallableCopy(notCallable);
      }
      // Register / hold / deadline from the FRESH set (hook P1) — and the
      // prompt follows the register if it moved during verification.
      this._ensureSystemBlocks();
    } catch (err) {
      logger.error(`[collections-voice] disclosure-time balance read failed callSid=${this.callSid}: ${err.message}`);
      return 'The balance could not be checked right now. Apologize, give the office number, and end politely — do NOT state any figure.';
    }
    const b = this._ctx.balance || { total: 0, count: 0 };
    if (!b.count || !(b.total > 0)) {
      // An EMPTY eligible set is NOT proof of settlement (gh prb-r11):
      // eligibility DROPS rows when payer re-resolution or the dunning-stop
      // lookup fails — fail-closed is right for outreach, but "settled" is
      // a stronger claim than "not collectible right now". Only a raw
      // zero-open-rows read earns the settled copy; a surviving raw row
      // (resolution failure, dunning-stopped) is indeterminate and
      // discloses nothing.
      try {
        const rawOpen = await db('invoices')
          .where({ customer_id: this._ctx.customer.id })
          .whereIn('status', ['sent', 'viewed', 'overdue', 'unpaid'])
          .whereNull('payer_id')
          .whereNull('payer_statement_id')
          .whereRaw('GREATEST(total - COALESCE(credit_applied, 0), 0) > 0')
          .first('id');
        if (rawOpen) {
          return 'The balance could not be verified right now. Apologize, give the office number, and end politely — do NOT state any figure and do NOT say the account is settled.';
        }
      } catch (err) {
        logger.error(`[collections-voice] settled-claim probe failed callSid=${this.callSid}: ${err.message}`);
        return 'The balance could not be checked right now. Apologize, give the office number, and end politely — do NOT state any figure.';
      }
      // The balance genuinely cleared between dial and now — say so and wrap up.
      this.state = 'RESOLUTION';
      this.disclosed = true;
      return 'The account shows NO open balance right now. Tell the customer everything looks settled, apologize for the call, and end politely.';
    }
    this.state = 'RESOLUTION';
    this.disclosed = true;
    // ITEMIZED (owner ruling 2026-08-28): every open invoice — service and
    // date — oldest first, the overdue ones marked, then ONE total. She asks
    // for the whole balance.
    const now = this._now();
    const ordered = orderByDue(b.invoices || []);
    const nameOf = (inv) => {
      const label = inv.title || inv.service_type || 'service';
      // service_date / due_date are DATE columns (literal); the created_at
      // fallback is a timestamp rendered as its ET day (hook r5/r6).
      const when = inv.service_date ? etCalendarDayOf(inv.service_date) : dueDayOf(inv);
      return `${label}${when ? ` on ${when}` : ''}`;
    };
    const lines = ordered.map((inv) => {
      const days = invoiceDaysOverdue(now, inv);
      const age = days > 0 ? `${days} day${days === 1 ? '' : 's'} past due` : 'not yet due';
      return `${nameOf(inv)}: $${Number(invoiceAmountDue(inv)).toFixed(2)} (${age})`;
    });
    const anchor = anchorInvoiceOf(ordered);
    const anchorDays = anchor ? invoiceDaysOverdue(now, anchor) : 0;
    // Consequence lines — spoken ONLY on true state (never asserted):
    const ctx = this._ctx || {};
    let consequence = '';
    if (ctx.register === 'firm' && ctx.holdActive === true) {
      consequence = ' AUTHORIZED consequence: future service is paused until the account is current — you may say exactly that.';
    } else if (ctx.register === 'final' && ctx.consequenceDueAt) {
      consequence = ` AUTHORIZED consequence: if payment is not received by ${String(ctx.consequenceDueAt).slice(0, 10)}, service will be cancelled and the account closed — you may say exactly that.`;
    } else if (ctx.register === 'firm' || ctx.register === 'final') {
      consequence = ' No consequence is authorized on this call — do not mention holds, cancellation, agencies, or legal action.';
    }
    // What the link would ACTUALLY collect (pay-combined's own selection):
    // the whole account, a named partial bundle, or the oldest invoice alone.
    const linkIds = new Set((ctx.payLinkInvoiceIds || []).map(String));
    const linked = ordered.filter((inv) => linkIds.has(String(inv.id)));
    let linkScope;
    if (ctx.payLinkCoversAccount) {
      linkScope = 'offer to text the secure payment link — it opens the full account balance for one payment.';
    } else if (linked.length > 1) {
      const linkedTotal = linked.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0);
      linkScope = `offer to text the secure payment link — it collects ${linked.map(nameOf).join(' and ')} ($${linkedTotal.toFixed(2)} of the total), not the whole balance; say the office will send the rest separately — never promise one link for the full balance.`;
    } else {
      linkScope = 'offer to text the secure payment link for the OLDEST invoice only; say the office will send the rest separately — never promise one link for the full balance.';
    }
    return `Total account balance: $${Number(b.total).toFixed(2)} across ${b.count} open invoice${b.count === 1 ? '' : 's'}; the oldest is ${anchorDays} day${anchorDays === 1 ? '' : 's'} past due. Invoices: ${lines.join('; ')}. State the total, name each invoice briefly, and ask to take care of the full balance today; ${linkScope}${consequence}`;
  }

  async _toolRecordPaymentIntent(input) {
    const { normalizeIntendedPaymentDate } = require('./outcomes');
    const date = normalizeIntendedPaymentDate(input.intended_payment_date, this._now());
    if (!date) return 'That is not a usable calendar date. Ask for a specific day (or record nothing).';
    // The date must be GROUNDED in the caller's words (gh prb-r14): the
    // caller's latest turn has to carry SOME temporal signal (a digit, a
    // day/month word, payday, next/week/…) — "I don't know when I can pay"
    // must never become an invented future date that suppresses follow-up.
    const lastCallerTurn = this._lastCallerText();
    const TEMPORAL_RE = /\d|\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|weekend|month|payday|pay ?day|next|first|fifteenth|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
    if (!TEMPORAL_RE.test(lastCallerTurn)) {
      return 'Refused: the customer has not stated a date. Only record a date they actually said — if they are unsure, record nothing and do not press.';
    }
    // Negated or uncertain statements record NOTHING (gh prb-r16):
    // "October 30 won't work; I don't know when I can pay" carries a
    // temporal token but no commitment — an invented next_eligible_at
    // would suppress follow-up on a date the caller rejected.
    if (/\b(won'?t|can'?t|cannot|will not|not able|doesn'?t work|does not work|don'?t know|not sure|unsure|no idea|maybe|might)\b/i.test(lastCallerTurn)) {
      return 'Refused: the customer sounds uncertain or said that date does not work. Only record a date they clearly committed to — if they are unsure, record nothing and do not press.';
    }
    // Cross-check the DATE against the phrase (gh prb-r15): when the caller
    // named a month, a weekday, or a day-of-month, the recorded date must
    // agree — "August 20" must never persist as the 28th. Each check fires
    // only when the caller's turn carries that component.
    const d = new Date(`${date}T12:00:00Z`);
    const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const saidMonth = MONTHS.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}(?:${m.slice(3)})?\\b`, 'i').test(lastCallerTurn));
    if (saidMonth >= 0 && d.getUTCMonth() !== saidMonth) {
      return 'Refused: that date does not match the month the customer said. Record exactly what they said, or ask them to confirm the date.';
    }
    const saidWeekday = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`, 'i').test(lastCallerTurn));
    if (saidWeekday >= 0 && d.getUTCDay() !== saidWeekday) {
      return 'Refused: that date does not fall on the weekday the customer said. Convert their day using today\'s date, or ask them to confirm.';
    }
    const spokenNumbers = (lastCallerTurn.match(/\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/g) || []).map((n) => parseInt(n, 10));
    if (saidMonth >= 0 && spokenNumbers.length && !spokenNumbers.includes(d.getUTCDate())) {
      return 'Refused: that day of the month does not match what the customer said. Record exactly what they said.';
    }
    // Numeric and relative forms ground too (gh prb-r17): "8/20", a bare
    // ordinal ("the 20th"), and today/tomorrow each pin the component they
    // carry — no named month required.
    const numericDate = lastCallerTurn.match(/\b(\d{1,2})\s*[/-]\s*(\d{1,2})\b/);
    if (numericDate) {
      const nm = parseInt(numericDate[1], 10);
      const nd = parseInt(numericDate[2], 10);
      if (d.getUTCMonth() + 1 !== nm || d.getUTCDate() !== nd) {
        return 'Refused: that date does not match the numbers the customer said. Record exactly what they said.';
      }
    }
    const ordinal = lastCallerTurn.match(/\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)\b/i);
    if (ordinal && d.getUTCDate() !== parseInt(ordinal[1], 10)) {
      return 'Refused: that day of the month does not match what the customer said. Record exactly what they said.';
    }
    if (/\b(today|tomorrow)\b/i.test(lastCallerTurn)) {
      // addETDays, never +24h in milliseconds (gh prb-r19): across the
      // spring DST transition a fixed day of ms can skip an ET calendar day.
      const { etCalendarDayOf, addETDays } = require('../../../utils/datetime-et');
      const now = this._now();
      const expected = /\btomorrow\b/i.test(lastCallerTurn)
        ? etCalendarDayOf(addETDays(now, 1))
        : etCalendarDayOf(now);
      if (date !== expected) {
        return 'Refused: that date does not match today/tomorrow. Convert using today\'s date from your instructions.';
      }
    }
    // Week-relative phrases bound the window (gh prb-r18): loose ranges,
    // because "next week" is fuzzy — but a date far outside them is
    // model-invented, not the caller's.
    {
      const { etCalendarDayOf } = require('../../../utils/datetime-et');
      const DAY = 24 * 60 * 60 * 1000;
      const todayNoon = new Date(`${etCalendarDayOf(this._now())}T12:00:00Z`).getTime();
      const daysOut = Math.round((d.getTime() - todayNoon) / DAY);
      const windows = [
        [/\bthis week(?:end)?\b/i, 0, 8],
        [/\bnext week\b/i, 2, 14],
        [/\bin (?:a couple(?: of)?|two|2) weeks\b/i, 9, 21],
      ];
      for (const [re, lo, hi] of windows) {
        if (re.test(lastCallerTurn) && (daysOut < lo || daysOut > hi)) {
          return 'Refused: that date does not fit the timeframe the customer said. Ask them for the specific day, or record nothing.';
        }
      }
      // Word-form ordinals and month-relative phrasing ground too (gh
      // prb-r19): "the fifteenth"/"the first" pin the day; "next month"
      // pins the month; a bare "payday"/"month" with no other component
      // stays temporal-only and needs a specific day.
      const WORD_ORDINALS = { first: 1, second: 2, third: 3, fifth: 5, tenth: 10, fifteenth: 15, twentieth: 20, thirtieth: 30 };
      for (const [word, dayNum] of Object.entries(WORD_ORDINALS)) {
        if (new RegExp(`\\bthe ${word}\\b`, 'i').test(lastCallerTurn) && d.getUTCDate() !== dayNum) {
          return 'Refused: that day of the month does not match what the customer said. Record exactly what they said.';
        }
      }
      if (/\bnext month\b/i.test(lastCallerTurn)) {
        const { etCalendarDayOf } = require('../../../utils/datetime-et');
        const nowMonth = parseInt(etCalendarDayOf(this._now()).slice(5, 7), 10) - 1;
        if (d.getUTCMonth() !== (nowMonth + 1) % 12) {
          return 'Refused: that date is not in next month. Ask for the specific day, or record nothing.';
        }
      }
    }
    this._captures.customerIntendedPaymentDate = date;
    return `Recorded: the customer intends to pay on ${date}. Thank them — do not press further.`;
  }

  async _toolRecordDispute(input) {
    const { scrubPans } = require('../../../utils/pan-scrub');
    let summary;
    try {
      summary = scrubPans(String(input.summary || '')).slice(0, 400);
    } catch {
      summary = '[summary withheld — scrub failed]';
    }
    const res = await flags.placeDisputeHold(this._ctx.customer.id, { summary });
    if (!res.ok) {
      // The review promise needs an artifact (gh prb-r6).
      let disputeCard = null;
      try {
        const NotificationService = require('../../notification-service');
        disputeCard = await NotificationService.notifyAdmin(
          'billing',
          'Dispute needs manual action',
          `A customer disputed a bill on a billing follow-up call, but the durable hold write failed. Summary: ${summary || 'dispute raised'}. Please place the hold by hand.`,
          { link: `/admin/customers/${this._ctx.customer.id}`, metadata: { source: 'collections_voice', callLogId: this._ctx.callLogId } },
        );
      } catch (cardErr) {
        logger.error(`[collections-voice] dispute fallback card failed: ${cardErr.message}`);
      }
      // Either way the CAPTURE records the dispute so the outcome writer
      // holds the case instead of returning it to the queue.
      this._captures.disputeSummary = summary || 'dispute raised (hold write failed)';
      return (disputeCard && disputeCard.id)
        ? 'The dispute has been passed to the office for review — assure the customer, and end politely.'
        : 'Could not record the dispute automatically. Apologize, give the office number so they can raise it directly, and end politely.';
    }
    this._captures.disputeSummary = summary || 'dispute raised';
    return 'Dispute recorded and all billing follow-up is on hold. Assure the customer the office will review before any further notices.';
  }

  async _toolRecordDoNotCall(input) {
    const { scrubPans } = require('../../../utils/pan-scrub');
    let verbatim = null;
    try { verbatim = input.verbatim_request ? scrubPans(String(input.verbatim_request)).slice(0, 300) : null; } catch { verbatim = null; }
    const res = await flags.revokeAutomatedVoiceConsent(this._ctx.customer.id, { reason: verbatim || undefined });
    let allCallsRecorded = true;
    let allCallsCard = null;
    if (input.scope === 'all_calls') {
      // gh prb-r2: the second write's failure was silently discarded.
      // gh prb-r10: the write is INDEPENDENT of the first flag's result —
      // an all-calls request whose automated-voice write failed used to
      // skip do_not_call entirely, losing the broader half of the
      // customer's instruction. The two flags stand alone.
      const second = await flags.writeFlag({ customerId: this._ctx.customer.id, flag: 'do_not_call', reason: verbatim || 'customer asked for no calls' })
        .catch(() => ({ ok: false }));
      allCallsRecorded = Boolean(second && second.ok);
      if (!allCallsRecorded) {
        try {
          const NotificationService = require('../../notification-service');
          allCallsCard = await NotificationService.notifyAdmin(
            'billing',
            'Do-not-call request needs manual action',
            res.ok
              ? 'A customer asked for NO calls of any kind during a billing follow-up call. The automated-voice stop recorded, but the all-calls flag write failed — please set it by hand.'
              : 'A customer asked for NO calls of any kind during a billing follow-up call, and BOTH the automated-voice stop and the all-calls flag failed to write. Please set automated_voice_consent_revoked AND do_not_call by hand.',
            { link: `/admin/customers/${this._ctx.customer.id}`, metadata: { source: 'collections_voice', callLogId: this._ctx.callLogId } },
          );
        } catch (cardErr) {
          logger.warn(`[collections-voice] do-not-call fallback card failed: ${cardErr.message}`);
        }
      }
    }
    // The do_not_call flag alone honors the full request (it blocks every
    // call channel, automated included) — a recorded all-calls stop is an
    // opt-out even when the automated-voice write failed (gh prb-r10).
    if (res.ok || (input.scope === 'all_calls' && allCallsRecorded)) {
      this._captures.consentRevoked = true;
    }
    if (!res.ok) {
      if (input.scope === 'all_calls' && allCallsRecorded) {
        return 'Recorded — no calls of any kind will be made. Confirm that to the caller.';
      }
      // The promise needs an artifact (gh prb-r5): file the fallback card;
      // if that fails too, the copy drops the promise. For an all-calls
      // request the all-calls card above already carries the FULL scope —
      // never a second card asking for only the automated half (gh prb-r10).
      let optOutCard = allCallsCard;
      if (input.scope !== 'all_calls') {
        try {
          const NotificationService = require('../../notification-service');
          optOutCard = await NotificationService.notifyAdmin(
            'billing',
            'Opt-out needs manual action',
            'A customer asked to stop automated billing calls during a call, but the durable flag write failed. Please set automated_voice_consent_revoked by hand.',
            { link: `/admin/customers/${this._ctx.customer.id}`, metadata: { source: 'collections_voice', callLogId: this._ctx.callLogId } },
          );
        } catch (cardErr) {
          logger.error(`[collections-voice] spoken opt-out fallback card failed: ${cardErr.message}`);
        }
      }
      return (optOutCard && optOutCard.id)
        ? 'Could not record that automatically, but the office has been asked to stop the calls — tell the caller a person will make sure it is honored, and end politely.'
        : 'Could not record that. Apologize, give the office number so they can confirm it directly, and end politely.';
    }
    if (input.scope === 'all_calls' && !allCallsRecorded) {
      // The promise stands only on a persisted card (gh prb-r6).
      return (allCallsCard && allCallsCard.id)
        ? 'Automated calls are stopped, but the full no-calls request could not be completely recorded — tell the caller a person will make sure no calls of any kind happen.'
        : 'Automated calls are stopped, but the full no-calls request could not be recorded — apologize and give the office number so they can confirm the full stop directly.';
    }
    return input.scope === 'all_calls'
      ? 'Recorded — no calls of any kind will be made. Confirm that to the caller.'
      : 'Recorded — automated calls are stopped. Confirm that to the caller.';
  }

  async _toolSendPayLink(input) {
    if (!this.verified || !this.disclosed) return 'Refused: only after verification and the balance discussion.';
    // Code-level consent evidence (gh prb-r4): the customer's own agreeing
    // words ride the tool call, persist to the captures for the pilot's
    // transcript review, and an empty/absent agreement refuses the send.
    const agreement = String(input?.customer_agreement_verbatim || '').trim();
    // The verbatim must read AFFIRMATIVE in code (gh prb-r5): "no" or
    // "not now" passed the old length check. A crude bar, but real — the
    // pilot's transcript review sees the stored verbatim either way.
    const AFFIRM_RE = /\b(yes|yeah|yep|sure|ok(?:ay)?|please|fine|send( it)?|text( it| me)?|go ahead|sounds good|that works|absolutely|definitely)\b/i;
    const NEGATE_RE = /\b(no|not|don'?t|do not|never|stop|later|maybe)\b/i;
    if (agreement.length < 2 || !AFFIRM_RE.test(agreement) || NEGATE_RE.test(agreement)) {
      return 'Refused: the customer has not clearly agreed. Ask plainly if they would like the link texted, and pass their agreeing words verbatim.';
    }
    // The consent must be GROUNDED in the caller's own latest utterance
    // (gh prb-r12): the tool input is model-authored, so a fabricated
    // "yes, text it" must not pass. The bar is the caller's actual last
    // turn reading affirmative and non-negating — and THAT turn (already
    // scrubbed in _turns) is what persists as evidence, never the model's
    // paraphrase.
    const lastCallerTurn = this._lastCallerText();
    if (!AFFIRM_RE.test(lastCallerTurn) || NEGATE_RE.test(lastCallerTurn)) {
      return 'Refused: the customer\'s own last words do not clearly agree. Ask plainly if they would like the link texted, and call this tool right after they say yes.';
    }
    // A caller who NAMES a different channel gets that instruction honored
    // (gh prb-r17): "yes, send that link by email" is not SMS consent —
    // only an explicit text/SMS term alongside overrides it.
    if (/\b(e-?mail|mail (?:it|me|that))\b/i.test(lastCallerTurn)
        && !/\b(text|txt|sms)\b/i.test(lastCallerTurn)) {
      return 'Refused: the customer asked for a different channel, not a text. This call can only text the link — offer the office number or the office email instead.';
    }
    // The affirmative must be ABOUT the text (gh prb-r14): "yes, that
    // amount is correct" is not SMS consent. Either the caller's words
    // mention the text/link themselves, or the agent line they are
    // answering was the pay-link offer.
    const SMS_CONTEXT_RE = /\b(text|txt|sms|message|link|send it|send that)\b/i;
    if (!SMS_CONTEXT_RE.test(lastCallerTurn)) {
      let lastCallerIdx = -1;
      for (let i = this._turns.length - 1; i >= 0; i--) {
        if (this._turns[i].role === 'caller') { lastCallerIdx = i; break; }
      }
      let precedingAgent = null;
      for (let i = lastCallerIdx - 1; i >= 0; i--) {
        if (this._turns[i].role === 'agent') { precedingAgent = String(this._turns[i].text || ''); break; }
      }
      const offerMade = Boolean(precedingAgent && /\b(?:text|send)\b[^.?]{0,60}\blink\b|\bpayment link\b|\btext you\b/i.test(precedingAgent));
      if (!offerMade) {
        return 'Refused: the customer\'s agreement was not about receiving a text. Offer the payment link plainly ("would you like me to text you a secure payment link?") and call this tool right after they agree.';
      }
    }
    // Consent evidence persists on EVERY path past the fence (gh prb-r6):
    // stashed before the branches so the send path records it too.
    try {
      const { scrubPans } = require('../../../utils/pan-scrub');
      this._captures.payLinkAgreementVerbatim = scrubPans(lastCallerTurn).slice(0, 200);
    } catch { this._captures.payLinkAgreementVerbatim = null; }
    if (!isPayLinkEnabled()) {
      return 'The pay-link text is not available. Offer the office number for payment instead.';
    }
    if (this.payLinkSent) return 'Already sent this call — do not send again.';
    // Scope re-proven at SEND time (gh r2): a sibling paid, stopped, or
    // claimed by a live PaymentIntent since disclosure must be neither
    // promised nor recorded as contacted. Fail closed on an unreadable set.
    try {
      const { incomplete, fresh, callable, notCallable } = await this._refreshBalance();
      if (incomplete) {
        logger.warn(`[collections-voice] send-time balance read incomplete callSid=${this.callSid}: ${incomplete} — not sending`);
        return 'The balance could not be re-checked right now — do not send the link. Offer the office number for payment instead.';
      }
      if (fresh.length && !callable) return this._notCallableCopy(notCallable, { atSend: true });
    } catch (err) {
      logger.error(`[collections-voice] send-time balance read failed callSid=${this.callSid}: ${err.message}`);
      return 'The balance could not be re-checked right now — do not send the link. Offer the office number for payment instead.';
    }
    const invoiceId = this._ctx.invoiceId;
    if (!invoiceId) return 'No sendable invoice. Offer the office number instead.';

    // PR A rail-guard for the SMS channel FIRST (do_not_text, frequency, …).
    const { collectionsChannelPermitted } = require('../rail-guard');
    const permitted = await collectionsChannelPermitted({
      customerId: this._ctx.customer.id,
      invoiceId,
      channel: 'sms',
      purpose: 'late_payment',
      now: this._now(),
      // The ACTIVE call's own ledger row must not veto this in-call write
      // (gh prb-r2: the any-channel 24h window always found it).
      excludeCollectionCaseId: this._ctx.caseId,
      logTag: 'collections-voice-paylink',
    });
    if (!permitted) return 'A text cannot be sent to this customer. Offer the office number for payment instead.';

    // The delivery target must BE the verified number (gh prb-r16):
    // sendViaSMS reloads customers.phone at send time, so a phone edited
    // or merged mid-call would receive the link on a number that neither
    // verified nor consented. Fail closed on an unreadable phone.
    try {
      const { normalizeE164 } = require('../consent-provenance');
      const liveCustomer = await db('customers')
        .where({ id: this._ctx.customer.id }).whereNull('deleted_at').first('phone');
      const livePhone = normalizeE164(liveCustomer?.phone);
      const dialedPhone = normalizeE164(this._ctx.dialedPhone);
      if (!livePhone || !dialedPhone || livePhone !== dialedPhone) {
        logger.warn(`[collections-voice] pay-link refused: customer phone changed mid-call callLog=${this._ctx.callLogId}`);
        return 'The number on file changed during this call, so a text cannot be sent. Offer the office number for payment instead.';
      }
    } catch (err) {
      logger.error(`[collections-voice] pay-link phone re-check failed: ${err.message}`);
      return 'The text could not be sent. Offer the office number for payment instead.';
    }

    // RECORD-THEN-SEND through the contact ledger (throws ⇒ no send).
    const ContactLedger = require('../contact-ledger');
    let entry;
    try {
      entry = await ContactLedger.recordContact({
        customerId: this._ctx.customer.id,
        channel: 'sms',
        purpose: 'late_payment',
        // Every invoice the link would actually collect (pay-combined's own
        // selection at disclosure time), never more.
        invoiceIds: (this._ctx.payLinkInvoiceIds && this._ctx.payLinkInvoiceIds.length) ? this._ctx.payLinkInvoiceIds : [invoiceId],
        source: 'collections_voice_paylink',
        metadata: {
          callLogId: this._ctx.callLogId,
          collectionCaseId: this._ctx.caseId,
          // Durable BEFORE the provider is touched (gh prb-r18): if the
          // process dies after Twilio accepts, the delivered text must not
          // survive without its consent evidence (the in-memory captures
          // and the expiring transcript are not that).
          pay_link_agreement_verbatim: this._captures.payLinkAgreementVerbatim || null,
        },
        occurredAt: this._now(),
      });
    } catch (err) {
      logger.error(`[collections-voice] pay-link ledger insert failed — NOT sending: ${err.message}`);
      return 'The text could not be sent. Offer the office number for payment instead.';
    }
    try {
      const InvoiceService = require('../../invoice');
      // The latch closes BEFORE the provider await (gh prb-r18): a send
      // that outlives the 8s tool timeout keeps running, and a second tool
      // call in that window must not double-send. Only a PROVIDER-REPORTED
      // failure re-opens it; ambiguous outcomes (throw, timeout) keep it.
      this.payLinkSent = true;
      const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
      if (result && result.covered_by_credit) {
        // Account credit settled the ANCHOR invoice — nothing was texted.
        // The balance is the account's (hook r3 P1): re-read the eligible
        // set; anything still open re-opens the latch and re-anchors so a
        // second send_pay_link collects the remainder. Never "settled" on
        // an unproven remainder.
        // No SMS went out: the reservation above must not stand as a
        // contact (gh r1) — it would trip the any-channel 24h window on the
        // retry and suppress other outreach. never_contacted rows are
        // excluded from the policy's recent-contact read. The stamp is
        // best-effort, so it is CHECKED with one retry (gh r5, same pattern
        // as origination): if it cannot be made durable the latch stays
        // CLOSED — a retry would only be refused by the phantom contact.
        const stamp = { stage: 'send_via_sms', code: 'covered_by_credit', never_contacted: true };
        let released = await ContactLedger.markSendFailed(entry, stamp);
        if (!released) released = await ContactLedger.markSendFailed(entry, stamp);
        if (!released) {
          logger.error(`[collections-voice] never_contacted stamp FAILED TWICE for ledger ${entry.id} callSid=${this.callSid} — pay link stays closed this call`);
          return 'No text was sent: account credit covered that invoice in full, but the link cannot be re-offered on this call. Say the office will follow up on any remaining balance — do NOT state a figure and do NOT say the account is settled.';
        }
        let refreshed;
        try {
          refreshed = await this._refreshBalance();
        } catch (err) {
          logger.error(`[collections-voice] balance re-read after credit cover failed callSid=${this.callSid}: ${err.message}`);
          return 'No text was sent: account credit covered that invoice in full, but the remaining balance could not be checked. Say the office will follow up — do NOT say the account is settled.';
        }
        if (refreshed.incomplete) {
          logger.warn(`[collections-voice] balance re-read after credit cover incomplete callSid=${this.callSid}: ${refreshed.incomplete}`);
          return 'No text was sent: account credit covered that invoice in full, but the remaining balance could not be verified. Say the office will follow up — do NOT say the account is settled.';
        }
        const remaining = refreshed.fresh;
        if (!remaining.length) {
          return 'No text was needed: account credit covered the balance in full. Tell the customer the account is settled.';
        }
        if (!refreshed.callable) {
          return `No text was needed: account credit covered that invoice in full. ${this._notCallableCopy(refreshed.notCallable)}`;
        }
        this.payLinkSent = false;
        return `No text was sent: account credit covered that invoice in full, but $${this._ctx.balance.total.toFixed(2)} across ${remaining.length} invoice${remaining.length === 1 ? '' : 's'} is still open. Tell the customer, and if they still want the link, call send_pay_link again for the remaining balance.`;
      }
      if (result && (result.sent || result.ok)) {
        this._captures.payLinkSent = true;
        const linkedCount = (this._ctx.payLinkInvoiceIds || []).length;
        if (this._ctx.payLinkCoversAccount) {
          return 'The payment link was texted to the customer. Let them know it is from Waves Pest Control and opens our secure payment page with the full account balance.';
        }
        if (linkedCount > 1) {
          return `The payment link was texted to the customer. Let them know it is from Waves Pest Control and opens our secure payment page for ${linkedCount} of the open invoices; the office will send the rest.`;
        }
        return 'The payment link for the oldest invoice was texted to the customer. Let them know it is from Waves Pest Control and goes to our secure payment page; the office will send the rest.';
      }
      this.payLinkSent = false; // provider REPORTED non-delivery — retry is safe
      await ContactLedger.markSendFailed(entry, { stage: 'send_via_sms', code: result?.code || null });
      return 'The text did not go through. Offer the office number for payment instead.';
    } catch (err) {
      // A THROW is ambiguous (gh prb-r16): sendViaSMS can fail in its
      // post-send bookkeeping AFTER Twilio accepted the SMS. Never assert
      // failure, never permit an in-call retry (a duplicate link is worse
      // than a missing one), and stamp the ledger delivery-unknown — not
      // send_failed, which would falsely release the frequency window's
      // claim on a text that may have arrived.
      logger.error(`[collections-voice] pay-link send threw (delivery UNKNOWN): ${err.message}`);
      this.payLinkSent = true;
      await db('collections_contact_ledger').where({ id: entry.id }).update({
        metadata: db.raw(
          "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ delivery_unknown: true, stage: 'send_via_sms_exception' })],
        ),
      }).catch((stampErr) => logger.error(`[collections-voice] delivery-unknown stamp failed for ledger ${entry.id}: ${stampErr.message}`));
      return 'The text may or may not have gone through — do NOT try again. Ask the caller to check their messages, and offer the office number if nothing arrives.';
    }
  }

  async _toolTransfer() {
    await this._humanEscape();
    return 'Handled — the caller is being connected or a callback was filed.';
  }

  async _toolEndCall() {
    this.say('Thanks for your time today. Goodbye.');
    await this._finish(this._defaultOutcome(), { endSession: true });
    return 'Call ended.';
  }

  // Human escape: any state, always possible. Staffed hours ⇒ warm transfer
  // (the relay action route reads the handoff and <Dial>s the office);
  // otherwise a callback card for the office.
  async _humanEscape() {
    if (this.ended) return;
    const staffed = isStaffedHours(this._now(), { supervised: this._supervised === true });
    if (staffed) {
      this.say(script.TRANSFER_ANNOUNCEMENT);
      await this._finish('conversation_transferred', {
        endSession: true,
        handoff: { next: 'transfer' },
      });
      return;
    }
    this._escapeRequested = false;
    let callbackCard = null;
    try {
      const NotificationService = require('../../notification-service');
      callbackCard = await NotificationService.notifyAdmin(
        'billing',
        'Callback requested on billing follow-up call',
        `A customer on an automated billing follow-up call asked for a person outside office hours. Please call them back.${this._captures.humanEscapeUtterance ? ` They said: "${this._captures.humanEscapeUtterance}"` : ''}`,
        {
          link: this._ctx ? `/admin/customers/${this._ctx.customer.id}` : undefined,
          metadata: { source: 'collections_voice', callLogId: this._ctx?.callLogId },
        },
      );
    } catch (err) {
      logger.error(`[collections-voice] callback card failed: ${err.message}`);
    }
    // A callback is only PROMISED when its card actually persisted (gh
    // prb-r3: notifyAdmin resolves null on a failed insert) — otherwise
    // the honest copy gives the number without the promise.
    this.say((callbackCard && callbackCard.id) ? script.callbackPromise() : script.callbackNumberOnly());
    await this._finish('conversation_transferred', { endSession: true, handoff: { next: 'callback' } });
  }

  _defaultOutcome() {
    if (this._captures.disputeSummary) return 'conversation_dispute';
    if (this._captures.consentRevoked) return 'conversation_consent_revoked';
    if (this.disclosed) return 'conversation_completed';
    return 'conversation_abandoned';
  }

  async _finish(outcome, { endSession = false, handoff = null } = {}) {
    if (this._finished) {
      // A prior finish whose outcome write resolved { ok:false } left
      // _persisted false (gh prb-r5): this re-entry is the retry.
      if (!this._persisted) {
        await this._persist(this._outcome || outcome).catch((err) => {
          logger.error(`[collections-voice] persist retry failed callSid=${this.callSid}: ${err.message}`);
        });
      }
      return;
    }
    this._finished = true;
    this._outcome = outcome;
    this.ended = true;
    if (endSession) {
      try { this._endSession(handoff || { next: 'complete' }); } catch { /* socket closing */ }
    }
    await this._persist(outcome).catch((err) => {
      logger.error(`[collections-voice] persist failed callSid=${this.callSid}: ${err.message}`);
    });
  }

  async _persist(outcome) {
    if (this._persisted) return;
    // The in-flight attempt is TRACKED (gh prb-r11): _persisted latches
    // optimistically at entry, so a socket close racing this write used to
    // read the latch as durable success, skip its retry, and the
    // { ok:false } un-latch arrived only after the last event had already
    // been discarded — the case stayed in 'dialing'. end() awaits this
    // promise before trusting the latch.
    const attempt = this._doPersist(outcome);
    this._persistInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this._persistInFlight === attempt) this._persistInFlight = null;
    }
  }

  async _doPersist(outcome) {
    this._persisted = true;
    // Transcript: the SAME writer the inbound relay uses (scrubbing +
    // provider stamp 'conversation_relay', which every corpus miner already
    // excludes — no self-training on the assistant's own speech).
    try {
      const { buildTranscriptUpdate } = require('../../voice-agent/relay-transcript');
      const update = buildTranscriptUpdate({
        turns: this._turns.map((t) => ({ role: t.role, text: t.text })),
        reason: outcome,
        callSid: this.callSid,
        model: MODEL,
        startedAt: this._startedAt,
      });
      if (update) {
        await db('call_log').where({ id: this._ctx?.callLogId }).update({ ...update, updated_at: new Date() });
      }
    } catch (err) {
      logger.error(`[collections-voice] transcript write failed callSid=${this.callSid}: ${err.message}`);
    }
    if (this._ctx?.callLogId) {
      const res = await writeCallOutcome(this._ctx.callLogId, {
        outcome,
        captures: this._captures,
        now: this._now(),
      });
      // A resolved-but-failed outcome write (gh prb-r4: writeCallOutcome
      // catches and resolves { ok: false }) must not latch persistence —
      // the next persistence trigger retries the ledger/case outcome.
      if (res && res.ok === false) this._persisted = false;
    }
  }

  /** Socket closed (hangup or teardown). Idempotent with _finish. */
  async end(reason) {
    // A terminal tool's persistence may still be IN FLIGHT (gh prb-r11):
    // await it so the latch below reflects the SETTLED result, not the
    // optimistic entry latch — otherwise the only close event is discarded
    // and a subsequent { ok:false } un-latch has no retry left.
    if (this._persistInFlight) {
      try { await this._persistInFlight; } catch { /* logged in _persist */ }
    }
    if (this._finished && this._persisted) return;
    // Drain any timed-out writes still in flight (gh prb-r7), bounded —
    // their settlements belong IN the terminal outcome, not after it.
    if (this._pendingWrites && this._pendingWrites.size) {
      await Promise.race([
        Promise.allSettled([...this._pendingWrites]),
        new Promise((r) => { const t = setTimeout(r, 5000); t.unref?.(); }),
      ]);
    }
    // A close racing _init() must WAIT for it (gh prb-r5): finalizing
    // before _ctx carries the call-log linkage would strand the case in
    // 'dialing' with no outcome, and the latch would block every retry.
    try { await this._contextReady; } catch { /* init failure logged there */ }
    if (!this._ctx) {
      this._finished = true;
      this.ended = true;
      return;
    }
    await this._finish(this._defaultOutcome(), { endSession: false });
    // The socket close is the LAST event this session will ever see (gh
    // prb-r6): a resolved-failed outcome write gets one bounded retry here,
    // then a loud log — nothing else will re-trigger persistence.
    if (!this._persisted) {
      await this._persist(this._outcome || this._defaultOutcome()).catch(() => {});
      if (!this._persisted) {
        logger.error(`[collections-voice] OUTCOME PERSISTENCE FAILED at close callSid=${this.callSid} callLog=${this._ctx?.callLogId} — case may be stuck in 'dialing'`);
      }
    }
    // A write that outlived the bounded drain keeps running uncancelled (gh
    // prb-r9): its eventual settlement can mutate external state and the
    // captures AFTER the outcome above persisted. Attach reconciliation:
    // when it settles, un-latch and re-persist so the durable outcome
    // absorbs the late capture (the jsonb merge is idempotent), with a loud
    // log either way — a still-failing write is the pilot operator's item.
    if (this._pendingWrites && this._pendingWrites.size) {
      for (const op of [...this._pendingWrites]) {
        op.then(() => {
          logger.warn(`[collections-voice] write settled AFTER close drain callSid=${this.callSid} callLog=${this._ctx?.callLogId} — reconciling outcome`);
          this._persisted = false;
          return this._persist(this._outcome || this._defaultOutcome());
        }).catch((err) => {
          logger.error(`[collections-voice] post-close write failed or reconciliation failed callSid=${this.callSid} callLog=${this._ctx?.callLogId}: ${err?.message || err}`);
        });
      }
    }
    logger.info(`[collections-voice] session ended callSid=${this.callSid} reason=${reason || 'ws_close'} outcome=${this._outcome}`);
  }
}

module.exports = {
  buildSystemPrompt,
  readDunningState,
  REGISTER_RULES,
  CollectionsConversation,
  STATE_TOOLS,
  TOOLS,
  WRITE_TOOLS,
  MAX_CALL_TURNS,
  VERIFY_MAX_ATTEMPTS,
  utteranceHasSensitiveDetails,
  HUMAN_REQUEST_RE,
};
