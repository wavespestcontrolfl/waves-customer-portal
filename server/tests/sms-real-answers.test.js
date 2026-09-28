/**
 * SMS real answers (owner ruling 2026-09-27) — GATE_SMS_REAL_ANSWERS.
 *
 * Covers:
 *  - Gate off: prompt + facts block stay byte-identical to v11 (house_voice_v11).
 *  - Gate on: the "confirm and follow up" rule is replaced with answer-from-
 *    the-facts + real offers (OPEN TIMES / book_appointment, exact amounts /
 *    send_payment_link, portal/estimate links); PROMPT_VERSION bumps to
 *    house_voice_v12_real_answers.
 *  - HELD-FOR-A-PERSON hand-off list narrows exactly by whichever per-category
 *    gate (GATE_SMS_AGENT_COMPLAINTS / _BILLING_DISPUTES / _CHEMICAL_MEDICAL /
 *    _LEGAL) is on; cancellations are never in that list.
 *  - fetchOpenTimesBlock: gated, scheduling-intent + city gated, fully
 *    fail-safe (error/timeout/missing input -> null, never throws).
 *  - buildFactsBlock renders the OPEN TIMES section only when handed one.
 *  - generateGroundedDraft / draftShadowReply wire city -> AvailabilityEngine
 *    and stamp prompt_version per draft.
 *
 * Synthetic customer names only, per repo policy.
 */
const {
  buildSystemPrompt,
  buildSystemPromptWithProfile,
  buildFactsBlock,
  followupSlaPhrase,
  REAL_ANSWERS_HANDOFF_CATEGORIES,
  INTENDED_ACTION_TYPES,
  PROMPT_VERSION,
  REAL_ANSWERS_PROMPT_VERSION,
  currentPromptVersion,
} = require('../services/sms-shadow-drafter');

const GATE = 'GATE_SMS_REAL_ANSWERS';
const CATEGORY_GATES = REAL_ANSWERS_HANDOFF_CATEGORIES.map((c) => c.gate);
const ALL_GATES = [GATE, ...CATEGORY_GATES];

function clearGates() {
  for (const g of ALL_GATES) delete process.env[g];
}

afterEach(() => {
  clearGates();
});

describe('GATE_SMS_REAL_ANSWERS off — byte-identical to v11', () => {
  test('buildSystemPrompt() is unaffected whether the gate is unset or explicitly false', () => {
    clearGates();
    const base = buildSystemPrompt();
    process.env[GATE] = 'false';
    expect(buildSystemPrompt()).toBe(base);
    delete process.env[GATE];
    expect(buildSystemPrompt()).toBe(base);
  });

  test('the v11 defer rule and hand-off bullet are untouched; no v12 language leaks in', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "When you lack a fact the customer needs, the BEST reply acknowledges warmly and says you'll confirm and follow up — that is correct and safe, not a failure, and often better than the answer a human gave. Record the gap in missing_info."
    );
    expect(prompt).toContain(
      '- If the message warrants a human (cancellation, complaint, billing dispute, chemical/medical concern, legal threat), the reply should acknowledge warmly without resolving, and intended_actions must include {"type":"escalate"}.'
    );
    expect(prompt).not.toContain('HELD FOR A PERSON');
    expect(prompt).not.toContain('cancel_request');
    expect(prompt).not.toContain('OPEN TIMES');
    expect(prompt).toContain(
      '(SERVICE HISTORY, UPCOMING SERVICES, BILLING, PENDING ESTIMATE, PROPERTY & PREFERENCES, LAWN HEALTH, ACCOUNT FLAGS, RECENT PHONE CALLS, LATEST CALL TRANSCRIPT, the thread)'
    );
  });

  test('buildSystemPromptWithProfile reports realAnswersApplied:false and keeps the applied/system contract for the voice profile', () => {
    const noProfile = buildSystemPromptWithProfile();
    expect(noProfile.realAnswersApplied).toBe(false);
    expect(noProfile.applied).toBe(false);

    const withProfile = buildSystemPromptWithProfile('Warm and brief.');
    expect(withProfile.realAnswersApplied).toBe(false);
    expect(withProfile.applied).toBe(true);
  });

  test('buildFactsBlock ignores the extras param when it carries no openTimesBlock — output unchanged', () => {
    const context = { summary: 'Test customer', upcomingServices: [{ type: 'Quarterly Pest', date: '2026-06-19', window: '8-10am' }] };
    const noArg = buildFactsBlock(context);
    expect(buildFactsBlock(context, {})).toBe(noArg);
    expect(buildFactsBlock(context, { openTimesBlock: null })).toBe(noArg);
    expect(buildFactsBlock(context, { openTimesBlock: '' })).toBe(noArg);
    expect(noArg).not.toContain('OPEN TIMES');
  });

  test('PROMPT_VERSION export stays house_voice_v11 (the live/default cohort identity)', () => {
    expect(PROMPT_VERSION).toBe('house_voice_v11');
    expect(REAL_ANSWERS_PROMPT_VERSION).toBe('house_voice_v12_real_answers');
    expect(REAL_ANSWERS_PROMPT_VERSION).not.toBe(PROMPT_VERSION);
  });

  test('currentPromptVersion() resolves to PROMPT_VERSION while the gate is off', () => {
    clearGates();
    expect(currentPromptVersion()).toBe(PROMPT_VERSION);
  });
});

describe('GATE_SMS_REAL_ANSWERS on — the rewritten prompt', () => {
  beforeEach(() => {
    process.env[GATE] = 'true';
  });

  test('replaces "confirm and follow up" with answer-from-the-facts + real offers', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("the BEST reply acknowledges warmly and says you'll confirm and follow up");
    expect(prompt).toContain('Answer from the facts you have — that is the BEST reply, not a fallback.');
    expect(prompt).toContain('offer 2–3 SPECIFIC times straight from OPEN TIMES');
    expect(prompt).toContain('{"type":"book_appointment"}');
    expect(prompt).toContain('{"type":"send_payment_link"}');
    expect(prompt).toContain('{"type":"send_portal_link"}');
    expect(prompt).toContain('{"type":"send_estimate_link"}');
    // the SLA points at the FACTS, never a live-computed value (see the
    // time-invariance test below) — the rule text still names what that
    // fact IS, for a human reading the prompt
    expect(prompt).toContain('the EXACT wording from FOLLOW-UP SLA RIGHT NOW in the facts below');
    expect(prompt).toContain('the 1-business-hour follow-up SLA, 8am–8pm ET');
    // FACT DISCIPLINE still fully in force — never invent a time
    expect(prompt).toMatch(/never invent one/);
  });

  test('the system prompt is TIME-INVARIANT across the 8am/8pm ET boundary (pre-push audit P1)', () => {
    // sms-gratitude-qualification.js hashes the full rendered system prompt
    // and pins it (systemPromptSha256); a value that flips at a clock
    // boundary with no code/config change would silently block a qualified
    // gratitude lane with pins_changed the next time the clock crosses it.
    // buildSystemPromptWithProfile takes no `now` — it must never differ no
    // matter when it's called. Prove it holds at both real clock instants
    // Date.now() can return, one on each side of the boundary.
    const real = Date.now;
    try {
      Date.now = () => new Date('2026-09-28T14:00:00Z').getTime(); // 10:00 AM ET — "within the hour" territory
      const inHours = buildSystemPrompt();
      Date.now = () => new Date('2026-09-29T02:00:00Z').getTime(); // 10:00 PM ET — "by 9 AM tomorrow morning" territory
      const afterHours = buildSystemPrompt();
      expect(inHours).toBe(afterHours);
      expect(inHours).not.toMatch(/within the hour|by 9 AM tomorrow morning/);
    } finally {
      Date.now = real;
    }
  });

  test('OPEN TIMES joins the FACT DISCIPLINE grounding sources', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      '(SERVICE HISTORY, UPCOMING SERVICES, OPEN TIMES, BILLING, PENDING ESTIMATE, PROPERTY & PREFERENCES, LAWN HEALTH, ACCOUNT FLAGS, RECENT PHONE CALLS, LATEST CALL TRANSCRIPT, the thread)'
    );
    expect(prompt).toContain('UPCOMING SERVICES, OPEN TIMES, or the thread');
  });

  test('HELD FOR A PERSON defaults to all four categories; cancellations are never in that list', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/HELD FOR A PERSON: complaints, billing disputes, chemical\/medical concerns, legal threats\./);
    expect(prompt.match(/HELD FOR A PERSON:[^.]*\./)[0]).not.toMatch(/cancellation/i);
  });

  test('CANCELLATIONS are answered, never escalated as their own category: skip/reschedule from OPEN TIMES only, never an invented discount/credit/refund, plus escalate/cancel_request', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "- CANCELLATIONS are never escalated as their own category: acknowledge, ask what's driving it, and offer ONLY real options — skipping or rescheduling the next visit using 2–3 SPECIFIC times from OPEN TIMES. NEVER invent a discount, credit, or refund. Always add {\"type\":\"escalate\",\"note\":\"cancel_request\"} to intended_actions so a person still processes the actual cancellation."
    );
  });

  test('each category gate removes exactly that category from HELD and adds its own instruction', () => {
    process.env.GATE_SMS_AGENT_COMPLAINTS = 'true';
    let prompt = buildSystemPrompt();
    expect(prompt).toMatch(/HELD FOR A PERSON: billing disputes, chemical\/medical concerns, legal threats\./);
    expect(prompt).toContain(
      '- COMPLAINTS: answer from the facts, acknowledge what happened, and — if it fits — offer a free re-service using 2–3 SPECIFIC times from OPEN TIMES, adding {"type":"book_appointment"} once they confirm one.'
    );
    expect(prompt).not.toContain('BILLING DISPUTES: answer from the facts only');
    delete process.env.GATE_SMS_AGENT_COMPLAINTS;

    process.env.GATE_SMS_AGENT_BILLING_DISPUTES = 'true';
    prompt = buildSystemPrompt();
    expect(prompt).toMatch(/HELD FOR A PERSON: complaints, chemical\/medical concerns, legal threats\./);
    expect(prompt).toContain(
      '- BILLING DISPUTES: answer from the facts only — state the real numbers from BILLING, never resolve the dispute or offer a credit/refund/discount that is not in the facts.'
    );
    delete process.env.GATE_SMS_AGENT_BILLING_DISPUTES;

    process.env.GATE_SMS_AGENT_CHEMICAL_MEDICAL = 'true';
    prompt = buildSystemPrompt();
    expect(prompt).toMatch(/HELD FOR A PERSON: complaints, billing disputes, legal threats\./);
    expect(prompt).toContain('- CHEMICAL/MEDICAL CONCERNS: answer from the facts only.');
    delete process.env.GATE_SMS_AGENT_CHEMICAL_MEDICAL;

    process.env.GATE_SMS_AGENT_LEGAL = 'true';
    prompt = buildSystemPrompt();
    expect(prompt).toMatch(/HELD FOR A PERSON: complaints, billing disputes, chemical\/medical concerns\./);
    expect(prompt).toContain('- LEGAL THREATS: answer from the facts only.');
    delete process.env.GATE_SMS_AGENT_LEGAL;
  });

  test('a category gate never appears when off, and all four on leaves nothing HELD', () => {
    let prompt = buildSystemPrompt();
    expect(prompt).not.toContain('COMPLAINTS: answer from the facts');
    expect(prompt).not.toContain('BILLING DISPUTES: answer from the facts only');
    expect(prompt).not.toContain('CHEMICAL/MEDICAL CONCERNS: answer from the facts only.');
    expect(prompt).not.toContain('LEGAL THREATS: answer from the facts only.');

    for (const g of CATEGORY_GATES) process.env[g] = 'true';
    prompt = buildSystemPrompt();
    expect(prompt).not.toContain('HELD FOR A PERSON');
    expect(prompt).toContain('Every category that used to hold for a person now answers from the facts instead');
    // the cancellation rule is unconditional regardless of the category gates
    expect(prompt).toContain('CANCELLATIONS are never escalated as their own category');
  });

  test('buildSystemPromptWithProfile reports realAnswersApplied:true', () => {
    expect(buildSystemPromptWithProfile().realAnswersApplied).toBe(true);
    expect(buildSystemPromptWithProfile('Warm and brief.').realAnswersApplied).toBe(true);
  });

  test('does not introduce a new intended_actions type', () => {
    expect(INTENDED_ACTION_TYPES).toEqual([
      'none', 'escalate', 'book_appointment', 'send_payment_link', 'send_portal_link', 'send_estimate_link',
    ]);
  });

  test('currentPromptVersion() resolves to REAL_ANSWERS_PROMPT_VERSION while the gate is on', () => {
    expect(currentPromptVersion()).toBe(REAL_ANSWERS_PROMPT_VERSION);
  });

  test('currentPromptVersion() folds in whichever category gates are ALSO on — a different combination is a different version (pre-push audit P1 round 2)', () => {
    // Flipping a category gate changes the RENDERED prompt (it moves that
    // category off HELD-FOR-A-PERSON and swaps in its own instruction) —
    // without this, every combination would share the bare v12 identity,
    // pooling graduation evidence and sealed-eval exam-pass checks across
    // genuinely different behaviors.
    process.env.GATE_SMS_AGENT_COMPLAINTS = 'true';
    const complaintsOnly = currentPromptVersion();
    // Single-char tags (pre-push audit P1 round 3): prompt_version is
    // varchar(40) across message_drafts/agent_decisions/shadow_draft_
    // judgments/sms_pathology_entries/sms_sealed_eval_runs, and the bare
    // REAL_ANSWERS_PROMPT_VERSION is already 28 chars — a full-word tag
    // would overflow the column with just one category gate on.
    expect(complaintsOnly).toBe(`${REAL_ANSWERS_PROMPT_VERSION}+c`);
    expect(complaintsOnly.length).toBeLessThanOrEqual(40);

    process.env.GATE_SMS_AGENT_BILLING_DISPUTES = 'true';
    const complaintsAndBilling = currentPromptVersion();
    // sorted, so flip ORDER never changes the identity
    expect(complaintsAndBilling).toBe(`${REAL_ANSWERS_PROMPT_VERSION}+bc`);
    expect(complaintsAndBilling).not.toBe(complaintsOnly);
    expect(complaintsAndBilling.length).toBeLessThanOrEqual(40);

    delete process.env.GATE_SMS_AGENT_COMPLAINTS;
    const billingOnly = currentPromptVersion();
    expect(billingOnly).toBe(`${REAL_ANSWERS_PROMPT_VERSION}+b`);
    expect(billingOnly).not.toBe(complaintsOnly);
    expect(billingOnly).not.toBe(complaintsAndBilling);

    delete process.env.GATE_SMS_AGENT_BILLING_DISPUTES;
    expect(currentPromptVersion()).toBe(REAL_ANSWERS_PROMPT_VERSION); // back to the bare identity
  });

  test('the worst case (all four category gates on) still fits the varchar(40) prompt_version columns (pre-push audit P1 round 3)', () => {
    for (const g of CATEGORY_GATES) process.env[g] = 'true';
    const allFour = currentPromptVersion();
    expect(allFour).toBe(`${REAL_ANSWERS_PROMPT_VERSION}+bclm`);
    expect(allFour.length).toBe(33);
    expect(allFour.length).toBeLessThanOrEqual(40);
  });

  test('generateGroundedDraft stamps the SAME category-aware identity currentPromptVersion() would compute', async () => {
    process.env.GATE_SMS_AGENT_LEGAL = 'true';
    jest.resetModules();
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async () => ({
        ok: true, text: JSON.stringify({ reply: 'ok', intended_actions: [], missing_info: null }), model: 'fixture',
      })),
    }));
    jest.doMock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
    process.env.SHADOW_DRAFT_VERIFY = 'false';
    const drafter = require('../services/sms-shadow-drafter');
    const result = await drafter.generateGroundedDraft({
      client: {}, context: { summary: 'X', upcomingServices: [] }, inboundMessage: 'hi',
      intent: { intent: 'GENERAL' }, schedulingIntent: false, voiceProfile: null,
    });
    expect(result.promptVersion).toBe(drafter.currentPromptVersion());
    expect(result.promptVersion).toBe(`${REAL_ANSWERS_PROMPT_VERSION}+l`);
    delete process.env.SHADOW_DRAFT_VERIFY;
    jest.dontMock('../services/llm/call');
    jest.dontMock('@anthropic-ai/sdk');
    jest.resetModules();
  });
});

describe('followupSlaPhrase — the 1-business-hour SLA, computed off the ET clock', () => {
  test('8am–7:59pm ET reads "within the hour"', () => {
    expect(followupSlaPhrase(new Date('2026-09-28T14:00:00Z'))).toBe('within the hour'); // 10:00 AM ET
    expect(followupSlaPhrase(new Date('2026-09-28T12:00:00Z'))).toBe('within the hour'); // 8:00 AM ET (boundary)
    expect(followupSlaPhrase(new Date('2026-09-28T23:00:00Z'))).toBe('within the hour'); // 7:00 PM ET
  });

  test('outside 8am–8pm ET reads "by 9 AM tomorrow morning"', () => {
    expect(followupSlaPhrase(new Date('2026-09-28T11:00:00Z'))).toBe('by 9 AM tomorrow morning'); // 7:00 AM ET
    expect(followupSlaPhrase(new Date('2026-09-29T00:00:00Z'))).toBe('by 9 AM tomorrow morning'); // 8:00 PM ET (boundary)
    expect(followupSlaPhrase(new Date('2026-09-29T02:00:00Z'))).toBe('by 9 AM tomorrow morning'); // 10:00 PM ET
  });
});

describe('buildFactsBlock — OPEN TIMES section (extras.openTimesBlock)', () => {
  test('renders between UPCOMING SERVICES and BILLING when provided', () => {
    const context = { summary: 'Test customer', upcomingServices: [] };
    const block = buildFactsBlock(context, { openTimesBlock: '- Tuesday, September 29: 9:00 AM–10:00 AM' });
    expect(block).toContain(
      'OPEN TIMES (real, bookable slots, ET — offer ONLY from this list, never invent one):\n- Tuesday, September 29: 9:00 AM–10:00 AM\nBILLING:'
    );
    expect(block.indexOf('UPCOMING SERVICES')).toBeLessThan(block.indexOf('OPEN TIMES ('));
    expect(block.indexOf('OPEN TIMES (')).toBeLessThan(block.indexOf('\nBILLING:'));
  });
});

describe('buildFactsBlock — FOLLOW-UP SLA RIGHT NOW (pre-push audit P1: keeps the live value OUT of the system prompt)', () => {
  test('gate off: no such line, ever', () => {
    clearGates();
    const context = { summary: 'Test customer', upcomingServices: [] };
    expect(buildFactsBlock(context)).not.toContain('FOLLOW-UP SLA RIGHT NOW');
  });

  test('gate on: renders the live phrase as an ordinary per-draft fact, regardless of scheduling intent', () => {
    process.env[GATE] = 'true';
    const context = { summary: 'Test customer', upcomingServices: [] };
    const inHours = buildFactsBlock(context, { now: new Date('2026-09-28T14:00:00Z') }); // 10:00 AM ET
    expect(inHours).toContain('FOLLOW-UP SLA RIGHT NOW: within the hour');
    const afterHours = buildFactsBlock(context, { now: new Date('2026-09-29T02:00:00Z') }); // 10:00 PM ET
    expect(afterHours).toContain('FOLLOW-UP SLA RIGHT NOW: by 9 AM tomorrow morning');
  });

  test('sits after OPEN TIMES and before BILLING when both are present', () => {
    process.env[GATE] = 'true';
    const context = { summary: 'Test customer', upcomingServices: [] };
    const block = buildFactsBlock(context, {
      openTimesBlock: '- Tuesday, September 29: 9:00 AM - 11:00 AM',
      now: new Date('2026-09-28T14:00:00Z'),
    });
    expect(block.indexOf('OPEN TIMES (')).toBeLessThan(block.indexOf('FOLLOW-UP SLA RIGHT NOW'));
    expect(block.indexOf('FOLLOW-UP SLA RIGHT NOW')).toBeLessThan(block.indexOf('\nBILLING:'));
  });
});

describe('fetchOpenTimesBlock — read-only AvailabilityEngine call, fully fail-safe', () => {
  function freshDrafter() {
    jest.resetModules();
    return require('../services/sms-shadow-drafter');
  }

  afterEach(() => {
    jest.dontMock('../services/availability');
    jest.resetModules();
    clearGates();
  });

  test('gate off → null, AvailabilityEngine never called', async () => {
    delete process.env[GATE];
    const getAvailableSlots = jest.fn();
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.fetchOpenTimesBlock({ city: 'Venice', customerId: 'c1', schedulingIntent: true });
    expect(result).toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('gate on but no scheduling intent → null, engine never called', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn();
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.fetchOpenTimesBlock({ city: 'Venice', customerId: 'c1', schedulingIntent: false });
    expect(result).toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('gate on, scheduling intent, but no city → null, engine never called', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn();
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.fetchOpenTimesBlock({ city: null, customerId: 'c1', schedulingIntent: true });
    expect(result).toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('gate on, scheduling intent, city present → renders the 2-hour customer-facing arrival window, capped', async () => {
    // Each slot's start/end is the internal job-duration block, never the
    // customer-facing window (owner directive) — fetchOpenTimesBlock renders
    // from startTime24 through the SAME arrivalWindowRange/formatSmsTimeRange
    // helper every other surface in this file uses for UPCOMING SERVICES.
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [
        {
          date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [
            { startTime24: '09:00', endTime24: '10:00' }, { startTime24: '11:00', endTime24: '12:00' },
            { startTime24: '14:00', endTime24: '15:00' }, { startTime24: '16:00', endTime24: '17:00' },
          ],
        },
        { date: '2026-09-30', fullDate: 'Wednesday, September 30', slots: [{ startTime24: '09:00', endTime24: '10:00' }] },
        { date: '2026-10-01', fullDate: 'Thursday, October 1', slots: [] }, // no real slots -> not offered
        { date: '2026-10-02', fullDate: 'Friday, October 2', slots: [{ startTime24: '09:00', endTime24: '10:00' }] },
        { date: '2026-10-03', fullDate: 'Saturday, October 3', slots: [{ startTime24: '09:00', endTime24: '10:00' }] },
      ],
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.fetchOpenTimesBlock({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true });

    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-9' });
    const lines = result.split('\n');
    expect(lines).toHaveLength(3); // capped to 3 days that actually have openings
    // capped to 3 slots/day; each rendered as start -> start+2h, never the raw slot end
    expect(lines[0]).toBe('- Tuesday, September 29: 9:00 AM - 11:00 AM, 11:00 AM - 1:00 PM, 2:00 PM - 4:00 PM');
    expect(lines[1]).toBe('- Wednesday, September 30: 9:00 AM - 11:00 AM');
    expect(lines[2]).toBe('- Friday, October 2: 9:00 AM - 11:00 AM'); // Thursday (empty) skipped, never offered
    expect(result).not.toContain('October 3'); // past the 3-day cap
  });

  test('a slot with no parseable startTime24 is dropped; a day left with none is skipped entirely', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [
        { date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [{ startTime24: 'garbage' }] },
        { date: '2026-09-30', fullDate: 'Wednesday, September 30', slots: [{ startTime24: '09:00' }] },
      ],
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.fetchOpenTimesBlock({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true });
    expect(result).toBe('- Wednesday, September 30: 9:00 AM - 11:00 AM');
  });

  test('an empty days list (no zone match / nothing open) → null', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({ zone: null, days: [], message: 'No service zone found for Nowhere' }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.fetchOpenTimesBlock({ city: 'Nowhere', customerId: 'c1', schedulingIntent: true });
    expect(result).toBeNull();
  });

  test('AvailabilityEngine error → null, never throws, drafting stays unblocked', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => { throw new Error('zone lookup failed'); });
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    await expect(
      drafter.fetchOpenTimesBlock({ city: 'Venice', customerId: 'c1', schedulingIntent: true })
    ).resolves.toBeNull();
  });

  test('AvailabilityEngine timeout → null, never blocks drafting', async () => {
    process.env[GATE] = 'true';
    jest.useFakeTimers();
    try {
      const getAvailableSlots = jest.fn(() => new Promise(() => {})); // never resolves
      jest.doMock('../services/availability', () => ({ getAvailableSlots }));
      const drafter = freshDrafter();
      const promise = drafter.fetchOpenTimesBlock({ city: 'Venice', customerId: 'c1', schedulingIntent: true });
      await jest.advanceTimersByTimeAsync(3100);
      await expect(promise).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('generateGroundedDraft — real-answers wiring shares the facts block with the verifier/judge', () => {
  const priorVerify = process.env.SHADOW_DRAFT_VERIFY;
  const priorFewshot = process.env.SHADOW_FEWSHOT;

  beforeEach(() => {
    process.env.SHADOW_DRAFT_VERIFY = 'false'; // single-pass: no verifier call needed for this test
    process.env.SHADOW_FEWSHOT = 'false';
  });

  afterEach(() => {
    if (priorVerify === undefined) delete process.env.SHADOW_DRAFT_VERIFY;
    else process.env.SHADOW_DRAFT_VERIFY = priorVerify;
    if (priorFewshot === undefined) delete process.env.SHADOW_FEWSHOT;
    else process.env.SHADOW_FEWSHOT = priorFewshot;
    jest.dontMock('../services/availability');
    jest.dontMock('../services/llm/call');
    jest.dontMock('@anthropic-ai/sdk');
    jest.resetModules();
    clearGates();
  });

  function mockDraftDeps({ getAvailableSlots }) {
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async () => ({
        ok: true,
        text: JSON.stringify({ reply: 'Here are a couple of times.', intended_actions: [], missing_info: null }),
        model: 'fixture-model',
      })),
    }));
    jest.doMock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
  }

  test('gate off: promptVersion stays v11, no OPEN TIMES fetch, factsBlock has no OPEN TIMES section', async () => {
    delete process.env[GATE];
    const getAvailableSlots = jest.fn();
    mockDraftDeps({ getAvailableSlots });
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');

    const result = await drafter.generateGroundedDraft({
      client: {},
      context: { summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [] },
      inboundMessage: 'Can I reschedule my visit?',
      intent: { intent: 'service_scheduling_window_reply' },
      schedulingIntent: true,
      city: 'Venice',
      voiceProfile: null,
    });

    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(result.promptVersion).toBe('house_voice_v11');
    expect(result.factsBlock).not.toContain('OPEN TIMES');
  });

  test('gate on: promptVersion bumps to v12, city + context.customer.id reach AvailabilityEngine, OPEN TIMES lands in the shared facts block', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }],
    }));
    mockDraftDeps({ getAvailableSlots });
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');

    const result = await drafter.generateGroundedDraft({
      client: {},
      context: { summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [] },
      inboundMessage: 'Can I reschedule my visit?',
      intent: { intent: 'service_scheduling_window_reply' },
      schedulingIntent: true,
      city: 'Venice',
      voiceProfile: null,
    });

    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1' });
    expect(result.promptVersion).toBe('house_voice_v12_real_answers');
    expect(result.factsBlock).toContain('OPEN TIMES (real, bookable slots, ET');
    // the 2-hour customer-facing arrival window, never the raw 1-hour slot
    expect(result.factsBlock).toContain('Tuesday, September 29: 9:00 AM - 11:00 AM');
  });

  test('gate on: a cancellation message fetches OPEN TIMES even though the upstream scheduling classifier says false (pre-push audit)', async () => {
    // hasSchedulingIntent() upstream is scoped to ordinary "when are you
    // coming" messages and does NOT fire for "cancel my service" — but the
    // cancellation rule needs real skip/reschedule times regardless.
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }],
    }));
    mockDraftDeps({ getAvailableSlots });
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');

    const result = await drafter.generateGroundedDraft({
      client: {},
      context: { summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [] },
      inboundMessage: 'I want to cancel my service',
      intent: { intent: 'cancel_request' },
      schedulingIntent: false,
      city: 'Venice',
      voiceProfile: null,
    });

    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1' });
    expect(result.factsBlock).toContain('OPEN TIMES (real, bookable slots, ET');
  });

  test('gate on: a complaint-shaped message (raw text match) also fetches OPEN TIMES despite schedulingIntent:false', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }],
    }));
    mockDraftDeps({ getAvailableSlots });
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');

    const result = await drafter.generateGroundedDraft({
      client: {},
      context: { summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [] },
      inboundMessage: 'I still have ants everywhere',
      intent: { intent: 'general_customer_sms_needs_review' },
      schedulingIntent: false,
      city: 'Venice',
      voiceProfile: null,
    });

    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1' });
    expect(result.factsBlock).toContain('OPEN TIMES (real, bookable slots, ET');
  });

  test('gate on: an ordinary non-scheduling, non-cancel/complaint message never fetches OPEN TIMES', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn();
    mockDraftDeps({ getAvailableSlots });
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');

    const result = await drafter.generateGroundedDraft({
      client: {},
      context: { summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [] },
      inboundMessage: 'Thanks so much!',
      intent: { intent: 'gratitude_reply' },
      schedulingIntent: false,
      city: 'Venice',
      voiceProfile: null,
    });

    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(result.factsBlock).not.toContain('OPEN TIMES');
  });

  test('a frozen presetFactsBlock (sealed-exam replay) never triggers a live OPEN TIMES fetch', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn();
    mockDraftDeps({ getAvailableSlots });
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');

    const result = await drafter.generateGroundedDraft({
      client: {},
      context: { summary: 'frozen' },
      inboundMessage: 'hi',
      intent: { intent: 'GENERAL' },
      schedulingIntent: true,
      city: 'Venice',
      voiceProfile: null,
      factsBlock: 'FROZEN FACTS BLOCK',
    });

    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(result.factsBlock).toBe('FROZEN FACTS BLOCK');
  });
});

describe('draftShadowReply — customer.city flows to OPEN TIMES; prompt_version stamps per gate', () => {
  async function runDraft({ gateOn, schedulingIntent = true, city = 'Venice' } = {}) {
    jest.resetModules();
    process.env.SHADOW_DRAFT_VERIFY = 'false';
    process.env.SHADOW_FEWSHOT = 'false';
    if (gateOn) process.env[GATE] = 'true';
    else delete process.env[GATE];

    const insertedRows = [];
    const mockDb = jest.fn((table) => {
      if (table !== 'message_drafts') throw new Error(`unexpected table: ${table}`);
      return {
        insert: jest.fn((row) => {
          insertedRows.push(row);
          return { returning: jest.fn(async () => [{ id: 'draft-1' }]) };
        }),
      };
    });
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }],
    }));

    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    jest.doMock('../services/context-aggregator', () => ({
      getContextForCustomer: jest.fn(async () => ({
        summary: 'QA customer',
        flags: [],
        smsHistory: [],
        customer: { id: 'customer-1', billingLane: null },
        billing: { outstandingBalance: 0, recentPayments: [] },
      })),
      authorizedDuesCents: jest.fn(() => []),
    }));
    jest.doMock('../services/voice-profile-distiller', () => ({
      getApprovedVoiceProfile: jest.fn(async () => null),
    }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async () => ({
        ok: true,
        text: JSON.stringify({ reply: 'Here are some times.', intended_actions: [], missing_info: null }),
        model: 'fixture-model',
      })),
    }));
    jest.doMock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
    jest.doMock('../services/sms-auto-send', () => ({
      autoSendActionsSafe: jest.fn(() => true),
      maybeAutoSend: jest.fn(async () => ({ sent: false, reason: 'ineligible_base' })),
    }));
    jest.doMock('../services/sms-suggest-mode', () => ({
      AUTO_SEND_MODE: 'auto_send',
      SUGGESTED_STATUS: 'suggested',
      resolveDeliveryMode: jest.fn(async () => 'shadow'),
      publishSuggestion: jest.fn(async () => null),
      supersedeStaleSuggestions: jest.fn(async () => 0),
      hasRedactionPlaceholder: jest.fn(() => false),
      hasPriceQuote: jest.fn(() => false),
    }));
    jest.doMock('../services/comms-lint', () => ({
      lintComms: jest.fn(() => ({ pass: true, failures: [] })),
      toFlags: jest.fn(() => []),
    }));

    const { draftShadowReply } = require('../services/sms-shadow-drafter');
    await draftShadowReply({
      inboundMessage: 'Can I reschedule my visit?',
      fromPhone: '+19415550100',
      customer: { id: 'customer-1', city, first_name: 'Pat' },
      smsLogId: 'sms-1',
      intent: { intent: 'service_scheduling_window_reply', confidence: 0.9 },
      schedulingIntent,
    });
    return { insertedRows, getAvailableSlots };
  }

  afterEach(() => {
    process.env.SHADOW_DRAFT_VERIFY = 'false'; // reset below clears it properly
    delete process.env.SHADOW_DRAFT_VERIFY;
    delete process.env.SHADOW_FEWSHOT;
    clearGates();
    jest.dontMock('../models/db');
    jest.dontMock('../services/logger');
    jest.dontMock('../services/availability');
    jest.dontMock('../services/context-aggregator');
    jest.dontMock('../services/voice-profile-distiller');
    jest.dontMock('../services/llm/call');
    jest.dontMock('@anthropic-ai/sdk');
    jest.dontMock('../services/sms-auto-send');
    jest.dontMock('../services/sms-suggest-mode');
    jest.dontMock('../services/comms-lint');
    jest.resetModules();
  });

  test('gate off: prompt_version stays v11, AvailabilityEngine never called, no OPEN TIMES in facts_block', async () => {
    const { insertedRows, getAvailableSlots } = await runDraft({ gateOn: false });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].prompt_version).toBe('house_voice_v11');
    expect(insertedRows[0].facts_block).not.toContain('OPEN TIMES');
  });

  test('gate on: customer.city reaches AvailabilityEngine.getAvailableSlots; prompt_version bumps to v12; facts_block carries OPEN TIMES', async () => {
    const { insertedRows, getAvailableSlots } = await runDraft({ gateOn: true, city: 'Venice' });
    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'customer-1' });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].prompt_version).toBe('house_voice_v12_real_answers');
    expect(insertedRows[0].facts_block).toContain('OPEN TIMES (real, bookable slots, ET');
    expect(insertedRows[0].facts_block).toContain('Tuesday, September 29: 9:00 AM - 11:00 AM');
  });

  test('gate on but not a scheduling-intent message: OPEN TIMES omitted, AvailabilityEngine never called', async () => {
    const { insertedRows, getAvailableSlots } = await runDraft({ gateOn: true, schedulingIntent: false });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(insertedRows[0].facts_block).not.toContain('OPEN TIMES');
    expect(insertedRows[0].prompt_version).toBe('house_voice_v12_real_answers'); // the prompt rewrite still applies; only the section is withheld
  });
});
