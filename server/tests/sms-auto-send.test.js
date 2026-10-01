/**
 * SMS Auto-Send Executor (brand-voice loop Phase E) — pure-logic coverage.
 *
 * Same convention as sms-suggest-mode.test.js / sms-graduation.test.js: no DB,
 * no LLM, no provider. The send path is DB/Twilio-bound and covered by the
 * guard-gauntlet it shares with the (already-tested) suggest publish; what
 * lives HERE are the safety invariants that gate an autonomous customer send —
 * the precondition ordering, the escalation lock, and the message_type /
 * status separations the recovery + guard logic depend on.
 */
const autoSend = require('../services/sms-auto-send');
const {
  VALID_MODES,
  AUTO_SEND_MODE,
  HUMAN_REPLY_TYPES,
  validateModeChange,
} = require('../services/sms-suggest-mode');
const graduation = require('../services/sms-graduation');

const {
  autoSendPreflight, autoSendActionsSafe, isRealProviderSend, isAmbiguousProviderOutcome,
  AUTOSEND_MODE, AUTOSEND_MESSAGE_TYPE, CLAIM_STATUS, SENT_STATUS, FAILED_STATUS, SUPPRESSION_SENTINELS,
} = autoSend;

const CLEAR = { gateOn: true, baseEligible: true, mode: AUTOSEND_MODE, actionsSafe: true, eligible: true };

describe('autoSendPreflight — precondition ordering (the gate to an autonomous send)', () => {
  test('all preconditions clear → no stop reason', () => {
    expect(autoSendPreflight(CLEAR)).toBeNull();
  });

  test('gate off stops first, before anything else is even consulted', () => {
    expect(autoSendPreflight({ ...CLEAR, gateOn: false })).toBe('gate_off');
    // gate wins even when every other signal is also bad
    expect(autoSendPreflight({ gateOn: false, baseEligible: false, mode: 'shadow', actionsSafe: false, eligible: false })).toBe('gate_off');
  });

  test('base ineligibility stops before mode + eligibility', () => {
    expect(autoSendPreflight({ ...CLEAR, baseEligible: false })).toBe('ineligible_base');
    expect(autoSendPreflight({ gateOn: true, baseEligible: false, mode: 'shadow', actionsSafe: false, eligible: false })).toBe('ineligible_base');
  });

  test('mode must be auto_send', () => {
    expect(autoSendPreflight({ ...CLEAR, mode: 'shadow' })).toBe('mode_not_autosend');
    expect(autoSendPreflight({ ...CLEAR, mode: 'suggest' })).toBe('mode_not_autosend');
  });

  test('a draft needing a human action stops before the eligibility query', () => {
    expect(autoSendPreflight({ ...CLEAR, actionsSafe: false })).toBe('action_required');
    // action gate beats eligibility (cheaper + safety-critical)
    expect(autoSendPreflight({ ...CLEAR, actionsSafe: false, eligible: false })).toBe('action_required');
  });

  test('graduation eligibility is the last gate', () => {
    expect(autoSendPreflight({ ...CLEAR, eligible: false })).toBe('not_eligible');
  });

  test('the contract is fail-closed: a missing field never reads as "proceed"', () => {
    expect(autoSendPreflight({})).toBe('gate_off');
    expect(autoSendPreflight({ gateOn: true })).toBe('ineligible_base');
    expect(autoSendPreflight({ gateOn: true, baseEligible: true })).toBe('mode_not_autosend');
    expect(autoSendPreflight({ gateOn: true, baseEligible: true, mode: AUTOSEND_MODE })).toBe('action_required');
    expect(autoSendPreflight({ gateOn: true, baseEligible: true, mode: AUTOSEND_MODE, actionsSafe: true })).toBe('not_eligible');
  });
});

describe('autoSendActionsSafe — only a well-formed no-op draft auto-sends', () => {
  test('a present, empty array → safe (the model declared no action)', () => {
    expect(autoSendActionsSafe([])).toBe(true);
  });

  test('an ABSENT field (null/undefined) is a broken contract → NOT safe', () => {
    // The prompt requires intended_actions; a response that drops it is
    // malformed and must not auto-send (the field is the only no-action signal).
    expect(autoSendActionsSafe(undefined)).toBe(false);
    expect(autoSendActionsSafe(null)).toBe(false);
  });

  test('a PRESENT non-array payload is malformed → NOT safe (fail closed)', () => {
    // raw model output like {type:'send_payment_link'} sanitizes to [] later;
    // treating the malformed object as "not an array → safe" would leak it.
    expect(autoSendActionsSafe({ type: 'send_payment_link' })).toBe(false);
    expect(autoSendActionsSafe('escalate')).toBe(false);
    expect(autoSendActionsSafe(42)).toBe(false);
  });

  test("only 'none' actions → safe", () => {
    expect(autoSendActionsSafe([{ type: 'none' }])).toBe(true);
    expect(autoSendActionsSafe([{ type: 'none', note: 'no reply warranted' }, { type: 'none' }])).toBe(true);
    expect(autoSendActionsSafe(['none'])).toBe(true); // tolerates bare strings
  });

  test('any actionable type → NOT safe (fail closed)', () => {
    for (const t of ['escalate', 'book_appointment', 'send_payment_link', 'send_portal_link', 'send_estimate_link']) {
      expect(autoSendActionsSafe([{ type: t }])).toBe(false);
    }
    // a single actionable entry poisons an otherwise-safe set
    expect(autoSendActionsSafe([{ type: 'none' }, { type: 'escalate' }])).toBe(false);
  });
});

describe('isRealProviderSend — suppression sentinels are NOT a delivered SMS', () => {
  test('a real provider message id is a send', () => {
    expect(isRealProviderSend({ sent: true, providerMessageId: 'SM0123456789abcdef0123456789abcdef' })).toBe(true);
  });

  test('sent:false is never a send', () => {
    expect(isRealProviderSend({ sent: false, providerMessageId: 'SMxxxx' })).toBe(false);
    expect(isRealProviderSend(null)).toBe(false);
    expect(isRealProviderSend(undefined)).toBe(false);
  });

  test('sent:true with a suppression sentinel id is NOT a send', () => {
    for (const sentinel of SUPPRESSION_SENTINELS) {
      expect(isRealProviderSend({ sent: true, providerMessageId: sentinel })).toBe(false);
    }
    // gate-off, template-disabled, owner kill switch are the prod-reachable ones
    expect(isRealProviderSend({ sent: true, providerMessageId: 'gate-blocked' })).toBe(false);
    expect(isRealProviderSend({ sent: true, providerMessageId: 'owner-silence' })).toBe(false);
  });

  test('sent:true with no provider id is NOT a send', () => {
    expect(isRealProviderSend({ sent: true, providerMessageId: null })).toBe(false);
    expect(isRealProviderSend({ sent: true })).toBe(false);
  });
});

describe('isAmbiguousProviderOutcome — canonical delivery state owns claim settlement', () => {
  test('explicit uncertainty holds even without retry flags or a provider id', () => {
    expect(isAmbiguousProviderOutcome({ sent: false, deliveryOutcome: 'uncertain' })).toBe(true);
    expect(isAmbiguousProviderOutcome({ sent: true, deliveryOutcome: 'uncertain', providerMessageId: null })).toBe(true);
  });

  test('explicit non-delivery releases even when retryable', () => {
    expect(isAmbiguousProviderOutcome({ sent: false, deliveryOutcome: 'not_sent', retryable: true })).toBe(false);
  });

  test('legacy outcomes retain the retryable/deferred fallback', () => {
    expect(isAmbiguousProviderOutcome({ sent: false, retryable: true })).toBe(true);
    expect(isAmbiguousProviderOutcome({ sent: false, blocked: true, retryable: true })).toBe(false);
  });
});

describe('ladder + mode invariants', () => {
  test('auto_send is a valid mode and the executor constant agrees', () => {
    expect(VALID_MODES).toContain('auto_send');
    expect(AUTO_SEND_MODE).toBe('auto_send');
    expect(AUTOSEND_MODE).toBe('auto_send');
  });

  test('a normal intent may be flipped to auto_send', () => {
    const r = validateModeChange('general_customer_sms_needs_review', 'auto_send');
    expect(r.ok).toBe(true);
    expect(r.intent).toBe('general_customer_sms_needs_review');
  });

  test('escalation intents are locked out of auto_send (never graduate)', () => {
    const r = validateModeChange('customer_issue_needs_review', 'auto_send');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/escalation/i);
  });
});

describe('message_type + status separations the safety logic relies on', () => {
  test('an auto-sent outbound is NOT a human reply type', () => {
    // The thread guard-gauntlet asks "did a HUMAN answer?" — if ai_autosent
    // leaked into HUMAN_REPLY_TYPES, an auto-send would suppress the next one.
    expect(HUMAN_REPLY_TYPES).not.toContain(AUTOSEND_MESSAGE_TYPE);
    expect(AUTOSEND_MESSAGE_TYPE).toBe('ai_autosent');
  });

  test('claim / sent / failed are three distinct states', () => {
    expect(new Set([CLAIM_STATUS, SENT_STATUS, FAILED_STATUS]).size).toBe(3);
    expect(CLAIM_STATUS).toBe('sending');
    expect(SENT_STATUS).toBe('auto_sent');
  });
});

describe('server-enforced eligibility — escalation short-circuit (no DB)', () => {
  test('an escalation intent is never auto-send eligible, without touching the DB', async () => {
    const r = await graduation.evaluateAutoSendEligibility({ intent: 'customer_issue_needs_review' });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/escalation/i);
  });
});

// The one deliberate DB-touching case in this otherwise pure-logic file:
// gratitudeCandidatePage's own query-builder shape is the exact surface the
// pre-push audit's P1 flagged (a v11-only filter would silently stop
// discovering real-answers-drafted candidates once GATE_SMS_REAL_ANSWERS
// goes live). Isolated per-test via jest.doMock + resetModules so the rest
// of the file stays DB-free.
describe('gratitudeCandidatePage — discovery filter accepts EITHER recognized prompt version (pre-push audit P1)', () => {
  afterEach(() => {
    jest.dontMock('../models/db');
    jest.resetModules();
  });

  test('the candidate query matches PROMPT_VERSION, the bare REAL_ANSWERS_PROMPT_VERSION, or any +category-suffixed variant of it', () => {
    // A fixed 2-value whereIn (the round-1 fix) would stop matching the
    // moment a per-category gate joins the master one, since
    // currentPromptVersion() then suffixes the version with the active
    // category tags (pre-push audit P1 round 2) — this must be a LIKE-
    // prefix match instead, covering every such variant without
    // enumerating them.
    jest.resetModules();
    const whereCalls = [];
    const orWhereCalls = [];
    const query = {};
    for (const method of [
      'join', 'whereNotNull', 'whereRaw', 'orderBy', 'limit', 'select', 'whereNotExists', 'whereIn',
    ]) query[method] = jest.fn(() => query);
    // Knex's own subquery convention (a `this`-bound function, called with
    // NO positional argument) — the exact shape the real query builder AND
    // this mock both support; an arrow function relying on a parameter
    // would silently receive undefined here.
    query.where = jest.fn((...args) => {
      whereCalls.push(args);
      if (typeof args[0] === 'function') args[0].call(query);
      return query;
    });
    query.orWhere = jest.fn((...args) => { orWhereCalls.push(args); return query; });
    const mockDb = jest.fn(() => query);
    jest.doMock('../models/db', () => mockDb);
    const drafter = require('../services/sms-shadow-drafter');

    const fresh = require('../services/sms-auto-send');
    fresh.gratitudeCandidatePage({ activatedAt: new Date(0), now: new Date(), cursor: null, pageSize: 100 });

    const versionWhere = whereCalls.find(([col]) => col === 'md.prompt_version');
    expect(versionWhere).toEqual(['md.prompt_version', drafter.PROMPT_VERSION]);
    // ONE family LIKE (Codex #5392 r3 P0): keyed off the family, not the
    // current constant, so a suffix bump ('_cf', later ones) never strands
    // rows stamped under an earlier version.
    expect(orWhereCalls).toEqual([
      ['md.prompt_version', 'like', 'house\\_voice\\_v12\\_real\\_answers%'],
    ]);
    const pattern = orWhereCalls[0][2];
    const likeRe = new RegExp(`^${pattern.replace(/\\(.)/g, '\u0000$1').replace(/%/g, '.*').replace(/\u0000(.)/g, (_, c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}$`);
    for (const stamped of [
      'house_voice_v12_real_answers', // stamped before the bump
      'house_voice_v12_real_answers+c', // the row from the finding
      'house_voice_v12_real_answers+bclm',
      drafter.REAL_ANSWERS_PROMPT_VERSION, // 'house_voice_v12_real_answers5_cfl_p'
      `${drafter.REAL_ANSWERS_PROMPT_VERSION}+bc`,
      'house_voice_v12_real_answers_cf', // the company-facts cohort stamped before the re-service token
      'house_voice_v12_real_answers2_cf', // the re-service + company-facts cohort stamped before the LIVE ETA bump
      'house_voice_v12_real_answers2_cf_lbl+c', // a later suffix
    ]) expect(likeRe.test(stamped)).toBe(true);
    expect(likeRe.test('house_voice_v13_real_answers')).toBe(false);
    expect(likeRe.test('house_voice_v12X')).toBe(false);
    expect(likeRe.test('house_voice_v11')).toBe(false); // matched by the exact PROMPT_VERSION branch instead
  });
});
