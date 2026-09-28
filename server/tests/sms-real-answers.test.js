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
      expect(inHours).not.toMatch(/within the hour|by 9 AM (?:this|tomorrow) morning/);
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

  test('midnight through 7:59 AM ET reads "by 9 AM THIS morning" — 9 AM has not happened yet today (Codex P2)', () => {
    // The pre-fix version said "tomorrow morning" for this whole range,
    // which was wrong: at 3 AM, the next 9 AM is later TODAY, not tomorrow.
    expect(followupSlaPhrase(new Date('2026-09-28T04:00:00Z'))).toBe('by 9 AM this morning'); // 12:00 AM (midnight) ET
    expect(followupSlaPhrase(new Date('2026-09-28T06:00:00Z'))).toBe('by 9 AM this morning'); // 2:00 AM ET
    expect(followupSlaPhrase(new Date('2026-09-28T11:59:00Z'))).toBe('by 9 AM this morning'); // 7:59 AM ET (boundary)
  });

  test('8pm through 11:59 PM ET reads "by 9 AM tomorrow morning" — 9 AM today has already passed', () => {
    expect(followupSlaPhrase(new Date('2026-09-29T00:00:00Z'))).toBe('by 9 AM tomorrow morning'); // 8:00 PM ET (boundary)
    expect(followupSlaPhrase(new Date('2026-09-29T02:00:00Z'))).toBe('by 9 AM tomorrow morning'); // 10:00 PM ET
    expect(followupSlaPhrase(new Date('2026-09-29T03:59:00Z'))).toBe('by 9 AM tomorrow morning'); // 11:59 PM ET (boundary)
  });

  test('every hour boundary (00:00, 07:59, 08:00, 19:59, 20:00, 23:59 ET) resolves to the right side, in EDT (UTC-4)', () => {
    const cases = [
      ['2026-09-28T04:00:00Z', 'by 9 AM this morning'], // 00:00 ET
      ['2026-09-28T11:59:00Z', 'by 9 AM this morning'], // 07:59 ET
      ['2026-09-28T12:00:00Z', 'within the hour'], // 08:00 ET
      ['2026-09-28T23:59:00Z', 'within the hour'], // 19:59 ET
      ['2026-09-29T00:00:00Z', 'by 9 AM tomorrow morning'], // 20:00 ET
      ['2026-09-29T03:59:00Z', 'by 9 AM tomorrow morning'], // 23:59 ET
    ];
    for (const [utc, expected] of cases) expect(followupSlaPhrase(new Date(utc))).toBe(expected);
  });

  test('the same six boundaries hold in EST (UTC-5, DST-safe ET math)', () => {
    // Same wall-clock ET hours, a date where America/New_York is on
    // standard time (mid-January, well clear of either DST transition) —
    // proves etParts() converts the UTC offset correctly on both sides of
    // the clock change, not just during EDT.
    const cases = [
      ['2026-01-15T05:00:00Z', 'by 9 AM this morning'], // 00:00 ET
      ['2026-01-15T12:59:00Z', 'by 9 AM this morning'], // 07:59 ET
      ['2026-01-15T13:00:00Z', 'within the hour'], // 08:00 ET
      ['2026-01-16T00:59:00Z', 'within the hour'], // 19:59 ET
      ['2026-01-16T01:00:00Z', 'by 9 AM tomorrow morning'], // 20:00 ET
      ['2026-01-16T04:59:00Z', 'by 9 AM tomorrow morning'], // 23:59 ET
    ];
    for (const [utc, expected] of cases) expect(followupSlaPhrase(new Date(utc))).toBe(expected);
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
    // pre-8am (Codex P2): 9 AM hasn't happened yet TODAY, never "tomorrow"
    const preOpening = buildFactsBlock(context, { now: new Date('2026-09-28T06:00:00Z') }); // 2:00 AM ET
    expect(preOpening).toContain('FOLLOW-UP SLA RIGHT NOW: by 9 AM this morning');
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

  test('threads estimateId through to getAvailableSlots so the offered slots use THAT estimate\'s service minutes (pre-push audit P2)', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }],
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    await drafter.fetchOpenTimesBlock({
      city: 'Venice', customerId: 'cust-9', schedulingIntent: true, estimateId: 'estimate-42',
    });
    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', 'estimate-42', { customerId: 'cust-9' });
  });

  test('estimateId defaults to null (the existing no-estimate contract) when omitted', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }],
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    await drafter.fetchOpenTimesBlock({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true });
    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-9' });
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

describe('validateOfferedTimes — deterministic draft-time check of the model\'s OWN offered_times declaration (structural fix, replacing prose date-parsing)', () => {
  const { validateOfferedTimes } = require('../services/sms-shadow-drafter');
  // The SAME window text on two different days — exactly the shape that
  // broke three rounds of prose-parsing heuristics (pooling across dates,
  // then over-correcting, then a weekday-text cross-product). With the
  // model declaring offered_times directly, no parsing of `reply` text is
  // needed at all to bind a date to a window.
  const openTimesDays = [
    { date: 'Tuesday, September 29', windows: ['9:00 AM - 11:00 AM', '11:00 AM - 1:00 PM'] },
    { date: 'Wednesday, September 30', windows: ['9:00 AM - 11:00 AM'] },
  ];

  test('a single correctly-declared time → ok:true, no violations', () => {
    const result = validateOfferedTimes({
      offeredTimes: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      openTimesDays,
      reply: 'How about Tuesday 9:00 AM - 11:00 AM?',
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test('no OPEN TIMES, no offered_times, no reply-quoted times → ok:true (a draft that never touches OPEN TIMES is untouched)', () => {
    expect(validateOfferedTimes({ offeredTimes: [], openTimesDays: [], reply: "I'll confirm and follow up." })).toEqual({ ok: true, violations: [] });
  });

  // The exact multi-option case the coordinator specified: two different
  // days, two different windows, both correctly declared. An UNRELATED
  // day's slot (Wednesday 9-11, not offered here) being booked must not
  // affect this — validateOfferedTimes only ever looks at what's actually
  // in openTimesDays right now, which already reflects the current state.
  test('a multi-option reply ("Tuesday 9-11 or Wednesday 2-4") with BOTH correctly declared → ok:true', () => {
    const days = [
      { date: 'Tuesday, September 29', windows: ['9:00 AM - 11:00 AM'] },
      { date: 'Wednesday, September 30', windows: ['2:00 PM - 4:00 PM'] },
    ];
    const result = validateOfferedTimes({
      offeredTimes: [
        { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' },
        { date: 'Wednesday, September 30', window: '2:00 PM - 4:00 PM' },
      ],
      openTimesDays: days,
      reply: 'How about Tuesday 9:00 AM - 11:00 AM or Wednesday 2:00 PM - 4:00 PM?',
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  // If Tuesday's OWN declared slot is the one that's gone (not in
  // openTimesDays any more), that specific entry must fail — this is what
  // "Tuesday being booked must [block]" means at the deterministic-check
  // layer: openTimesDays is the FRESH read, so a gone Tuesday slot is
  // simply absent from it.
  test('a multi-option reply where the DECLARED Tuesday slot is no longer in OPEN TIMES → blocked, only Tuesday flagged', () => {
    const days = [
      { date: 'Wednesday, September 30', windows: ['2:00 PM - 4:00 PM'] }, // Tuesday's own slot is gone
    ];
    const result = validateOfferedTimes({
      offeredTimes: [
        { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' },
        { date: 'Wednesday, September 30', window: '2:00 PM - 4:00 PM' },
      ],
      openTimesDays: days,
      reply: 'How about Tuesday 9:00 AM - 11:00 AM or Wednesday 2:00 PM - 4:00 PM?',
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'offered_times claims "Tuesday, September 29: 9:00 AM - 11:00 AM" but that is not an OPEN TIMES slot',
    ]);
  });

  test('an offered_times entry naming a (date, window) pair NOT in OPEN TIMES → blocked', () => {
    const result = validateOfferedTimes({
      offeredTimes: [{ date: 'Tuesday, September 29', window: '3:00 PM - 5:00 PM' }], // never offered
      openTimesDays,
      reply: 'How about Tuesday 3:00 PM - 5:00 PM?',
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'offered_times claims "Tuesday, September 29: 3:00 PM - 5:00 PM" but that is not an OPEN TIMES slot',
    ]);
  });

  test('a window quoted in the reply but MISSING from offered_times → blocked (the reverse check)', () => {
    const result = validateOfferedTimes({
      offeredTimes: [],
      openTimesDays: [{ date: 'Tuesday, September 29', windows: ['9:00 AM - 11:00 AM'] }], // offered on ONE day only
      reply: 'How about Tuesday 9:00 AM - 11:00 AM?',
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'the reply quotes "9:00 AM - 11:00 AM" from OPEN TIMES (offered on Tuesday, September 29) but it is not listed in offered_times',
    ]);
  });

  test('an offered_times entry whose window text does not actually appear in the reply → blocked', () => {
    const result = validateOfferedTimes({
      offeredTimes: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      openTimesDays,
      reply: "I'll confirm a time and get back to you.", // never quoted the declared window
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'offered_times lists "Tuesday, September 29: 9:00 AM - 11:00 AM" but the reply never quotes that time',
    ]);
  });

  test('a malformed entry (missing date or window) → blocked, does not throw', () => {
    const result = validateOfferedTimes({
      offeredTimes: [{ date: 'Tuesday, September 29' }, { window: '9:00 AM - 11:00 AM' }, {}],
      openTimesDays,
      reply: 'Hello',
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(3);
  });

  test('offered_times is not an array (malformed model output) → treated as empty, reverse check still runs', () => {
    const result = validateOfferedTimes({ offeredTimes: 'not an array', openTimesDays, reply: 'plain reply' });
    expect(result).toEqual({ ok: true, violations: [] });
  });
});

describe('computeOpenTimesSnapshot — the minimum needed to recheck at send time (persists the VALIDATED offered_times declaration)', () => {
  const { computeOpenTimesSnapshot } = require('../services/sms-shadow-drafter');
  const block = '- Tuesday, September 29: 9:00 AM - 11:00 AM';

  test('no OPEN TIMES block fetched → null (nothing to recheck)', () => {
    expect(computeOpenTimesSnapshot({
      openTimesBlock: null, offeredTimes: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }], city: 'Venice',
    })).toBeNull();
  });

  test('OPEN TIMES fetched but the draft declared no offered_times → null', () => {
    expect(computeOpenTimesSnapshot({ openTimesBlock: block, offeredTimes: [], city: 'Venice' })).toBeNull();
    expect(computeOpenTimesSnapshot({ openTimesBlock: block, offeredTimes: undefined, city: 'Venice' })).toBeNull();
  });

  test('OPEN TIMES fetched and offered_times declared → the declared (date, window) pairs plus the exact lookup inputs', () => {
    expect(computeOpenTimesSnapshot({
      openTimesBlock: block,
      offeredTimes: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      city: 'Venice', customerId: 'cust-9', estimateId: 'estimate-42',
    })).toEqual({
      lookup: { city: 'Venice', customerId: 'cust-9', estimateId: 'estimate-42' },
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
  });

  test('omitted customerId/estimateId default to null, not undefined (JSON-stable)', () => {
    expect(computeOpenTimesSnapshot({
      openTimesBlock: block, offeredTimes: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }], city: 'Venice',
    })).toEqual({
      lookup: { city: 'Venice', customerId: null, estimateId: null },
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
  });

  test('a malformed offered_times entry (missing date or window) is dropped, not persisted', () => {
    expect(computeOpenTimesSnapshot({
      openTimesBlock: block,
      offeredTimes: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }, { date: 'Wednesday, September 30' }],
      city: 'Venice',
    })).toEqual({
      lookup: { city: 'Venice', customerId: null, estimateId: null },
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
  });
});

describe('openTimesStillOffered — send-time recheck, fails CLOSED on a gone slot, a fetch error, or a timeout', () => {
  function freshDrafter() {
    jest.resetModules();
    return require('../services/sms-shadow-drafter');
  }

  afterEach(() => {
    jest.dontMock('../services/availability');
    jest.resetModules();
  });

  test('no quoted windows → ok:true, the availability engine is never called', async () => {
    const getAvailableSlots = jest.fn();
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({ city: 'Venice', quotedWindows: [] })).resolves.toEqual({ ok: true });
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('quoted windows but no city → fails closed without calling the engine', async () => {
    const getAvailableSlots = jest.fn();
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({
      city: null, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    })).resolves.toEqual({ ok: false, reason: 'open_times_recheck_no_city' });
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('a quoted slot that is STILL open on the SAME date → ok:true (sends)', async () => {
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }, { startTime24: '14:00' }] }],
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', estimateId: 'estimate-42',
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
    expect(result).toEqual({ ok: true });
    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', 'estimate-42', { customerId: 'cust-9' });
  });

  test('a quoted slot that is GONE on its own date → ok:false, blocked, names the gone (date, window) pair', async () => {
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ fullDate: 'Tuesday, September 29', slots: [{ startTime24: '14:00' }] }], // 9-11 no longer offered Tuesday
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
    expect(result).toEqual({
      ok: false, reason: 'open_times_no_longer_offered',
      goneWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
  });

  // Pre-push local-audit P1 regression: the SAME window TEXT is still open
  // on Wednesday, but the quoted pair names Tuesday specifically — the
  // recheck must not let Wednesday's availability vouch for Tuesday's slot.
  test('the same window TEXT still open on a DIFFERENT date does not vouch for the quoted date — still blocked', async () => {
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [
        { fullDate: 'Tuesday, September 29', slots: [{ startTime24: '14:00' }] }, // 9-11 gone on Tuesday
        { fullDate: 'Wednesday, September 30', slots: [{ startTime24: '09:00' }] }, // 9-11 still open Wednesday
      ],
    }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
    expect(result).toEqual({
      ok: false, reason: 'open_times_no_longer_offered',
      goneWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
  });

  test('a fetch error → ok:false, fails closed (never assumes a quoted time is still fine)', async () => {
    const getAvailableSlots = jest.fn(async () => { throw new Error('zone lookup failed'); });
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
    expect(result).toEqual({ ok: false, reason: 'open_times_recheck_failed' });
  });

  test('a timeout → ok:false, fails closed, never hangs the send path', async () => {
    jest.useFakeTimers();
    try {
      const getAvailableSlots = jest.fn(() => new Promise(() => {})); // never resolves
      jest.doMock('../services/availability', () => ({ getAvailableSlots }));
      const drafter = freshDrafter();
      const promise = drafter.openTimesStillOffered({
        city: 'Venice', quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      });
      await jest.advanceTimersByTimeAsync(3100);
      await expect(promise).resolves.toEqual({ ok: false, reason: 'open_times_recheck_failed' });
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

  test('gate on: forwards estimateId through to fetchOpenTimesBlock/getAvailableSlots (pre-push audit P2)', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn(async () => ({
      zone: 'Venice Zone',
      days: [{ date: '2026-09-29', fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }],
    }));
    mockDraftDeps({ getAvailableSlots });
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');

    await drafter.generateGroundedDraft({
      client: {},
      context: { summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [] },
      inboundMessage: 'Can I reschedule my visit?',
      intent: { intent: 'service_scheduling_window_reply' },
      schedulingIntent: true,
      city: 'Venice',
      voiceProfile: null,
      estimateId: 'estimate-42',
    });

    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', 'estimate-42', { customerId: 'cust-1' });
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

describe('validateOfferedTimes — the reverse check binds PER OCCURRENCE (pre-push audit P1: a window offered on two days needs one entry per day)', () => {
  const { validateOfferedTimes, countQuotedWindow } = require('../services/sms-shadow-drafter');
  const days = [
    { date: 'Tuesday, September 29', windows: ['9:00 AM - 11:00 AM'] },
    { date: 'Wednesday, September 30', windows: ['9:00 AM - 11:00 AM'] },
  ];
  const reply = 'How about Tuesday 9:00 AM - 11:00 AM or Wednesday 9:00 AM - 11:00 AM?';

  test('same window on two days, quoted twice, BOTH declared → ok', () => {
    expect(validateOfferedTimes({
      offeredTimes: [
        { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' },
        { date: 'Wednesday, September 30', window: '9:00 AM - 11:00 AM' },
      ],
      openTimesDays: days, reply,
    })).toEqual({ ok: true, violations: [] });
  });

  test('same window on two days, quoted twice, only Tuesday declared → blocked (Wednesday would otherwise never be persisted or rechecked)', () => {
    const result = validateOfferedTimes({
      offeredTimes: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
      openTimesDays: days, reply,
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'the reply quotes "9:00 AM - 11:00 AM" 2 time(s) but only 1 offered_times entry plus 0 already-scheduled mentions account for it — write the time out once per offered day, with one {date, window} entry each',
    ]);
  });

  test('the same (date, window) declared twice but quoted once → blocked, not silently deduplicated', () => {
    const result = validateOfferedTimes({
      offeredTimes: [
        { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' },
        { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' },
      ],
      openTimesDays: days,
      reply: 'How about Tuesday 9:00 AM - 11:00 AM?',
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/quotes "9:00 AM - 11:00 AM" 1 time\(s\) but offered_times declares it 2 time\(s\)/);
  });

  test('countQuotedWindow: digit boundaries — a window is never counted inside a longer time string', () => {
    expect(countQuotedWindow('We have 1:00 PM - 3:00 PM and 1:00 PM - 3:00 PM again.', '1:00 PM - 3:00 PM')).toBe(2);
    expect(countQuotedWindow('We have 11:00 PM - 3:00 PM.', '1:00 PM - 3:00 PM')).toBe(0);
    expect(countQuotedWindow('', '1:00 PM - 3:00 PM')).toBe(0);
    expect(countQuotedWindow('anything', '')).toBe(0);
  });
});

describe('parseOpenTimesDaysFromFactsBlock — recovers the FROZEN OPEN TIMES a sealed-exam replay actually saw (pre-push audit P1)', () => {
  const { parseOpenTimesDaysFromFactsBlock, buildFactsBlock } = require('../services/sms-shadow-drafter');
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
  });

  test('round-trips buildFactsBlock\'s own rendering: every day and window comes back structured', () => {
    const openTimesBlock = '- Tuesday, September 29: 9:00 AM - 11:00 AM, 11:00 AM - 1:00 PM\n- Wednesday, September 30: 2:00 PM - 4:00 PM';
    const frozen = buildFactsBlock({ summary: 'Dana — Quarterly Pest, Venice', upcomingServices: [] }, { openTimesBlock });
    expect(parseOpenTimesDaysFromFactsBlock(frozen)).toEqual([
      { date: 'Tuesday, September 29', windows: ['9:00 AM - 11:00 AM', '11:00 AM - 1:00 PM'] },
      { date: 'Wednesday, September 30', windows: ['2:00 PM - 4:00 PM'] },
    ]);
  });

  test('a facts block with no OPEN TIMES section → [] (nothing to validate against, same as a live draft with no fetch)', () => {
    const frozen = buildFactsBlock({ summary: 'Dana — Quarterly Pest, Venice', upcomingServices: [] });
    expect(parseOpenTimesDaysFromFactsBlock(frozen)).toEqual([]);
    expect(parseOpenTimesDaysFromFactsBlock(null)).toEqual([]);
    expect(parseOpenTimesDaysFromFactsBlock('')).toEqual([]);
  });

  test('stops at the end of the section — a later "- " line from another section is not read as a day', () => {
    const block = 'OPEN TIMES (real, bookable slots, ET — offer ONLY from this list, never invent one):\n- Tuesday, September 29: 9:00 AM - 11:00 AM\nBILLING:\n- balance: $0\n';
    expect(parseOpenTimesDaysFromFactsBlock(block)).toEqual([
      { date: 'Tuesday, September 29', windows: ['9:00 AM - 11:00 AM'] },
    ]);
  });
});

describe('validateOfferedTimes — a window grounded ELSEWHERE in the facts (an existing visit\'s arrival window) is not an undeclared offer (pre-push audit P1, round 2)', () => {
  const { validateOfferedTimes, stripOpenTimesSection, buildFactsBlock } = require('../services/sms-shadow-drafter');
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
  });
  // Tuesday 9-11 is BOOKED (UPCOMING SERVICES); Wednesday 9-11 happens to be OPEN.
  const context = {
    summary: 'Dana — Quarterly Pest, Venice',
    upcomingServices: [{ type: 'Quarterly Pest', date: '2026-09-29', window: '9:00 AM - 11:00 AM', tech: 'Sam' }],
  };
  const openTimesBlock = '- Wednesday, September 30: 9:00 AM - 11:00 AM';
  const openTimesDays = [{ date: 'Wednesday, September 30', windows: ['9:00 AM - 11:00 AM'] }];
  const factsBlock = buildFactsBlock(context, { openTimesBlock });

  test('stripOpenTimesSection removes exactly the OPEN TIMES lines and keeps the scheduled visit\'s window', () => {
    const stripped = stripOpenTimesSection(factsBlock);
    expect(stripped).not.toContain('OPEN TIMES (real');
    expect(stripped).not.toContain('Wednesday, September 30');
    expect(stripped).toContain('window 9:00 AM - 11:00 AM');
    expect(stripOpenTimesSection('no section here')).toBe('no section here');
    expect(stripOpenTimesSection(null)).toBe('');
  });

  test('CONFIRMING the booked Tuesday 9-11 with offered_times [] → ok (not an offer, nothing to declare)', () => {
    expect(validateOfferedTimes({
      offeredTimes: [], openTimesDays, factsBlock,
      reply: 'You are all set for Tuesday 9:00 AM - 11:00 AM with Sam.',
    })).toEqual({ ok: true, violations: [] });
  });

  test('declaring the booked Tuesday as an offer is still rejected — it is not an OPEN TIMES slot', () => {
    const result = validateOfferedTimes({
      offeredTimes: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }], openTimesDays, factsBlock,
      reply: 'You are all set for Tuesday 9:00 AM - 11:00 AM with Sam.',
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(['offered_times claims "Tuesday, September 29: 9:00 AM - 11:00 AM" but that is not an OPEN TIMES slot']);
  });

  test('confirming Tuesday AND offering the open Wednesday 9-11 → the Wednesday offer must still be declared', () => {
    const reply = 'You are set for Tuesday 9:00 AM - 11:00 AM; if you would rather, Wednesday 9:00 AM - 11:00 AM is open too.';
    const undeclared = validateOfferedTimes({ offeredTimes: [], openTimesDays, factsBlock, reply });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.violations).toHaveLength(1);
    expect(undeclared.violations[0]).toMatch(/quotes "9:00 AM - 11:00 AM" 2 time\(s\) but only 0 offered_times entries plus 1 already-scheduled mention account for it/);
    expect(validateOfferedTimes({
      offeredTimes: [{ date: 'Wednesday, September 30', window: '9:00 AM - 11:00 AM' }], openTimesDays, factsBlock, reply,
    })).toEqual({ ok: true, violations: [] });
  });

  test('without a facts block (unit callers) the strict per-occurrence rule still applies', () => {
    const result = validateOfferedTimes({
      offeredTimes: [], openTimesDays,
      reply: 'You are all set for Tuesday 9:00 AM - 11:00 AM with Sam.',
    });
    expect(result.ok).toBe(false);
  });
});

describe('planOpenTimesRecheck — what a send path rechecks given the body that will actually go out (Codex r2 P2: edited offers fail closed)', () => {
  const { planOpenTimesRecheck } = require('../services/sms-shadow-drafter');
  const snapshot = {
    lookup: { city: 'Venice', customerId: 'cust-A', estimateId: null },
    quotedWindows: [
      { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' },
      { date: 'Wednesday, September 30', window: '2:00 PM - 4:00 PM' },
    ],
  };
  const original = 'How about Tuesday 9:00 AM - 11:00 AM or Wednesday 2:00 PM - 4:00 PM?';

  test('no snapshot pairs → skip', () => {
    expect(planOpenTimesRecheck({ snapshot: null, outgoingBody: 'x', originalBody: 'x' })).toEqual({ action: 'skip' });
    expect(planOpenTimesRecheck({ snapshot: { quotedWindows: [] }, outgoingBody: 'x' })).toEqual({ action: 'skip' });
  });

  test('UNEDITED body → recheck every pair still quoted; spacing edits AROUND the offers still keep both spans verbatim', () => {
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: original, originalBody: original })).toEqual({ action: 'recheck', quotedWindows: snapshot.quotedWindows });
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: `  ${original.replace(' or ', '  or  ')} `, originalBody: original })).toEqual({ action: 'recheck', quotedWindows: snapshot.quotedWindows });
  });

  test('edited: extra spaces INSIDE a time range break its exact text → refuse, never skip', () => {
    const body = 'How about Tuesday 9:00 AM  -  11:00 AM or Wednesday 2:00 PM - 4:00 PM?';
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
  });

  test('edited: an abbreviated rewrite ("Tue 9–11 AM") is a rewrite, not a deletion → refuse', () => {
    const body = 'How about Tue 9–11 AM or Wednesday 2:00 PM - 4:00 PM?';
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: 'Does 9-11 tomorrow work?', originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
  });

  test('looksLikeOfferText: broad on purpose', () => {
    const { looksLikeOfferText } = require('../services/sms-shadow-drafter');
    for (const t of ['Tue 9–11 AM', 'thurs', '2pm', '9 - 11', 'tomorrow morning', 'Sat.', '10:30 a.m.']) expect(looksLikeOfferText(t)).toBe(true);
    for (const t of ["I'll confirm a time and get right back to you.", 'Your balance is $99.', 'Thanks!', '']) expect(looksLikeOfferText(t)).toBe(false);
  });

  test('no original body known (fire-time path) → the exact-text filter, as before', () => {
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: 'Wednesday 2:00 PM - 4:00 PM works.' })).toEqual({
      action: 'recheck', quotedWindows: [snapshot.quotedWindows[1]],
    });
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: 'I will confirm and follow up.' })).toEqual({ action: 'skip' });
  });

  test('edited: typo fixed elsewhere, both offers kept intact → recheck both', () => {
    const body = 'How about Tuesday 9:00 AM - 11:00 AM or Wednesday 2:00 PM - 4:00 PM? Thanks!';
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'recheck', quotedWindows: snapshot.quotedWindows });
  });

  test('edited: one offer dropped outright (day and window both gone) → recheck only the kept one', () => {
    const body = 'How about Tuesday 9:00 AM - 11:00 AM?';
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'recheck', quotedWindows: [snapshot.quotedWindows[0]] });
  });

  test('edited: every offer dropped → skip', () => {
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: 'I will confirm a time and get right back to you.', originalBody: original })).toEqual({ action: 'skip' });
  });

  test('edited: a REFORMATTED time ("9–11 AM") keeps the day but loses the window text → refuse', () => {
    const body = 'How about Tuesday 9–11 AM or Wednesday 2:00 PM - 4:00 PM?';
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
  });

  test('edited: the DAY changed while the time text stayed → refuse (never rechecks the old day)', () => {
    const body = 'How about Thursday 9:00 AM - 11:00 AM or Wednesday 2:00 PM - 4:00 PM?';
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_unknown_day' });
  });

  test('edited: a day the snapshot knows, swapped onto the other window → refuse', () => {
    const body = 'How about Wednesday 9:00 AM - 11:00 AM?'; // Tuesday dropped, Wednesday kept its day but not its window
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
  });

  test('edited: the two offers SWAPPED (every day and window still present, bindings broken) → refuse', () => {
    const body = 'How about Tuesday 2:00 PM - 4:00 PM or Wednesday 9:00 AM - 11:00 AM?';
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
  });

  test('edited: the same window on two days, one day\'s offer dropped, the other kept verbatim → recheck only the kept pair', () => {
    const snap = { lookup: {}, quotedWindows: [
      { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' },
      { date: 'Wednesday, September 30', window: '9:00 AM - 11:00 AM' },
    ] };
    const orig = 'How about Tuesday 9:00 AM - 11:00 AM or Wednesday 9:00 AM - 11:00 AM?';
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about Wednesday 9:00 AM - 11:00 AM? Thanks!', originalBody: orig })).toEqual({
      action: 'recheck', quotedWindows: [snap.quotedWindows[1]],
    });
  });

  test('edited: a full time range the snapshot never offered → refuse', () => {
    const body = 'How about Tuesday 9:00 AM - 11:00 AM or Wednesday 4:00 PM - 6:00 PM?';
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_unknown_window' });
  });

  test('edited: when the drafted reply never named the day, the window alone decides keep vs drop', () => {
    const snap = { lookup: {}, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] };
    const orig = 'How about 9:00 AM - 11:00 AM?';
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about 9:00 AM - 11:00 AM? Thanks!', originalBody: orig })).toEqual({ action: 'recheck', quotedWindows: snap.quotedWindows });
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'I will confirm and follow up.', originalBody: orig })).toEqual({ action: 'skip' });
  });
});
