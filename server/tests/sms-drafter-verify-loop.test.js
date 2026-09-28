/**
 * generateGroundedDraft — the draft→verify→revise convergence loop (v3).
 * Drives it with a scripted fake Anthropic client (no network, no DB): each
 * messages.create() returns the next queued response, so we can assert pass
 * counts and convergence for each path.
 */
const { generateGroundedDraft } = require('../services/sms-shadow-drafter');

function makeClient(scripted) {
  const queue = [...scripted];
  const calls = [];
  return {
    calls,
    messages: {
      create: (args) => {
        calls.push(args);
        const next = queue.shift();
        if (next === undefined) throw new Error('out of scripted responses');
        return Promise.resolve({ content: [{ text: typeof next === 'string' ? next : JSON.stringify(next) }] });
      },
    },
  };
}

const CTX = { summary: 'Dana — Quarterly Pest, Venice', upcomingServices: [{ type: 'Quarterly Pest', date: '2026-06-19' }] };
const ARGS = (client) => ({ client, context: CTX, inboundMessage: 'When are you coming?', intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false });

describe('generateGroundedDraft — convergence loop', () => {
  test('verifier clean on first check → 1 pass, converged', async () => {
    const client = makeClient([
      { reply: 'Hello Dana! I will confirm your exact time and get right back to you.', intended_actions: [], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.passes).toBe(1);
    expect(r.converged).toBe(true);
    expect(r.parsed.reply).toMatch(/confirm your exact time/);
    expect(client.calls).toHaveLength(2); // draft + 1 verify
    // sms_verifier requests effort:'medium' (2026-09-26): a supported/not
    // yes-no check needs no deep reasoning, and MODELS.DEEP (Opus 4.8 by
    // default) is effort-capable, so the request carries it through.
    expect(client.calls[1].output_config).toEqual({ effort: 'medium' });
  });

  test('violation → revise → clean → 2 passes, converged on the revised draft', async () => {
    const client = makeClient([
      { reply: 'Hello Dana! See you tomorrow at 2 PM.', intended_actions: [], missing_info: null }, // fabricates
      { supported: false, violations: ['invents "tomorrow at 2 PM"'] },
      { reply: 'Hello Dana! Let me confirm your time and get right back to you.', intended_actions: [], missing_info: null }, // revised
      { supported: true, violations: [] },
    ]);
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.passes).toBe(2);
    expect(r.converged).toBe(true);
    expect(r.parsed.reply).toMatch(/confirm your time/);
    expect(client.calls).toHaveLength(4); // draft + verify + revise + verify
  });

  test('still violating after the revision budget → not converged', async () => {
    // default MAX_REVISIONS=2 → draft + (verify, revise) + (verify, revise) + verify
    const fab = { reply: 'See you Tuesday at 9am.', intended_actions: [], missing_info: null };
    const bad = { supported: false, violations: ['invents Tuesday 9am'] };
    const client = makeClient([fab, bad, fab, bad, fab, bad]);
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.converged).toBe(false);
    expect(r.passes).toBe(3); // 3 generations
  });

  test('empty reply asserts nothing → converged without a verify call', async () => {
    const client = makeClient([{ reply: '', intended_actions: [{ type: 'none', note: 'no reply warranted' }], missing_info: null }]);
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(1);
    expect(client.calls).toHaveLength(1); // draft only — nothing to verify
  });

  test('a revise error keeps the prior draft, not converged (Codex P2)', async () => {
    // draft → verify(violation) → revise THROWS. Must keep the first draft,
    // not drop the whole sample.
    const queue = [
      { reply: 'See you Tuesday at 2 PM.', intended_actions: [], missing_info: null },
      { supported: false, violations: ['invents Tuesday 2 PM'] },
    ];
    const calls = [];
    const client = {
      calls,
      messages: {
        create: (args) => {
          calls.push(args);
          if (calls.length <= 2) return Promise.resolve({ content: [{ text: JSON.stringify(queue[calls.length - 1]) }] });
          return Promise.reject(new Error('revise 429')); // the revision call fails
        },
      },
    };
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.parsed.reply).toBe('See you Tuesday at 2 PM.'); // prior draft kept
    expect(r.converged).toBe(false);
  });

  test('a verify error degrades gracefully — keeps the draft, not converged', async () => {
    const queue = [{ reply: 'Hello Dana! On it.', intended_actions: [], missing_info: null }];
    const calls = [];
    const client = {
      calls,
      messages: {
        create: (args) => {
          calls.push(args);
          if (calls.length === 1) return Promise.resolve({ content: [{ text: JSON.stringify(queue[0]) }] });
          return Promise.reject(new Error('verifier 500'));
        },
      },
    };
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.parsed.reply).toBe('Hello Dana! On it.');
    expect(r.converged).toBe(false);
  });
});

// Owner-directed structural fix (PR #5119, after 3 non-converging local-audit
// rounds trying to re-derive date binding from prose): the model now
// DECLARES offered_times directly, and generateGroundedDraft validates it
// DETERMINISTICALLY — before spending a verifier call — feeding any
// violation into this SAME revise/verify loop exactly like an ordinary
// fact-check miss.
describe('generateGroundedDraft — offered_times structural check shares the revise/verify loop', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;

  function freshDrafter() {
    jest.resetModules();
    return require('../services/sms-shadow-drafter');
  }

  beforeEach(() => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
  });

  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });

  function argsFor(client) {
    return {
      client, context: CTX, inboundMessage: 'Can we book a visit?',
      intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: true, city: 'Venice',
    };
  }

  function mockOneOpenSlot() {
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }],
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
  }

  test('a correctly-declared offered_times converges on the first pass, persisted onto openTimesSnapshot', async () => {
    mockOneOpenSlot();
    const drafter = freshDrafter();
    const client = makeClient([
      {
        reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [{ type: 'book_appointment' }], missing_info: null,
        offered_times: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(argsFor(client));
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(1);
    // draft + verify — the deterministic check passed, so it spent no EXTRA call.
    expect(client.calls).toHaveLength(2);
    expect(r.openTimesSnapshot).toEqual({
      // serviceType = CTX's next visit (Codex r3): the recheck asks the engine the same question
      lookup: { city: 'Venice', customerId: null, estimateId: null, serviceType: 'Quarterly Pest' },
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
  });

  test('an offered_times entry not actually in OPEN TIMES is caught DETERMINISTICALLY (no verifier call spent) and revises to a grounded one', async () => {
    mockOneOpenSlot();
    const drafter = freshDrafter();
    const client = makeClient([
      // pass 1: claims a slot that was never offered
      {
        reply: 'How about Tuesday 3:00 PM - 5:00 PM?', intended_actions: [], missing_info: null,
        offered_times: [{ date: 'Tuesday, September 29', window: '3:00 PM - 5:00 PM' }],
      },
      // revised draft: now grounded
      {
        reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null,
        offered_times: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(argsFor(client));
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(2);
    // draft + revise + verify = 3 — the FIRST pass's failure never reached
    // the (paid) LLM verifier; it was caught deterministically.
    expect(client.calls).toHaveLength(3);
    expect(r.parsed.reply).toMatch(/9:00 AM - 11:00 AM/);
  });

  test('a reply that quotes a time missing from offered_times exhausts the revision budget → not converged, never reaches the verifier', async () => {
    mockOneOpenSlot();
    const drafter = freshDrafter();
    // Quotes a real OPEN TIMES window but never declares it in offered_times
    // — the same bug on every attempt, so it never converges.
    const bad = { reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null, offered_times: [] };
    const client = makeClient([bad, bad, bad]); // draft + MAX_REVISIONS(2) revisions, same bug each time
    const r = await drafter.generateGroundedDraft(argsFor(client));
    expect(r.converged).toBe(false);
    expect(r.passes).toBe(3);
    // Every pass caught deterministically — the verifier is NEVER reached.
    expect(client.calls).toHaveLength(3);
  });

  test('a no-times draft (offered_times absent, reply names none) is completely unaffected by the check', async () => {
    mockOneOpenSlot();
    const drafter = freshDrafter();
    const client = makeClient([
      { reply: 'Sure — I will check on that and get right back to you.', intended_actions: [], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(argsFor(client));
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(1);
    expect(r.openTimesSnapshot).toBeNull();
  });
});

// Pre-push audit P1: a sealed-exam replay passes the FROZEN facts block and
// must never fetch today's calendar — but it still has to validate
// offered_times against the OPEN TIMES the draft actually saw, or every
// correctly declared offer in the exam would be rejected against an empty
// list and the exam would grade drift toward deferral.
describe('generateGroundedDraft — frozen replay (presetFactsBlock) validates offered_times against the frozen OPEN TIMES, with no availability fetch', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  const FROZEN = 'CUSTOMER: Dana — Quarterly Pest, Venice\nOPEN TIMES (real, bookable slots, ET — offer ONLY from this list, never invent one):\n- Tuesday, September 29: 9:00 AM - 11:00 AM\nBILLING:\n- balance: $0\n';

  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });

  function setup() {
    jest.resetModules();
    const getAvailableSlots = jest.fn(async () => ({ days: [{ fullDate: 'Friday, October 2', slots: [{ startTime24: '13:00' }] }] })); // today's calendar — must NOT be consulted
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = require('../services/sms-shadow-drafter');
    return { drafter, getAvailableSlots };
  }
  const args = (client) => ({
    client, context: CTX, inboundMessage: 'Can we book a visit?', intent: { intent: 'general_customer_sms_needs_review' },
    schedulingIntent: true, city: 'Venice', factsBlock: FROZEN,
  });

  test('an offer correctly declared from the FROZEN OPEN TIMES converges; the live calendar is never fetched; no send-time snapshot is minted', async () => {
    const { drafter, getAvailableSlots } = setup();
    const client = makeClient([
      {
        reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null,
        offered_times: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(1);
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(r.factsBlock).toBe(FROZEN);
    expect(r.openTimesSnapshot).toBeNull();
  });

  test('an offer from TODAY\'s calendar (not in the frozen OPEN TIMES) is rejected deterministically', async () => {
    const { drafter, getAvailableSlots } = setup();
    const bad = {
      reply: 'How about Friday 1:00 PM - 3:00 PM?', intended_actions: [], missing_info: null,
      offered_times: [{ date: 'Friday, October 2', window: '1:00 PM - 3:00 PM' }],
    };
    const client = makeClient([bad, bad, bad]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.converged).toBe(false);
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(3); // never reached the verifier
  });
});

// Pre-push audit P1 (round 2): a reply CONFIRMING an existing visit whose
// arrival window text equals an OPEN TIMES window on another day must not
// be forced into revision as an undeclared offer.
describe('generateGroundedDraft — confirming a booked visit whose window text matches an open slot elsewhere is not an offer', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });

  test('offered_times [] on a confirmation converges on the first pass, with no send-time snapshot', async () => {
    jest.resetModules();
    jest.doMock('../services/availability', () => ({
      getAvailableSlots: jest.fn(async () => ({ days: [{ fullDate: 'Wednesday, September 30', slots: [{ startTime24: '09:00' }] }] })),
    }));
    const drafter = require('../services/sms-shadow-drafter');
    const context = {
      summary: 'Dana — Quarterly Pest, Venice',
      upcomingServices: [{ type: 'Quarterly Pest', date: '2026-09-29', window: '9:00 AM - 11:00 AM', tech: 'Sam' }],
    };
    const client = makeClient([
      { reply: 'You are all set for Tuesday 9:00 AM - 11:00 AM with Sam.', intended_actions: [], missing_info: null, offered_times: [] },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft({
      client, context, inboundMessage: 'What time are you coming Tuesday?',
      intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: true, city: 'Venice',
    });
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(1);
    expect(r.factsBlock).toContain('Wednesday, September 30: 9:00 AM - 11:00 AM'); // the open slot WAS in play
    expect(r.openTimesSnapshot).toBeNull();
  });
});

// PR #5119 pre-push audit P1 (round 3): the deterministic check cannot bind a
// declared DATE to the day the reply's prose names, so the declaration rides
// into the verifier's user prompt for the LLM to check like any other fact.
describe('generateGroundedDraft — the verifier receives the draft\'s offered_times as DECLARED OFFERS', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });

  test('the verifier call\'s user content lists the declared (date, window) pairs; a draft with none is told the declaration is "none"', async () => {
    jest.resetModules();
    jest.doMock('../services/availability', () => ({
      getAvailableSlots: jest.fn(async () => ({ days: [{ fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }] })),
    }));
    const drafter = require('../services/sms-shadow-drafter');
    const client = makeClient([
      {
        reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null,
        offered_times: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      },
      { supported: true, violations: [] },
    ]);
    await drafter.generateGroundedDraft({
      client, context: CTX, inboundMessage: 'Can we book a visit?', intent: { intent: 'general_customer_sms_needs_review' },
      schedulingIntent: true, city: 'Venice',
    });
    const verifierCall = client.calls[1];
    const userContent = verifierCall.messages[0].content;
    expect(userContent).toContain('DECLARED OFFERS');
    expect(userContent).toContain('- Tuesday, September 29: 9:00 AM - 11:00 AM');

    const client2 = makeClient([
      { reply: 'Sure — I will check on that and get right back to you.', intended_actions: [], missing_info: null },
      { supported: true, violations: [] },
    ]);
    await drafter.generateGroundedDraft({
      client: client2, context: CTX, inboundMessage: 'Can we book a visit?', intent: { intent: 'general_customer_sms_needs_review' },
      schedulingIntent: true, city: 'Venice',
    });
    // OPEN TIMES was still in play (the slot was fetched), so the verifier is
    // told the draft declares NO offers — an undeclared one is then a violation.
    expect(client2.calls[1].messages[0].content).toContain('(none — the drafter declares that this draft offers NO new appointment times)');
  });
});

// Codex r2 P2: SHADOW_DRAFT_VERIFY=false (single-pass) skipped the
// deterministic offered_times check along with the LLM verifier, so a draft
// quoting a slot with a missing/wrong declaration could persist a null or
// wrong send-time snapshot. The check costs no call and now runs there too.
describe('generateGroundedDraft — single-pass mode (SHADOW_DRAFT_VERIFY=false) still runs the deterministic offered_times check', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  const priorVerify = process.env.SHADOW_DRAFT_VERIFY;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; process.env.SHADOW_DRAFT_VERIFY = 'false'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    if (priorVerify === undefined) delete process.env.SHADOW_DRAFT_VERIFY; else process.env.SHADOW_DRAFT_VERIFY = priorVerify;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });
  function setup() {
    jest.resetModules();
    jest.doMock('../services/availability', () => ({
      getAvailableSlots: jest.fn(async () => ({ days: [{ fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }] })),
    }));
    return require('../services/sms-shadow-drafter');
  }
  const args = (client) => ({
    client, context: CTX, inboundMessage: 'Can we book a visit?', intent: { intent: 'general_customer_sms_needs_review' },
    schedulingIntent: true, city: 'Venice',
  });

  test('a correctly declared offer → converged, one call, snapshot persisted', async () => {
    const drafter = setup();
    const client = makeClient([{
      reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null,
      offered_times: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    }]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(client.calls).toHaveLength(1);
    expect(r.converged).toBe(true);
    expect(r.openTimesSnapshot?.quotedWindows).toEqual([{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }]);
  });

  test('a quoted slot with NO declaration → NOT converged (consumers refuse it), no snapshot, still one call', async () => {
    const drafter = setup();
    const client = makeClient([{ reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null, offered_times: [] }]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(client.calls).toHaveLength(1);
    expect(r.converged).toBe(false);
    expect(r.openTimesSnapshot).toBeNull();
    expect(r.parsed.reply).toMatch(/9:00 AM - 11:00 AM/); // the draft itself is still returned for telemetry
  });
});

// Codex r3: with the LLM verifier OFF nothing can judge whether a quoted
// window is a confirmation of a booked visit or an undeclared offer, so the
// single-pass check runs WITHOUT the grounded-elsewhere allowance.
describe('generateGroundedDraft — single-pass mode gives no grounded-elsewhere allowance', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  const priorVerify = process.env.SHADOW_DRAFT_VERIFY;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; process.env.SHADOW_DRAFT_VERIFY = 'false'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    if (priorVerify === undefined) delete process.env.SHADOW_DRAFT_VERIFY; else process.env.SHADOW_DRAFT_VERIFY = priorVerify;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });

  test('booked Tuesday 9-11, open Wednesday 9-11, reply quotes 9-11 with offered_times [] → NOT converged, no snapshot', async () => {
    jest.resetModules();
    jest.doMock('../services/availability', () => ({
      getAvailableSlots: jest.fn(async () => ({ days: [{ fullDate: 'Wednesday, September 30', slots: [{ startTime24: '09:00' }] }] })),
    }));
    const drafter = require('../services/sms-shadow-drafter');
    const context = {
      summary: 'Dana — Quarterly Pest, Venice',
      upcomingServices: [{ type: 'Quarterly Pest', date: '2026-09-29', window: '9:00 AM - 11:00 AM', tech: 'Sam' }],
    };
    const client = makeClient([{ reply: 'How about Wednesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null, offered_times: [] }]);
    const r = await drafter.generateGroundedDraft({
      client, context, inboundMessage: 'Can we move it?', intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: true, city: 'Venice',
    });
    expect(client.calls).toHaveLength(1);
    expect(r.converged).toBe(false);
    expect(r.openTimesSnapshot).toBeNull();
  });
});

// Codex r4: single-pass drafts must also bind each declared day to the day
// the customer reads next to that time.
describe('generateGroundedDraft — single-pass mode requires the reply to name each declared day', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  const priorVerify = process.env.SHADOW_DRAFT_VERIFY;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; process.env.SHADOW_DRAFT_VERIFY = 'false'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    if (priorVerify === undefined) delete process.env.SHADOW_DRAFT_VERIFY; else process.env.SHADOW_DRAFT_VERIFY = priorVerify;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });
  test('Tuesday and Wednesday both open 9-11; reply says Tuesday, declares Wednesday → not converged, no snapshot', async () => {
    jest.resetModules();
    jest.doMock('../services/availability', () => ({
      getAvailableSlots: jest.fn(async () => ({ days: [
        { fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] },
        { fullDate: 'Wednesday, September 30', slots: [{ startTime24: '09:00' }] },
      ] })),
    }));
    const drafter = require('../services/sms-shadow-drafter');
    const client = makeClient([{
      reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null,
      offered_times: [{ date: 'Wednesday, September 30', window: '9:00 AM - 11:00 AM' }],
    }]);
    const r = await drafter.generateGroundedDraft({
      client, context: CTX, inboundMessage: 'Can we book?', intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: true, city: 'Venice',
    });
    expect(r.converged).toBe(false);
    expect(r.openTimesSnapshot).toBeNull();
  });
});
