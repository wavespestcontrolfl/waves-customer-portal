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
const { writeCallOutcome } = require('./outcomes');
const flags = require('./flags');

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
    '\\baccount number\\b[^.]{0,20}\\d{4,}',
    '\\bcvv\\b|\\bsecurity code\\b|\\bcard number\\b',
    '\\b(?:one[- ]time|verification) (?:code|password|pin)\\b',
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

function buildSystemPrompt({ firstName }) {
  const who = firstName || 'the customer';
  return [
    'You are Sandy, the automated billing assistant for Waves Pest Control, on a RECORDED outbound phone call about an open balance. Keep every reply to one or two short spoken sentences. Never use emojis or read out symbols.',
    '',
    'NON-NEGOTIABLE RULES:',
    `- FIRST confirm you are speaking with ${who} (call confirm_right_party). Until confirmed AND verified, never mention any balance, invoice, service, or account detail of any kind.`,
    '- If it is the wrong person, apologize for the interruption and end the call without saying why you called.',
    '- After confirmation, verify identity: ask the customer to tell you their street number OR their billing ZIP code, then call verify_identity with what they said. NEVER read out, suggest, or confirm any address, ZIP, or account detail yourself — they must supply it.',
    '- Only after verification, use get_balance_details and share the open balance plainly and courteously.',
    '- Say "open balance" or "billing follow-up". NEVER say "collections", "debt", or "delinquent". Never threaten, pressure, negotiate, settle, or discount. You have no authority over amounts.',
    '- NEVER take a payment or any card, bank, or account numbers on this call. If they want to pay, offer to text a secure payment link (send_pay_link) after they agree to receive the text.',
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
    const caseRow = await db('collection_cases').where({ id: meta.collectionCaseId }).first();
    const customer = caseRow
      ? await db('customers').where({ id: caseRow.customer_id }).whereNull('deleted_at')
        .first('id', 'first_name', 'last_name', 'phone', 'address_line1', 'zip')
      : null;
    if (!caseRow || !customer) return this._refuse('case_or_customer_missing');

    // Balance from the SAME eligible-invoice authority the policy used at
    // dial time (codex prb-r1: openBalanceSummary omits legacy 'unpaid'
    // rows the policy admits — a customer approved solely for one was told
    // their account was settled). Read-only; the policy decided
    // collectibility at dial, this only supplies data.
    const { loadEligibleInvoices } = require('../contact-policy');
    const { invoiceAmountDue } = require('../../invoice-helpers');
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
      // The pay-link target is the LIVE eligible set's oldest invoice (gh
      // prb-r5): the balance disclosed in-call is computed from it, and a
      // link to a snapshot invoice paid since dialing would contradict the
      // spoken figure. Snapshot ids remain on the case row for audit.
      invoiceId: eligibleInvoices[0]?.id || null,
    };
    return true;
  }

  _refuse(reason) {
    logger.warn(`[collections-voice] refusing collections session callSid=${this.callSid}: ${reason}`);
    this._refused = reason;
    return false;
  }

  say(text) {
    if (this.ended || !text) return;
    // Pre-verification, ANY balance/invoice vocabulary is withheld (gh
    // prb-r4): the tool fence keeps figures unreadable, but raw model text
    // must not confirm to an unverified answerer that a balance exists.
    let screened = text;
    // (The fixed SECURITY_INTERRUPT is exempt — it names "payment link"
    // without confirming any balance exists.)
    if (!this.verified && screened !== script.SECURITY_INTERRUPT
        && script.PRE_VERIFY_FORBIDDEN_RE.test(screened)) {
      screened = script.PRE_VERIFY_DEFLECTION;
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
      this._chain = this._chain
        // Session proof first (gh prb-r3): a 0 pressed immediately after
        // relay setup must not run the escape before _ctx carries the
        // call-log linkage — the outcome would persist nowhere.
        .then(() => this._contextReady)
        .then(() => this._humanEscape())
        .catch((err) => logger.error(`[collections-voice] dtmf escape failed: ${err.message}`));
    }
  }

  interrupt() { /* barge-in: nothing buffered server-side to cancel */ }

  async _handlePrompt(rawText) {
    if (this.ended) return;
    const ok = await this._contextReady;
    if (!ok || !this._ctx) {
      // Fail closed: no context = a fixed close with zero account content.
      this.say(script.RELAY_FAILURE_CLOSE);
      return this._finish('relay_failed', { endSession: true });
    }
    if (++this._turnCount > MAX_CALL_TURNS) {
      this.say('Thanks for your time today. Goodbye.');
      return this._finish(this._defaultOutcome(), { endSession: true });
    }

    // Human escape by phrase — any state, checked in CODE before the model.
    if (HUMAN_REQUEST_RE.test(rawText)) return this._humanEscape();

    // Security interrupt: fixed copy, and the model sees only scrubbed text.
    let callerText = String(rawText || '');
    if (utteranceHasSensitiveDetails(callerText)) {
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
      this.messages.push({ role: 'user', content: `${callerText}\n[system note: the caller tried to share payment details; you already told them you cannot take payment information on this call.]` });
      return;
    }

    this._turns.push({ role: 'caller', text: callerText, at: Date.now() });
    this.messages.push({ role: 'user', content: callerText });
    await this._modelTurn();
  }

  _activeTools() {
    const names = new Set(STATE_TOOLS[this.state] || []);
    return TOOLS.filter((t) => names.has(t.name));
  }

  async _modelTurn() {
    if (!this._systemBlocks) {
      this._systemBlocks = [{
        type: 'text',
        text: buildSystemPrompt({ firstName: this._ctx.customer.first_name }),
        cache_control: { type: 'ephemeral' },
      }];
    }
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

      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      const hasPendingWrite = msg.stop_reason === 'tool_use'
        && msg.content.some((b) => b.type === 'tool_use' && WRITE_TOOLS.has(b.name));
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
        }
        this.messages.push({ role: 'user', content: results });
        continue;
      }
      return;
    }
    this.say('Sorry — that is taking me longer than it should. Our office will follow up. Is there anything else?');
  }

  async _executeToolBounded(name, input) {
    const ms = WRITE_TOOLS.has(name) ? WRITE_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
    let timer;
    try {
      return await Promise.race([
        this._executeTool(name, input),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(
            'That did not complete and the outcome is unknown. Do NOT retry it — tell the caller the office will follow up.',
          ), ms);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      logger.error(`[collections-voice] tool ${name} failed callSid=${this.callSid}: ${err.message}`);
      return 'That did not work. Tell the caller the office will follow up — do not guess.';
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
      this.state = 'VERIFY';
      return 'Right party confirmed. Now ask the customer to tell you their street number or billing ZIP so you can verify the account.';
    }
    if (result === 'wrong_party' || result === 'customer_unavailable') {
      this._captures.wrongParty = result === 'wrong_party';
      if (input.number_unknown === true) {
        await flags.flagWrongNumber(this._ctx.customer.id, {
          detail: 'answerer said the customer is not known at this number',
        });
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
          // until a human reviews and releases it.
          await flags.writeFlag({
            customerId: this._ctx.customer.id,
            flag: 'collection_hold',
            reason: 'wrong-party answer on billing follow-up call; review card failed to file',
          }).catch((err) => logger.error(`[collections-voice] wrong-party fallback hold failed: ${err.message}`));
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
    const b = this._ctx.balance || { total: 0, count: 0 };
    if (!b.count || !(b.total > 0)) {
      // The balance cleared between dial and now — say so and wrap up.
      this.state = 'RESOLUTION';
      this.disclosed = true;
      return 'The account shows NO open balance right now. Tell the customer everything looks settled, apologize for the call, and end politely.';
    }
    this.state = 'RESOLUTION';
    this.disclosed = true;
    const inv = (b.invoices && b.invoices[0]) || null;
    const invLine = inv
      ? ` The oldest open invoice is ${inv.invoice_number || 'on file'}${inv.due_date ? `, due ${String(inv.due_date).slice(0, 10)}` : ''}.`
      : '';
    return `Open balance: $${Number(b.total).toFixed(2)} across ${b.count} invoice(s).${invLine} Share the amount plainly. You may offer to text a secure payment link.`;
  }

  async _toolRecordPaymentIntent(input) {
    const { normalizeIntendedPaymentDate } = require('./outcomes');
    const date = normalizeIntendedPaymentDate(input.intended_payment_date, this._now());
    if (!date) return 'That is not a usable calendar date. Ask for a specific day (or record nothing).';
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
    if (!res.ok) return 'Could not record the dispute. Tell the customer the office will review the bill, and end politely.';
    this._captures.disputeSummary = summary || 'dispute raised';
    return 'Dispute recorded and all billing follow-up is on hold. Assure the customer the office will review before any further notices.';
  }

  async _toolRecordDoNotCall(input) {
    const { scrubPans } = require('../../../utils/pan-scrub');
    let verbatim = null;
    try { verbatim = input.verbatim_request ? scrubPans(String(input.verbatim_request)).slice(0, 300) : null; } catch { verbatim = null; }
    const res = await flags.revokeAutomatedVoiceConsent(this._ctx.customer.id, { reason: verbatim || undefined });
    let allCallsRecorded = true;
    if (input.scope === 'all_calls' && res.ok) {
      // gh prb-r2: the second write's failure was silently discarded —
      // reporting success while manual calls stay permitted loses half the
      // customer's instruction.
      const second = await flags.writeFlag({ customerId: this._ctx.customer.id, flag: 'do_not_call', reason: verbatim || 'customer asked for no calls' });
      allCallsRecorded = Boolean(second && second.ok);
      if (!allCallsRecorded) {
        try {
          const NotificationService = require('../../notification-service');
          await NotificationService.notifyAdmin(
            'billing',
            'Do-not-call request needs manual action',
            'A customer asked for NO calls of any kind during a billing follow-up call. The automated-voice stop recorded, but the all-calls flag write failed — please set it by hand.',
            { link: `/admin/customers/${this._ctx.customer.id}`, metadata: { source: 'collections_voice', callLogId: this._ctx.callLogId } },
          );
        } catch (cardErr) {
          logger.warn(`[collections-voice] do-not-call fallback card failed: ${cardErr.message}`);
        }
      }
    }
    if (!res.ok) {
      // The promise needs an artifact (gh prb-r5): file the fallback card;
      // if that fails too, the copy drops the promise.
      let optOutCard = null;
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
      return optOutCard
        ? 'Could not record that automatically, but the office has been asked to stop the calls — tell the caller a person will make sure it is honored, and end politely.'
        : 'Could not record that. Apologize, give the office number so they can confirm it directly, and end politely.';
    }
    this._captures.consentRevoked = true;
    if (input.scope === 'all_calls' && !allCallsRecorded) {
      return 'Automated calls are stopped, but the full no-calls request could not be completely recorded — tell the caller a person will make sure no calls of any kind happen.';
    }
    return 'Recorded — automated calls are stopped. Confirm that to the caller.';
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
    if (!isPayLinkEnabled()) {
      return 'The pay-link text is not available. Offer the office number for payment instead.';
    }
    if (this.payLinkSent) return 'Already sent this call — do not send again.';
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

    // RECORD-THEN-SEND through the contact ledger (throws ⇒ no send).
    const ContactLedger = require('../contact-ledger');
    let entry;
    try {
      entry = await ContactLedger.recordContact({
        customerId: this._ctx.customer.id,
        channel: 'sms',
        purpose: 'late_payment',
        invoiceIds: [invoiceId],
        source: 'collections_voice_paylink',
        metadata: { callLogId: this._ctx.callLogId, collectionCaseId: this._ctx.caseId },
        occurredAt: this._now(),
      });
    } catch (err) {
      logger.error(`[collections-voice] pay-link ledger insert failed — NOT sending: ${err.message}`);
      return 'The text could not be sent. Offer the office number for payment instead.';
    }
    try {
      const InvoiceService = require('../../invoice');
      const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
      if (result && result.covered_by_credit) {
        // Account credit fully covered the invoice — nothing was texted and
        // nothing is owed on it. The truth, not a false "link sent".
        this._captures.payLinkAgreementVerbatim = (() => { try { const { scrubPans } = require('../../../utils/pan-scrub'); return scrubPans(agreement).slice(0, 200); } catch { return null; } })();
    this.payLinkSent = true;
        return 'No text was needed: account credit covered that invoice in full. Tell the customer it is settled.';
      }
      if (result && (result.sent || result.ok)) {
        this.payLinkSent = true;
        this._captures.payLinkSent = true;
        return 'The payment link was texted to the customer. Let them know it is from Waves Pest Control and goes to our secure payment page.';
      }
      await ContactLedger.markSendFailed(entry, { stage: 'send_via_sms', code: result?.code || null });
      return 'The text did not go through. Offer the office number for payment instead.';
    } catch (err) {
      logger.error(`[collections-voice] pay-link send failed: ${err.message}`);
      await ContactLedger.markSendFailed(entry, { stage: 'send_via_sms_error' });
      return 'The text did not go through. Offer the office number for payment instead.';
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
    const staffed = isStaffedHours(this._now());
    if (staffed) {
      this.say(script.TRANSFER_ANNOUNCEMENT);
      await this._finish('conversation_transferred', {
        endSession: true,
        handoff: { next: 'transfer' },
      });
      return;
    }
    let callbackCard = null;
    try {
      const NotificationService = require('../../notification-service');
      callbackCard = await NotificationService.notifyAdmin(
        'billing',
        'Callback requested on billing follow-up call',
        `A customer on an automated billing follow-up call asked for a person outside office hours. Please call them back.`,
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
    this.say(callbackCard ? script.callbackPromise() : script.callbackNumberOnly());
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
    if (this._finished && this._persisted) return;
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
    logger.info(`[collections-voice] session ended callSid=${this.callSid} reason=${reason || 'ws_close'} outcome=${this._outcome}`);
  }
}

module.exports = {
  CollectionsConversation,
  STATE_TOOLS,
  TOOLS,
  WRITE_TOOLS,
  MAX_CALL_TURNS,
  VERIFY_MAX_ATTEMPTS,
  utteranceHasSensitiveDetails,
  HUMAN_REQUEST_RE,
  buildSystemPrompt,
};
