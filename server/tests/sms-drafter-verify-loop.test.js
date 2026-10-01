/**
 * generateGroundedDraft — the draft→verify→revise convergence loop (v3).
 * Drives it with a scripted fake Anthropic client (no network, no DB): each
 * messages.create() returns the next queued response, so we can assert pass
 * counts and convergence for each path.
 */
// The service identity lane (a model call) answers "no job named", so the
// visit ladder picks the job: these suites test the OPEN TIMES plumbing, not
// the pick (covered in sms-real-answers.test.js). Other dispatches stay real.
jest.mock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return {
    ...actual,
    dispatchWithFallback: (policy, payload, options) => (payload?.laneId === 'sms_service_identity'
      ? Promise.resolve({ ok: true, json: { about: 'none', visit: null, service: null } })
      : actual.dispatchWithFallback(policy, payload, options)),
  };
});
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

  // Codex round-19 P2: an empty reply is not "nothing to check" when a covered re-service offer is OWED.
  describe('empty reply while an eligible pest report is owed the re-service offer', () => {
    const { reserviceFactLine } = require('../services/sms-shadow-drafter');
    const factsBlock = `FACTS\n${reserviceFactLine(['pest'])}\nBILLING:`;
    const args = (client) => ({ client, context: CTX, inboundMessage: 'the ants are back again', intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false, factsBlock });
    const OLD = process.env.GATE_SMS_REAL_ANSWERS;
    beforeAll(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
    afterAll(() => { if (OLD === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = OLD; });

    test('the empty reply is revised into the offer instead of converging', async () => {
      const offer = { reply: "So sorry about the ants! I'm sending your free pest re-service booking link now.", intended_actions: [{ type: 'escalate', note: 'send_reservice_link' }], missing_info: null };
      const client = makeClient([
        { reply: '', intended_actions: [{ type: 'none', note: 'no reply warranted' }], missing_info: null },
        offer, // the revision (the owed-offer violation skips the verifier)
        { supported: true, violations: [] },
      ]);
      const r = await generateGroundedDraft(args(client));
      expect(r.parsed.reply).toMatch(/free pest re-service booking link/);
      expect(r.converged).toBe(true);
    });

    test('empty reply + a model-emitted followup_promised escalate is still owed the offer (Codex round-20 P2)', async () => {
      const bad = { reply: '', intended_actions: [{ type: 'escalate', note: 'followup_promised' }], missing_info: null };
      const client = makeClient([bad, bad, bad]);
      const r = await generateGroundedDraft(args(client));
      expect(r.converged).toBe(false);
    });

    test('the classified intent never suppresses the owed offer ("the ants came back" is a customer issue / COMPLAINT)', async () => {
      const empty = { reply: '', intended_actions: [], missing_info: null };
      for (const intent of ['customer_issue_needs_review', 'COMPLAINT']) {
        const client = makeClient([empty, empty, empty]);
        const r = await generateGroundedDraft({ ...args(client), inboundMessage: 'the ants came back', intent: { intent } });
        expect(r.converged).toBe(false);
      }
    });

    test('an empty reply that is never fixed does not converge', async () => {
      const empty = { reply: '', intended_actions: [], missing_info: null };
      const client = makeClient([empty, empty, empty]);
      const r = await generateGroundedDraft(args(client));
      expect(r.converged).toBe(false);
    });

    test('not owed (lane not in the facts) → the empty reply still converges without a verify call', async () => {
      const client = makeClient([{ reply: '', intended_actions: [], missing_info: null }]);
      const r = await generateGroundedDraft({ ...args(client), factsBlock: `FACTS\n${reserviceFactLine([])}\nBILLING:` });
      expect(r.converged).toBe(true);
      expect(client.calls).toHaveLength(1);
    });
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
    // Codex #5194 P2: a frozen replay never calls buildFactsBlock (its facts
    // came from whenever the ORIGINAL draft was built, not now) — it has no
    // "generated now" instant of its own to persist.
    expect(r.factsGeneratedAt).toBeNull();
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

  // Codex r7 (structural): real answers require the verifier. With the kill
  // switch off, even a perfectly declared real-answers draft stays shadow —
  // never converged, never snapshotted, so nothing publishes or sends it.
  test('even a correctly declared offer is NOT converged with the verifier off — real answers require the verifier', async () => {
    const drafter = setup();
    const client = makeClient([{
      reply: 'How about Tuesday 9:00 AM - 11:00 AM?', intended_actions: [], missing_info: null,
      offered_times: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    }]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(client.calls).toHaveLength(1);
    expect(r.converged).toBe(false);
    expect(r.openTimesSnapshot).toBeNull();
    expect(r.parsed.reply).toMatch(/9:00 AM - 11:00 AM/); // still returned, so the judge can grade the shadow row
  });

  test('gate OFF with the verifier off: single-pass behaves exactly as before (converged)', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    const drafter = setup();
    const client = makeClient([{ reply: 'Thanks so much — we appreciate you!', intended_actions: [], missing_info: null }]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(client.calls).toHaveLength(1);
    expect(r.converged).toBe(true);
    expect(r.promptVersion).toBe('house_voice_v11');
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

// Codex r6 P1: an ineligible customer must never be promised a free visit.
describe('generateGroundedDraft — a free re-service offer needs the facts to say eligible', () => {
  const prior = { ra: process.env.GATE_SMS_REAL_ANSWERS, c: process.env.GATE_SMS_AGENT_COMPLAINTS };
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; process.env.GATE_SMS_AGENT_COMPLAINTS = 'true'; });
  afterEach(() => {
    for (const [k, v] of [['GATE_SMS_REAL_ANSWERS', prior.ra], ['GATE_SMS_AGENT_COMPLAINTS', prior.c]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    jest.dontMock('../services/reservice-scheduler'); jest.dontMock('../services/availability'); jest.dontMock('../models/db');
    jest.resetModules();
  });
  function setup(lanes) {
    jest.resetModules();
    // liveReserviceLaneState (fetchReserviceFactState's underlying live-lane check)
    // delegates entirely to reservice-scheduler.loadReserviceLaneAvailability
    // (the ONE shared availability the public re-service page also uses) —
    // mock that directly rather than modeling a fake customer row through
    // models/db.
    jest.doMock('../services/reservice-scheduler', () => ({
      ...jest.requireActual('../services/reservice-scheduler'),
      reserviceSelfServeEnabled: () => true,
      loadReserviceLaneAvailability: jest.fn(async () => ({ eligible: lanes, open: {}, bookable: lanes, verified: true })),
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots: jest.fn(async () => ({ days: [] })) }));
    const drafter = require('../services/sms-shadow-drafter');
    jest.spyOn(drafter, 'fetchReserviceFactState'); // observed only; the real one runs
    return drafter;
  }
  const args = (client) => ({
    client, context: { ...CTX, customer: { id: 'cust-1' } }, inboundMessage: 'I still have ants after the treatment',
    intent: { intent: 'complaint' }, schedulingIntent: false, city: 'Venice',
  });

  test('NOT eligible: the offer is caught deterministically, then a revision that escalates instead converges', async () => {
    const drafter = setup([]);
    const client = makeClient([
      { reply: 'So sorry — we will come back for a free re-service.', intended_actions: [], missing_info: null },
      { reply: 'So sorry about that — a manager will reach out within the hour.', intended_actions: [{ type: 'escalate' }], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.factsBlock).toContain('FREE RE-SERVICE: not eligible');
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(2);
    expect(client.calls).toHaveLength(3); // draft + revise + verify — the first failure never reached the verifier
    expect(r.parsed.reply).not.toMatch(/free/i);
  });

  // Codex round-1 P2 (c): a free-re-service PROMISE with no send_reservice_link
  // action is exactly as broken as an ineligible offer — nobody actually
  // sends the link.
  test('ELIGIBLE but no send_reservice_link action: caught deterministically, a revision that adds the action converges', async () => {
    const drafter = setup(['pest']);
    const client = makeClient([
      { reply: 'So sorry — we will come back for a free pest re-service.', intended_actions: [], missing_info: null },
      { reply: 'So sorry — we will come back for a free pest re-service.', intended_actions: [{ type: 'escalate', note: 'send_reservice_link' }], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.factsBlock).toContain('FREE RE-SERVICE: eligible for pest');
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(2);
    expect(r.parsed.intended_actions).toEqual([{ type: 'escalate', note: 'send_reservice_link' }]);
  });

  // Codex round-1 P2 (d): a GENERIC offer with no lane named in the reply
  // must resolve the reported lane from the inbound text — a lawn-only
  // entitlement must not cover a customer who reported ants.
  test('ELIGIBLE for lawn only, but the customer reported ants (pest): a generic offer is caught, a revision naming the right (ineligible) outcome converges', async () => {
    const drafter = setup(['lawn']);
    const client = makeClient([
      // Generic — no lane named — but the inbound reports ants (pest), and
      // only lawn is eligible.
      { reply: "Good news — we'll send your free re-service link now.", intended_actions: [{ type: 'escalate', note: 'send_reservice_link' }], missing_info: null },
      { reply: 'So sorry about that — a manager will reach out within the hour.', intended_actions: [{ type: 'escalate' }], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.factsBlock).toContain('FREE RE-SERVICE: eligible for lawn');
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(2);
    expect(r.parsed.reply).not.toMatch(/free/i);
  });
});

// Codex round-1 P2 (b): needsOpenTimes must cover the FULL pest-report class
// the PEST REPORTS bullet names, not just the SAVE_SALE_TEXT_RE subset — a
// message like "they're back" must still fetch OPEN TIMES so the "not
// eligible" branch has real times to offer instead of an empty hand-off.
describe('generateGroundedDraft — pest-report phrasing fetches OPEN TIMES even with no scheduling intent (Codex round-1 P2 (b))', () => {
  const prior = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });

  function setupAvailability() {
    jest.resetModules();
    jest.doMock('../services/availability', () => ({
      getAvailableSlots: jest.fn(async () => ({ days: [
        { fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] },
      ] })),
    }));
    return require('../services/sms-shadow-drafter');
  }

  test.each([
    'the ants are back',
    'I saw roaches again',
    // Codex round 2: the enumerated "back"/"again" phrasings missed these —
    // the structural fix (pest noun + any activity verb, anywhere in the
    // text) catches them without a new enumerated phrase.
    'the roaches have returned',
    'more ants showed up after the treatment',
  ])('%s → OPEN TIMES is fetched (present in the facts block) though SAVE_SALE_TEXT_RE and schedulingIntent both miss it', async (inboundMessage) => {
    const drafter = setupAvailability();
    const client = makeClient([
      { reply: 'Sorry to hear that! Here is a time that works.', intended_actions: [], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft({
      client, context: CTX, inboundMessage, intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false, city: 'Venice',
    });
    expect(r.factsBlock).toContain('OPEN TIMES (real, bookable slots');
  });
});

// The deterministic complaint backstop this test covered (validateComplaintEscalation
// / hasComplaintSignal / complaintSignals) was removed 2026-09-29: several
// audit and Codex rounds kept finding new complaint shapes a regex missed
// (anger, cancel threats, damage attribution, re-service resolution for an
// already-held complaint) — a non-converging chokepoint. The PEST REPORTS
// bullet's own prompt precedence (an actual complaint always wins over pest
// activity wording) is now the only enforcement, backed by every draft being
// staff-reviewed and escalation intents never auto-sending — see the code
// comment at the PEST REPORTS bullet in sms-shadow-drafter.js.

// Codex r7 P1: with a category gate on the model answers chemical questions
// itself, so compliance copy is enforced at publication, not by the prompt.
describe('generateGroundedDraft — banned compliance copy never converges', () => {
  const prior = { ra: process.env.GATE_SMS_REAL_ANSWERS, cm: process.env.GATE_SMS_AGENT_CHEMICAL_MEDICAL };
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; process.env.GATE_SMS_AGENT_CHEMICAL_MEDICAL = 'true'; });
  afterEach(() => {
    for (const [k, v] of [['GATE_SMS_REAL_ANSWERS', prior.ra], ['GATE_SMS_AGENT_CHEMICAL_MEDICAL', prior.cm]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    jest.resetModules();
  });
  const args = (client) => ({
    client, context: CTX, inboundMessage: 'Is the spray safe for my dog?',
    intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false,
  });

  test('"pet-safe" is caught deterministically (no verifier call) and a compliant revision converges', async () => {
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');
    const client = makeClient([
      { reply: 'Yes — the treatment is totally pet-safe once we leave.', intended_actions: [], missing_info: null },
      { reply: 'It is safe once dry, and your technician will confirm the timing at the visit.', intended_actions: [], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(2);
    expect(client.calls).toHaveLength(3);
    expect(r.parsed.reply).not.toMatch(/pet-safe/i);
  });

  test('banned copy on every attempt → never converged, the verifier is never reached', async () => {
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');
    const bad = { reply: 'It is EPA-approved and dries in 30 minutes.', intended_actions: [], missing_info: null };
    const client = makeClient([bad, bad, bad]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.converged).toBe(false);
    expect(client.calls).toHaveLength(3);
  });
});

// Codex #5194 P2 ("Timestamp the SLA when its facts are generated"): a live
// draft's factsGeneratedAt must be the SAME instant buildFactsBlock rendered
// "FOLLOW-UP SLA RIGHT NOW" from — the caller (draftShadowReply →
// publishSuggestion / claimAutoSend) persists it so the send-time deadline
// checks (sms-followup-sla.js's slaDraftedAt) can anchor on it instead of
// the row's later created_at.
describe('generateGroundedDraft — factsGeneratedAt is the exact instant the SLA phrase was rendered from', () => {
  const prior = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; jest.resetModules(); });
  afterEach(() => {
    if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior;
    jest.useRealTimers();
    jest.resetModules();
  });

  const args = (client) => ({
    client, context: CTX, inboundMessage: 'Can someone call me back about my account?',
    intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false,
  });

  test('a draft built right at the 8 PM ET boundary returns the exact instant its own phrase was computed from', async () => {
    // Mon 2026-09-28 19:59:00 ET — one minute before the "within the hour"
    // window closes; a fixed clock stands in for the real instant
    // generateGroundedDraft would otherwise capture with `new Date()`.
    jest.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-28T23:59:00.000Z') });
    const drafter = require('../services/sms-shadow-drafter');
    const client = makeClient([
      { reply: 'So sorry about that — a manager will reach out within the hour.', intended_actions: [{ type: 'escalate', note: 'followup_promised' }], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.converged).toBe(true);
    expect(r.factsBlock).toContain('FOLLOW-UP SLA RIGHT NOW: within the hour');
    expect(r.factsGeneratedAt).toBeInstanceOf(Date);
    expect(r.factsGeneratedAt.toISOString()).toBe('2026-09-28T23:59:00.000Z');
    // The phrase this SAME instant would render is exactly the phrase that
    // landed in factsBlock — the drafter never renders off one instant and
    // returns another.
    const { followupSlaPhrase } = require('../services/sms-shadow-drafter');
    expect(followupSlaPhrase(r.factsGeneratedAt)).toBe('within the hour');
  });

  test('drafted one minute later, past the boundary, returns the later instant and the "tomorrow morning" phrase', async () => {
    jest.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-29T00:01:00.000Z') }); // Mon 20:01 ET
    const drafter = require('../services/sms-shadow-drafter');
    const client = makeClient([
      { reply: 'So sorry about that — a manager will reach out by 9 AM tomorrow morning.', intended_actions: [{ type: 'escalate', note: 'followup_promised' }], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await drafter.generateGroundedDraft(args(client));
    expect(r.converged).toBe(true);
    expect(r.factsBlock).toContain('FOLLOW-UP SLA RIGHT NOW: by 9 AM tomorrow morning');
    expect(r.factsGeneratedAt.toISOString()).toBe('2026-09-29T00:01:00.000Z');
  });
});
