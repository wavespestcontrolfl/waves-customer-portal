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
// The service identity lane's answer for a text that names no job: the
// visit ladder decides, as it did before the model picked the job.
const IDENTITY_NONE = { ok: true, json: { about: 'none', visit: null, service: null } };
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
    expect(REAL_ANSWERS_PROMPT_VERSION).toBe('house_voice_v12_real_answers2');
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
    // Codex r6 P1: the offer is gated on the FREE RE-SERVICE eligibility fact
    expect(prompt).toContain('- COMPLAINTS: answer from the facts and acknowledge what happened. Offer a free re-service ONLY when FREE RE-SERVICE in the facts says eligible');
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
    expect(allFour.length).toBe(34);
    expect(allFour.length).toBeLessThanOrEqual(40);
  });

  test('generateGroundedDraft stamps the SAME category-aware identity currentPromptVersion() would compute', async () => {
    process.env.GATE_SMS_AGENT_LEGAL = 'true';
    jest.resetModules();
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async (policy, payload) => (payload?.laneId === 'sms_service_identity' ? IDENTITY_NONE : {
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
    jest.dontMock('../services/llm/call'); jest.dontMock('../services/call-booking-catalog');
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
    jest.dontMock('../services/llm/call'); jest.dontMock('../services/call-booking-catalog');
    jest.dontMock('@anthropic-ai/sdk');
    jest.resetModules();
    clearGates();
  });

  function mockDraftDeps({ getAvailableSlots }) {
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async (policy, payload) => (payload?.laneId === 'sms_service_identity' ? IDENTITY_NONE : {
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
    expect(result.promptVersion).toBe('house_voice_v12_real_answers2');
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

  // Codex round-3 P2: "they're back" (the PEST REPORTS bullet's own example)
  // names no pest noun, so it dodges PEST_REPORT_TEXT_RE — it must still
  // fetch OPEN TIMES when the customer's own context shows a pest
  // relationship, so the "not eligible" branch has real times to offer.
  test('gate on: a bare pronoun return ("they\'re back") with a completed pest-family visit on file fetches OPEN TIMES', async () => {
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
      context: {
        summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [],
        serviceHistory: [{ type: 'General Pest Control' }],
      },
      inboundMessage: "they're back",
      intent: { intent: 'general_customer_sms_needs_review' },
      schedulingIntent: false,
      city: 'Venice',
      voiceProfile: null,
    });

    // serviceType is resolved from the SAME serviceHistory entry by the
    // existing service-identity ladder (unnamedServiceIdentity's
    // "last_completed" branch) — unrelated to this fix, but real, so the
    // assertion reflects it.
    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1', serviceType: 'General Pest Control' });
    expect(result.factsBlock).toContain('OPEN TIMES (real, bookable slots, ET');
  });

  test('gate on: a bare pronoun return ("they\'re back") with NO pest relationship on file does not fetch OPEN TIMES', async () => {
    process.env[GATE] = 'true';
    const getAvailableSlots = jest.fn();
    mockDraftDeps({ getAvailableSlots });
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');

    const result = await drafter.generateGroundedDraft({
      client: {},
      context: { summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [], serviceHistory: [] },
      inboundMessage: "they're back",
      intent: { intent: 'general_customer_sms_needs_review' },
      schedulingIntent: false,
      city: 'Venice',
      voiceProfile: null,
    });

    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(result.factsBlock).not.toContain('OPEN TIMES');
  });

  test('gate on: a bare pronoun return with a recurring plan tier (no serviceHistory) still fetches OPEN TIMES', async () => {
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
      context: { summary: 'Test customer', customer: { id: 'cust-1', tier: 'Gold' }, upcomingServices: [] },
      inboundMessage: 'still there',
      intent: { intent: 'general_customer_sms_needs_review' },
      schedulingIntent: false,
      city: 'Venice',
      voiceProfile: null,
    });

    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1' });
    expect(result.factsBlock).toContain('OPEN TIMES (real, bookable slots, ET');
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
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async (policy, payload) => (payload?.laneId === 'sms_service_identity' ? IDENTITY_NONE : {
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
    jest.dontMock('../services/llm/call'); jest.dontMock('../services/call-booking-catalog');
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
    expect(insertedRows[0].prompt_version).toBe('house_voice_v12_real_answers2');
    expect(insertedRows[0].facts_block).toContain('OPEN TIMES (real, bookable slots, ET');
    expect(insertedRows[0].facts_block).toContain('Tuesday, September 29: 9:00 AM - 11:00 AM');
  });

  test('gate on but not a scheduling-intent message: OPEN TIMES omitted, AvailabilityEngine never called', async () => {
    const { insertedRows, getAvailableSlots } = await runDraft({ gateOn: true, schedulingIntent: false });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(insertedRows[0].facts_block).not.toContain('OPEN TIMES');
    expect(insertedRows[0].prompt_version).toBe('house_voice_v12_real_answers2'); // the prompt rewrite still applies; only the section is withheld
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

  test('edited: a NEW offer appended beside intact offers ("Or tomorrow 2pm?") → refuse', () => {
    const body = `${original} Or tomorrow 2pm?`;
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
    const snap = { lookup: {}, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] };
    const orig = 'How about Tuesday 9:00 AM - 11:00 AM?';
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM? Or Friday 2 - 4?', originalBody: orig })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM? Or this afternoon?', originalBody: orig })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
  });

  test('edited: day/time words the drafted reply ALREADY had outside its offers are not "added" — a typo fix elsewhere still rechecks', () => {
    const snap = { lookup: {}, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] };
    const orig = 'Your visit is Friday morning. To move it, how about Tuesday 9:00 AM - 11:00 AM?';
    const body = 'Your visit is Friday morning. To move it, how about Tuesday 9:00 AM - 11:00 AM? Thanks!';
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: body, originalBody: orig })).toEqual({ action: 'recheck', quotedWindows: snap.quotedWindows });
    // ...but mentioning Friday TWICE when the draft had it once is new text → refuse
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: `${orig} Friday works too.`, originalBody: orig })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
  });

  test('edited: a CALENDAR-DATE change with the same time ("September 29" → "October 6"), no weekday in the drafted reply → refuse', () => {
    const snap = { lookup: {}, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] };
    const orig = 'How about September 29 from 9:00 AM - 11:00 AM?';
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about October 6 from 9:00 AM - 11:00 AM?', originalBody: orig })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about 10/6 from 9:00 AM - 11:00 AM?', originalBody: orig })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
    // the date-anchored span kept verbatim → recheck as usual
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about September 29 from 9:00 AM - 11:00 AM? Thanks!', originalBody: orig })).toEqual({ action: 'recheck', quotedWindows: snap.quotedWindows });
  });

  test('edited: a date-changing modifier added INSIDE a kept offer\'s sentence ("next week") → refuse; trimming an option from that sentence still passes', () => {
    const snap = { lookup: {}, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] };
    const orig = 'How about Tuesday 9:00 AM - 11:00 AM?';
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM next week?', originalBody: orig })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about the following Tuesday 9:00 AM - 11:00 AM?', originalBody: orig })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM? That is next week.', originalBody: orig })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
    // trimming one of two options out of the shared sentence only REMOVES words
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?', originalBody: original })).toEqual({ action: 'recheck', quotedWindows: [snapshot.quotedWindows[0]] });
  });

  test('looksLikeOfferText: broad on purpose', () => {
    const { looksLikeOfferText } = require('../services/sms-shadow-drafter');
    for (const t of ['Tue 9–11 AM', 'thurs', '2pm', '9 - 11', 'tomorrow morning', 'Sat.', '10:30 a.m.', 'October 6', 'Sept. 29th', '10/6', '10/06/2026']) expect(looksLikeOfferText(t)).toBe(true);
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
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
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
    expect(planOpenTimesRecheck({ snapshot, outgoingBody: body, originalBody: original })).toEqual({ action: 'refuse', reason: 'edited_offer_text' });
  });

  test('edited: when the drafted reply never named the day, the window alone decides keep vs drop', () => {
    const snap = { lookup: {}, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] };
    const orig = 'How about 9:00 AM - 11:00 AM?';
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'How about 9:00 AM - 11:00 AM? Thanks!', originalBody: orig })).toEqual({ action: 'recheck', quotedWindows: snap.quotedWindows });
    expect(planOpenTimesRecheck({ snapshot: snap, outgoingBody: 'I will confirm and follow up.', originalBody: orig })).toEqual({ action: 'skip' });
  });
});

describe('follow-up SLA helpers (Codex r3): a promised follow-up is detectable, and its phrase can go stale', () => {
  const { SLA_PHRASES, replyPromisesFollowup, slaPhraseStatus, followupSlaPhrase } = require('../services/sms-shadow-drafter');
  const direct = require('../services/sms-followup-sla');
  // EDT (UTC-4) instants: 10:00 ET, 21:00 ET, 06:00 ET
  const DAY = new Date('2026-09-29T14:00:00Z');
  const NIGHT = new Date('2026-09-30T01:00:00Z');
  const DAWN = new Date('2026-09-29T10:00:00Z');

  test('the module and the drafter export the same helpers, and SLA_PHRASES is exactly what followupSlaPhrase can emit', () => {
    expect(direct.replyPromisesFollowup).toBe(replyPromisesFollowup);
    expect(direct.slaPhraseStatus).toBe(slaPhraseStatus);
    expect(new Set(SLA_PHRASES)).toEqual(new Set([followupSlaPhrase(DAY), followupSlaPhrase(NIGHT), followupSlaPhrase(DAWN)]));
  });

  test('replyPromisesFollowup: any SLA phrase, case-insensitive; nothing else', () => {
    expect(replyPromisesFollowup("I'll check with the office and get back to you within the hour.")).toBe(true);
    expect(replyPromisesFollowup('Someone will confirm BY 9 AM TOMORROW MORNING.')).toBe(true);
    expect(replyPromisesFollowup("I'll confirm and get right back to you.")).toBe(false);
    expect(replyPromisesFollowup('')).toBe(false);
    expect(replyPromisesFollowup(null)).toBe(false);
  });

  test('slaPhraseStatus: none / current / stale against the ET window at send time', () => {
    const body = "I'll check and get back to you within the hour.";
    expect(slaPhraseStatus('Thanks, see you Tuesday.', DAY)).toBe('none');
    expect(slaPhraseStatus(body, DAY)).toBe('current');
    expect(slaPhraseStatus(body, NIGHT)).toBe('stale'); // drafted at 7 PM, sent after close
    expect(slaPhraseStatus("We'll have an answer by 9 AM this morning.", DAWN)).toBe('current');
    expect(slaPhraseStatus("We'll have an answer by 9 AM this morning.", DAY)).toBe('stale'); // sent after 9 AM
    expect(slaPhraseStatus("by 9 AM tomorrow morning", NIGHT)).toBe('current');
  });
});

describe('system prompt, gate ON (Codex r3): no-appointment → OPEN TIMES; follow-up promise → escalate; PENDING ESTIMATE is not an amount source', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
  });

  test('gate on: the three rules read as intended', () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    const { buildSystemPrompt } = require('../services/sms-shadow-drafter');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("no confirmed appointment is shown, do NOT invent a time — offer 2–3 SPECIFIC times from OPEN TIMES (declared in offered_times)");
    expect(prompt).not.toContain("no confirmed appointment is shown, do NOT name a time — say you'll confirm it");
    expect(prompt).toContain('ALWAYS add {"type":"escalate","note":"followup_promised"} to intended_actions');
    expect(prompt).toContain('state the exact amount from BILLING and add {"type":"send_payment_link"}. PENDING ESTIMATE carries no amounts here');
    expect(prompt).not.toContain('exact amount from BILLING or PENDING ESTIMATE');
  });

  test('gate off: the v11 literals are untouched', () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'false';
    const { buildSystemPrompt } = require('../services/sms-shadow-drafter');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("If the customer asks when we're coming and no confirmed appointment is shown, do NOT name a time — say you'll confirm it and get right back to them.");
    expect(prompt).not.toContain('followup_promised');
    expect(prompt).not.toContain('offered_times');
  });
});

describe('liveServiceType (Codex r3): the service a live scheduling reply is about', () => {
  const { liveServiceType } = require('../services/sms-shadow-drafter');
  test('next scheduled visit wins, else the most recent history entry, else null', () => {
    expect(liveServiceType({ upcomingServices: [{ type: 'Lawn Fertilization', date: '2026-10-01' }], serviceHistory: [{ type: 'Quarterly Pest', date: '2026-07-01' }] })).toBe('Lawn Fertilization');
    expect(liveServiceType({ upcomingServices: [], serviceHistory: [{ type: 'Quarterly Pest', date: '2026-07-01' }] })).toBe('Quarterly Pest');
    expect(liveServiceType({ upcomingServices: [{ date: '2026-10-01' }], serviceHistory: [] })).toBeNull();
    expect(liveServiceType(null)).toBeNull();
  });
});

describe('fetchOpenTimesData / openTimesStillOffered forward serviceType to the engine only when known (Codex r3)', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; jest.resetModules(); });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    jest.dontMock('../services/availability');
    jest.resetModules();
  });

  test('a known serviceType rides in the options; the recheck asks with the same one', async () => {
    const getAvailableSlots = jest.fn(async () => ({ days: [{ fullDate: 'Tuesday, September 29', slots: [{ startTime24: '09:00' }] }] }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    const drafter = require('../services/sms-shadow-drafter');
    await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true, serviceType: 'Lawn Fertilization' });
    expect(getAvailableSlots).toHaveBeenLastCalledWith('Venice', null, { customerId: 'cust-1', serviceType: 'Lawn Fertilization' });
    await drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-1', serviceType: 'Lawn Fertilization',
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
    expect(getAvailableSlots).toHaveBeenLastCalledWith('Venice', null, { customerId: 'cust-1', serviceType: 'Lawn Fertilization' });
  });

  test('the snapshot carries serviceType only when known, so existing rows and callers keep their shape', () => {
    const { computeOpenTimesSnapshot } = require('../services/sms-shadow-drafter');
    const offered = [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }];
    expect(computeOpenTimesSnapshot({ openTimesBlock: '- x: y', offeredTimes: offered, city: 'Venice' }).lookup).toEqual({ city: 'Venice', customerId: null, estimateId: null });
    expect(computeOpenTimesSnapshot({ openTimesBlock: '- x: y', offeredTimes: offered, city: 'Venice', serviceType: 'Lawn Fertilization' }).lookup)
      .toEqual({ city: 'Venice', customerId: null, estimateId: null, serviceType: 'Lawn Fertilization' });
  });
});

describe('replyQuotesUngroundedAmount — payment-history amounts authorize only a payment acknowledgement (Codex r4, gate on)', () => {
  const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
  const context = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95 }] } };
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
  });
  test('a FRACTIONAL amount inside the acknowledgement is still an acknowledgement ("$95.50 payment")', () => {
    const ctx = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95.5 }] } };
    expect(replyQuotesUngroundedAmount('We received your $95.50 payment — thank you!', ctx)).toBe(false);
    expect(replyQuotesUngroundedAmount('Thank you for your payment of $95.50.', ctx)).toBe(false);
    expect(replyQuotesUngroundedAmount('Your balance is $95.50.', ctx)).toBe(true);
  });
  test('"your balance is $95" on a zero-balance account with a $95 payment → ungrounded', () => {
    expect(replyQuotesUngroundedAmount('Your balance is $95.', context)).toBe(true);
    expect(replyQuotesUngroundedAmount('Thanks for reaching out — your balance is $95.', context)).toBe(true);
  });
  test('a real acknowledgement of the $95 payment → grounded', () => {
    expect(replyQuotesUngroundedAmount('We received your $95 payment — thank you!', context)).toBe(false);
    expect(replyQuotesUngroundedAmount('Thank you for your payment of $95.', context)).toBe(false);
  });
  test('the current balance is authorized on its own terms, as before', () => {
    expect(replyQuotesUngroundedAmount('Your balance is $120.50.', { billing: { outstandingBalance: 120.5, recentPayments: [] } })).toBe(false);
  });
});

describe('replyBindsDeclaredDays — single-pass day binding (Codex r4)', () => {
  const { replyBindsDeclaredDays } = require('../services/sms-shadow-drafter');
  const TUE = { date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' };
  const WED = { date: 'Wednesday, September 30', window: '9:00 AM - 11:00 AM' };
  const WED2 = { date: 'Wednesday, September 30', window: '2:00 PM - 4:00 PM' };
  test('reply names Tuesday, declaration says Wednesday (same window) → not bound', () => {
    expect(replyBindsDeclaredDays('How about Tuesday 9:00 AM - 11:00 AM?', [WED])).toBe(false);
  });
  test('reply and declaration agree → bound; both days offered and declared → bound', () => {
    expect(replyBindsDeclaredDays('How about Tuesday 9:00 AM - 11:00 AM?', [TUE])).toBe(true);
    expect(replyBindsDeclaredDays('How about Tuesday 9:00 AM - 11:00 AM or Wednesday 9:00 AM - 11:00 AM?', [TUE, WED])).toBe(true);
    expect(replyBindsDeclaredDays('How about Tuesday 9:00 AM - 11:00 AM or Wednesday 2:00 PM - 4:00 PM?', [TUE, WED2])).toBe(true);
    expect(replyBindsDeclaredDays('September 29 from 9:00 AM - 11:00 AM works.', [TUE])).toBe(true); // calendar-date anchor
  });
  test('"day FROM time" phrasing, two options (the following day sits closer to the first time than its own day does) → bound', () => {
    expect(replyBindsDeclaredDays('Tuesday from 9:00 AM - 11:00 AM or Wednesday from 2:00 PM - 4:00 PM', [TUE, WED2])).toBe(true);
    expect(replyBindsDeclaredDays('9:00 AM - 11:00 AM on Tuesday or 2:00 PM - 4:00 PM on Wednesday', [TUE, WED2])).toBe(true);
    expect(replyBindsDeclaredDays('Tuesday, September 29 from 9:00 AM - 11:00 AM works.', [TUE])).toBe(true);
  });

  test('swapped days, or a declared day the reply never names → not bound', () => {
    expect(replyBindsDeclaredDays('How about Tuesday 2:00 PM - 4:00 PM or Wednesday 9:00 AM - 11:00 AM?', [TUE, WED2])).toBe(false);
    expect(replyBindsDeclaredDays('How about 9:00 AM - 11:00 AM?', [TUE])).toBe(false);
  });
  test('no declarations → trivially bound', () => {
    expect(replyBindsDeclaredDays('I will confirm and get back to you.', [])).toBe(true);
  });
});


describe('follow-up promise staleness is scoped to drafts that recorded an escalation (Codex r5)', () => {
  const { draftPromisedFollowup, followupPromiseIsStale } = require('../services/sms-followup-sla');
  const NIGHT = new Date('2026-09-30T01:00:00Z'); // 21:00 ET
  const DAY = new Date('2026-09-29T14:00:00Z'); // 10:00 ET
  const promised = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };

  test('draftPromisedFollowup: an escalate action in the persisted snapshot (object or JSON string); nothing else', () => {
    expect(draftPromisedFollowup(promised)).toBe(true);
    expect(draftPromisedFollowup(JSON.stringify(promised))).toBe(true);
    expect(draftPromisedFollowup({ intended_actions: [{ type: 'send_payment_link' }] })).toBe(false);
    // an escalation WITHOUT the real-answers marker on an older-prompt draft is never touched
    expect(draftPromisedFollowup({ intended_actions: [{ type: 'escalate' }] })).toBe(false);
    expect(draftPromisedFollowup({ intended_actions: [{ type: 'escalate', note: 'cancel_request' }] }, 'house_voice_v11')).toBe(false);
    // …but ANY escalation on a draft the real-answers prompt wrote counts: held
    // categories and cancellations promise the same timing under their own notes
    expect(draftPromisedFollowup({ intended_actions: [{ type: 'escalate' }] }, 'house_voice_v12_real_answers')).toBe(true);
    expect(draftPromisedFollowup({ intended_actions: [{ type: 'escalate', note: 'cancel_request' }] }, 'house_voice_v12_real_answers+bc')).toBe(true);
    expect(draftPromisedFollowup({ intended_actions: [{ type: 'send_payment_link' }] }, 'house_voice_v12_real_answers')).toBe(false);
    expect(draftPromisedFollowup({})).toBe(false);
    expect(draftPromisedFollowup(null)).toBe(false);
    expect(draftPromisedFollowup('not json')).toBe(false);
  });

  test('stale only when BOTH hold: the draft escalated AND its phrase no longer matches the window', () => {
    const body = 'Someone will follow up within the hour.';
    expect(followupPromiseIsStale({ inputSnapshot: promised, body, now: NIGHT })).toBe(true);
    expect(followupPromiseIsStale({ inputSnapshot: promised, body, now: DAY })).toBe(false);
    expect(followupPromiseIsStale({ inputSnapshot: { intended_actions: [] }, body: 'Your technician should arrive within the hour.', now: NIGHT })).toBe(false);
    // a held-category draft from the real-answers prompt: bare escalate, morning phrase, sent that evening
    expect(followupPromiseIsStale({
      inputSnapshot: { intended_actions: [{ type: 'escalate' }] }, promptVersion: 'house_voice_v12_real_answers',
      body: 'A manager will reach out by 9 AM this morning.', now: NIGHT,
    })).toBe(true);
  });
});

describe('replyQuotesUngroundedAmount — gate OFF keeps the original pooled allowlist (live behavior unchanged by PR #5119)', () => {
  const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { delete process.env.GATE_SMS_REAL_ANSWERS; });
  afterEach(() => { if (priorGate !== undefined) process.env.GATE_SMS_REAL_ANSWERS = priorGate; });
  test('any authoritative figure passes regardless of the claim made about it, exactly as before', () => {
    expect(replyQuotesUngroundedAmount('Your balance is $95.', { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95 }] } })).toBe(false);
    expect(replyQuotesUngroundedAmount('Your $95 payment went through.', { billing: { outstandingBalance: 95, recentPayments: [] } })).toBe(false);
    expect(replyQuotesUngroundedAmount('It comes to $41.', { billing: { outstandingBalance: 95, recentPayments: [] } })).toBe(true); // not a fact at all
  });
});

describe('replyQuotesUngroundedAmount — amounts are authorized by MEANING (Codex r5, gate on)', () => {
  const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
  });
  test('a $95 BALANCE does not back "your $95 payment went through" when no payment is on file', () => {
    const context = { billing: { outstandingBalance: 95, recentPayments: [] } };
    expect(replyQuotesUngroundedAmount('Your $95 payment went through — thank you!', context)).toBe(true);
    expect(replyQuotesUngroundedAmount('Your balance is $95.', context)).toBe(false);
    expect(replyQuotesUngroundedAmount('You currently owe $95.', context)).toBe(false);
  });
  test('a reply that states both, each backed by its own fact → grounded', () => {
    const context = { billing: { outstandingBalance: 120.5, recentPayments: [{ amount: 95 }] } };
    expect(replyQuotesUngroundedAmount('We received your $95 payment; your remaining balance is $120.50.', context)).toBe(false);
    expect(replyQuotesUngroundedAmount('We received your $95 payment and your remaining balance is $120.50.', context)).toBe(false);
  });
  test('the SAME two figures with their claims SWAPPED → ungrounded (each amount binds to its own clause, Codex r6)', () => {
    const context = { billing: { outstandingBalance: 120.5, recentPayments: [{ amount: 95 }] } };
    expect(replyQuotesUngroundedAmount('We received your $120.50 payment; your remaining balance is $95.', context)).toBe(true);
    expect(replyQuotesUngroundedAmount('Your $120.50 payment went through and your balance is $95.', context)).toBe(true);
  });
  test('a clause whose amount cannot be bound to exactly one meaning fails closed', () => {
    const context = { billing: { outstandingBalance: 120.5, recentPayments: [{ amount: 95 }] } };
    expect(replyQuotesUngroundedAmount('It comes to $120.50.', context)).toBe(true); // neither owed nor acknowledgement language
  });
});

describe('free re-service is an entitlement resolved through the existing mechanism (Codex r6 P1)', () => {
  const prior = { ra: process.env.GATE_SMS_REAL_ANSWERS, c: process.env.GATE_SMS_AGENT_COMPLAINTS };
  const restore = () => {
    for (const [k, v] of [['GATE_SMS_REAL_ANSWERS', prior.ra], ['GATE_SMS_AGENT_COMPLAINTS', prior.c]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; process.env.GATE_SMS_AGENT_COMPLAINTS = 'true'; });
  afterEach(() => { restore(); jest.dontMock('../services/reservice-scheduler'); jest.dontMock('../models/db'); jest.resetModules(); });

  const CONTEXT = { summary: 'Dana — Quarterly Pest, Venice', upcomingServices: [] };

  test('prompt: the complaint rule offers a free re-service only off the FREE RE-SERVICE fact, via the re-service link, never OPEN TIMES', () => {
    const { buildSystemPrompt } = require('../services/sms-shadow-drafter');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Offer a free re-service ONLY when FREE RE-SERVICE in the facts says eligible');
    expect(prompt).toContain('{"type":"escalate","note":"send_reservice_link"}');
    expect(prompt).toContain('NEVER quote OPEN TIMES for a re-service');
    expect(prompt).not.toContain('offer a free re-service using 2–3 SPECIFIC times from OPEN TIMES');
  });

  test('facts block: the line renders off GATE_SMS_REAL_ANSWERS alone (decoupled from complaints 2026-09-29), and fails closed to "not eligible"', () => {
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    expect(buildFactsBlock(CONTEXT, { reserviceLanes: ['pest', 'lawn'] })).toContain('FREE RE-SERVICE: eligible for pest and lawn');
    expect(buildFactsBlock(CONTEXT, { reserviceLanes: [] })).toContain('FREE RE-SERVICE: not eligible');
    expect(buildFactsBlock(CONTEXT)).toContain('FREE RE-SERVICE: not eligible'); // no lanes passed
    // The fact renders with the complaints gate OFF — its default in prod —
    // since the PEST REPORTS rule needs it there too.
    delete process.env.GATE_SMS_AGENT_COMPLAINTS;
    expect(buildFactsBlock(CONTEXT, { reserviceLanes: ['pest'] })).toContain('FREE RE-SERVICE: eligible for pest');
    process.env.GATE_SMS_AGENT_COMPLAINTS = 'true';
    delete process.env.GATE_SMS_REAL_ANSWERS;
    expect(buildFactsBlock(CONTEXT, { reserviceLanes: ['pest'] })).not.toContain('FREE RE-SERVICE');
  });

  // Codex round-4 P1: liveReserviceLaneState / fetchReserviceFactState delegate
  // ENTIRELY to reservice-scheduler.loadEligibleReserviceLanes — the ONE
  // shared predicate the composer's /reservice-link route also resolves
  // through — so the active/deleted/token/lane checks are exercised once,
  // at that loader (server/tests/reservice-eligible-lanes.test.js), not
  // re-tested here against a fake customer row.
  function loadWith({ lanes = ['pest'], selfServe = true, throws = false, booked = [] } = {}) {
    jest.resetModules();
    // Codex round-11 P2 (PR #5336): the drafter reads reservice-scheduler's SHARED
    // lane availability (coverage minus open callbacks); `lanes` is the covered
    // set and `booked` the lanes holding an open callback. Named
    // loadEligibleReserviceLanes below so the existing call assertions keep reading.
    const loadEligibleReserviceLanes = jest.fn(async () => {
      if (throws) throw new Error('boom');
      const open = Object.fromEntries(booked.map((l) => [l, { date: '2026-10-05' }]));
      return { eligible: lanes, open, bookable: lanes.filter((l) => !booked.includes(l)) };
    });
    // namedReserviceLanesInText (Codex round-6 P1) reads the real module's
    // RESERVICE_LANE_WORD_PATTERNS — pass the actual export through so this
    // mock stays byte-identical to the real module on everything this suite
    // doesn't itself stub out.
    // Codex round-7 (PR #5336): reserviceExcludedSpecialtyInPromise reads the
    // real reportedReserviceExcludedSpecialty the same way.
    const { RESERVICE_LANE_WORD_PATTERNS, RESERVICE_PEST_NOUNS_SOURCE, reportedReserviceExcludedSpecialty, reportedReserviceLane } = jest.requireActual('../services/reservice-scheduler');
    jest.doMock('../services/reservice-scheduler', () => ({
      reserviceSelfServeEnabled: () => selfServe, loadReserviceLaneAvailability: loadEligibleReserviceLanes, RESERVICE_LANE_WORD_PATTERNS, RESERVICE_PEST_NOUNS_SOURCE, reportedReserviceExcludedSpecialty, reportedReserviceLane,
    }));
    return { drafter: require('../services/sms-shadow-drafter'), loadEligibleReserviceLanes };
  }

  test('fetchReserviceFactState: bookable lanes come from the shared availability loader on the customer id', async () => {
    const { drafter, loadEligibleReserviceLanes } = loadWith({ lanes: ['pest', 'lawn'] });
    await expect(drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toEqual({ lanes: ['pest', 'lawn'], booked: {} });
    expect(loadEligibleReserviceLanes).toHaveBeenCalledWith('cust-1');
  });

  test('fetchReserviceFactState fails closed: self-serve off, no id, or a lookup error → no lanes', async () => {
    await expect(loadWith({ selfServe: false }).drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toEqual({ lanes: [], booked: {} });
    await expect(loadWith({}).drafter.fetchReserviceFactState({ customerId: null })).resolves.toEqual({ lanes: [], booked: {} });
    await expect(loadWith({ throws: true }).drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toEqual({ lanes: [], booked: {} });
  });

  test('fetchReserviceFactState: real-answers gate off → null (no fact rendered, mechanism never consulted)', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    const { drafter, loadEligibleReserviceLanes } = loadWith({});
    await expect(drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toBeNull();
    expect(loadEligibleReserviceLanes).not.toHaveBeenCalled();
  });

  test('fetchReserviceFactState: complaints gate off (its default in prod) still consults the mechanism — decoupled 2026-09-29', async () => {
    delete process.env.GATE_SMS_AGENT_COMPLAINTS;
    const { drafter, loadEligibleReserviceLanes } = loadWith({ lanes: ['lawn'] });
    await expect(drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toEqual({ lanes: ['lawn'], booked: {} });
    expect(loadEligibleReserviceLanes).toHaveBeenCalled();
  });

  // Codex round-3 P2: liveReserviceLaneState (fetchReserviceFactState's underlying
  // live-lane check, also used by reservicePromiseStillEligible below) must
  // consult the live mechanism with NO dependency on GATE_SMS_REAL_ANSWERS —
  // a send-time recheck must still revalidate an already-drafted promise
  // even if the gate were flipped off in between.
  test('liveReserviceLaneState: consults the mechanism even with GATE_SMS_REAL_ANSWERS off', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    const { drafter, loadEligibleReserviceLanes } = loadWith({ lanes: ['pest'] });
    await expect(drafter.liveReserviceLaneState('cust-1')).resolves.toEqual({ eligible: ['pest'], open: {}, bookable: ['pest'] });
    expect(loadEligibleReserviceLanes).toHaveBeenCalledWith('cust-1');
  });

  test('liveReserviceLaneState fails closed the same way fetchReserviceFactState does', async () => {
    await expect(loadWith({ selfServe: false }).drafter.liveReserviceLaneState('cust-1')).resolves.toEqual({ eligible: [], open: {}, bookable: [] });
    await expect(loadWith({}).drafter.liveReserviceLaneState(null)).resolves.toEqual({ eligible: [], open: {}, bookable: [] });
    await expect(loadWith({ throws: true }).drafter.liveReserviceLaneState('cust-1')).resolves.toEqual({ eligible: [], open: {}, bookable: [] });
  });

  // Codex round-3 P2: send-time revalidation of an already-reviewed/queued
  // re-service promise — agentDecisionSendBlockReason and the scheduler's
  // queued-send recheck both call this.
  describe('reservicePromiseStillEligible — send-time revalidation of a re-service promise', () => {
    const PROMISE_BODY = "Good news — we'll send your free re-service link now.";

    test('no re-service promise in the outgoing body → null (nothing to revalidate)', async () => {
      const { drafter } = loadWith({ lanes: ['pest'] });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: 'Your balance is $95, due at the next visit.', customerId: 'cust-1', promisedLanes: ['pest'],
      })).resolves.toBeNull();
    });

    test('promised lane still live-eligible → null', async () => {
      const { drafter } = loadWith({ lanes: ['pest', 'lawn'] });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: PROMISE_BODY, customerId: 'cust-1', promisedLanes: ['pest'],
      })).resolves.toBeNull();
    });

    test('promised lane no longer live-eligible → blocks with a reason naming it', async () => {
      const { drafter } = loadWith({ lanes: ['lawn'] }); // pest dropped since drafting
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: PROMISE_BODY, customerId: 'cust-1', promisedLanes: ['pest'],
      })).resolves.toMatch(/no longer eligible for a free pest re-service/);
    });

    test('no promised lane recorded (legacy/missing snapshot) → fails CLOSED', async () => {
      const { drafter } = loadWith({ lanes: ['pest'] });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: PROMISE_BODY, customerId: 'cust-1', promisedLanes: null,
      })).resolves.toMatch(/no promised re-service lane/);
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: PROMISE_BODY, customerId: 'cust-1', promisedLanes: [],
      })).resolves.toMatch(/no promised re-service lane/);
    });

    test('no customer on record → fails CLOSED', async () => {
      const { drafter } = loadWith({ lanes: ['pest'] });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: PROMISE_BODY, customerId: null, promisedLanes: ['pest'],
      })).resolves.toMatch(/no customer on record/);
    });

    test('a live lookup error fails CLOSED (liveReserviceLaneState\'s own fail-closed propagates)', async () => {
      const { drafter } = loadWith({ throws: true });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: PROMISE_BODY, customerId: 'cust-1', promisedLanes: ['pest'],
      })).resolves.toMatch(/no longer eligible/);
    });

    test('revalidates even with the gate off — a stale reservice promise from before the gate flipped still blocks', async () => {
      delete process.env.GATE_SMS_REAL_ANSWERS;
      const { drafter } = loadWith({ lanes: ['lawn'] });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: PROMISE_BODY, customerId: 'cust-1', promisedLanes: ['pest'],
      })).resolves.toMatch(/no longer eligible for a free pest re-service/);
    });
  });

  // Codex round-4 P2: reservicePromiseStillEligible only ever re-checked the
  // DRAFT-time promisedLanes snapshot — a human edit to the reviewed body
  // that swaps which lane it actually names (pest -> lawn) sailed through
  // unrevalidated as long as SOME lane was in the stale snapshot. Fix: a
  // lane the OUTGOING body explicitly names must itself be live-eligible.
  describe('reservicePromiseStillEligible — validates the lane NAMED in the (possibly edited) outgoing body', () => {
    test('edited from pest to lawn → blocked when lawn is not live-eligible, even though the snapshot (pest) still is', async () => {
      const { drafter } = loadWith({ lanes: ['pest'] }); // pest still eligible; lawn is not
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: "Good news — we'll send your free lawn re-service link now.",
        customerId: 'cust-1',
        promisedLanes: ['pest'], // draft time promised pest; the reviewed body was edited to lawn
      })).resolves.toMatch(/no longer eligible for a free lawn re-service/);
    });

    test('edited to a lane that IS live-eligible passes, even though it differs from the draft-time snapshot', async () => {
      const { drafter } = loadWith({ lanes: ['lawn'] });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: "Good news — we'll send your free lawn re-service link now.",
        customerId: 'cust-1',
        promisedLanes: ['pest'],
      })).resolves.toBeNull();
    });

    test('generic wording (no lane named after the edit) still falls back to the draft-time snapshot', async () => {
      const { drafter } = loadWith({ lanes: ['lawn'] }); // pest no longer eligible
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: "Good news — we'll send your free re-service link now.", // still generic after the edit
        customerId: 'cust-1',
        promisedLanes: ['pest'],
      })).resolves.toMatch(/no longer eligible for a free pest re-service/);
    });

    // Codex round-7 (PR #5336) P2 #1: a reviewer edits a valid pest draft into
    // an excluded-specialty promise. That names no pest/lawn lane, so the
    // recheck used to fall back to the ['pest'] snapshot and pass.
    test.each([
      "We'll send your free termite re-service link.",
      'Good news — your free rodent re-service is covered; we will text the link now.',
      'Your free mosquito re-service is on us, link coming.',
    ])('an edit into an excluded-specialty promise is blocked even when the snapshot lane is live-eligible: %s', async (outgoingBody) => {
      const { drafter, loadEligibleReserviceLanes } = loadWith({ lanes: ['pest'] });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody, customerId: 'cust-1', promisedLanes: ['pest'],
      })).resolves.toMatch(/excluded specialty/);
      expect(loadEligibleReserviceLanes).not.toHaveBeenCalled();
    });

    // Codex round-7 (PR #5336) P2 #2: lane words in the acknowledgement are not
    // part of the offer — only the promise clause names the lane.
    test('a location word in the acknowledgement ("yard") never adds a lawn lane; the promise clause decides', async () => {
      const { drafter } = loadWith({ lanes: ['pest'] }); // pest-only customer
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: "Sorry the ants are back in your yard. Your free pest re-service is covered; we'll text the link now.",
        customerId: 'cust-1',
        promisedLanes: ['pest'],
      })).resolves.toBeNull();
    });

    test('a promise clause naming no lane still falls back to the snapshot even when the acknowledgement names another lane', async () => {
      const { drafter } = loadWith({ lanes: ['lawn'] }); // pest no longer eligible
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: "Sorry the ants are back in your yard, we'll send your free re-service link now.",
        customerId: 'cust-1',
        promisedLanes: ['pest'],
      })).resolves.toMatch(/no longer eligible for a free pest re-service/);
    });

    test('"free lawn re-service" still resolves to lawn (blocked when only pest is live-eligible)', async () => {
      const { drafter } = loadWith({ lanes: ['pest'] });
      await expect(drafter.reservicePromiseStillEligible({
        outgoingBody: "Sorry the ants are back. We'll send your free lawn re-service link now.",
        customerId: 'cust-1',
        promisedLanes: ['pest'],
      })).resolves.toMatch(/no longer eligible for a free lawn re-service/);
    });
  });

  test('validateReserviceOffer: a free-visit offer is a violation unless the facts say eligible', () => {
    const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
    const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
    const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
    // A generic reply names no lane, so a real (converging) draft needs the
    // reported issue resolvable from the inbound text, plus the send-link
    // action — supplied here so this test isolates the ELIGIBILITY check
    // alone (Codex round-1 P2 (c)/(d) get their own tests below).
    const inboundMessage = 'still have ants, can you come back?';
    const intendedActions = [{ type: 'escalate', note: 'send_reservice_link' }];
    // Codex round-6 P1: isReserviceOfferPromise now requires a re-service-
    // specific noun (never a bare "visit") — "callback visit" is one of
    // those specific nouns, so this fixture still exercises a
    // free-word-paired-with-a-noun phrasing distinct from the other two.
    for (const reply of ['We can come back for a free re-service.', 'We will re-treat at no charge.', 'A complimentary visit is on us.', 'A complimentary callback visit is on us.']) {
      expect(validateReserviceOffer({ reply, factsBlock: notEligible, inboundMessage, intendedActions }).ok).toBe(false);
      expect(validateReserviceOffer({ reply, factsBlock: 'no such line', inboundMessage, intendedActions }).ok).toBe(false);
      expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage, intendedActions }).ok).toBe(true);
    }
    expect(validateReserviceOffer({ reply: 'I am sorry about that — a manager will reach out within the hour.', factsBlock: notEligible }).ok).toBe(true);
    delete process.env.GATE_SMS_REAL_ANSWERS; // gate off: the check does not run
    expect(validateReserviceOffer({ reply: 'We can come back for a free re-service.', factsBlock: notEligible }).ok).toBe(true);
  });

  // Codex round-1 P2 (c): the send-link action is what actually gets a
  // teammate to text the re-service link — a promise with none of that is
  // exactly as broken as an ineligible offer.
  test('validateReserviceOffer: a free-visit promise without {"type":"escalate","note":"send_reservice_link"} in intended_actions is a violation', () => {
    const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
    const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
    const reply = 'We will come back for a free pest re-service.'; // names the lane explicitly
    expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage: 'ants', intendedActions: [] }).ok).toBe(false);
    expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage: 'ants', intendedActions: [{ type: 'escalate' }] }).ok).toBe(false); // escalate with the WRONG/no note
    expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage: 'ants', intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }] }).ok).toBe(true);
  });

  // Codex round-3 P2: the resolved lane(s) ride the ok:true result so the
  // caller can persist them (reserviceLanesSnapshot) for a later send-time
  // recheck (reservicePromiseStillEligible) — never re-derived from a
  // possibly-edited outgoing body.
  test('validateReserviceOffer: an ok result carries the resolved promisedLanes; a non-promise reply carries none', () => {
    const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
    const eligible = `X\n${reserviceFactLine(['pest', 'lawn'])}\nBILLING:`;
    expect(validateReserviceOffer({
      reply: 'We will come back for a free pest re-service.', factsBlock: eligible, inboundMessage: 'ants',
      intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }],
    }).promisedLanes).toEqual(['pest']);
    // Generic offer with no lane named in the reply resolves from the
    // inbound text (Codex round-1 P2 (d))'s reported lane.
    expect(validateReserviceOffer({
      reply: "Good news — we'll send you the free re-service link now.", factsBlock: eligible, inboundMessage: 'the ants are back',
      intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }],
    }).promisedLanes).toEqual(['pest']);
    // No promise at all → violations: [] and no lanes to persist.
    const noPromise = validateReserviceOffer({ reply: 'Thanks for reaching out!', factsBlock: eligible });
    expect(noPromise.ok).toBe(true);
    expect(noPromise.promisedLanes).toBeUndefined();
  });

  // Codex round-1 P2 (d): a GENERIC offer (no lane named in the reply) must
  // resolve the customer's REPORTED lane from their own inbound text and
  // require it to match what FREE RE-SERVICE lists — a pest-only
  // entitlement must not cover a reported lawn issue, and an unresolved
  // report must not sail through on an unrelated lane's eligibility either.
  describe('validateReserviceOffer: generic offer resolves the reported service line from the inbound text', () => {
    const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
    const GENERIC_REPLY = "Good news — we'll send you the free re-service link now.";
    test('reported lane (pest) intersects the eligible (pest) lane → ok', () => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      expect(validateReserviceOffer({ reply: GENERIC_REPLY, factsBlock: eligible, inboundMessage: 'the ants are back', intendedActions: sendLink }).ok).toBe(true);
    });
    test('reported lane (lawn) does NOT intersect the eligible (pest-only) lane → violation', () => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      const out = validateReserviceOffer({ reply: GENERIC_REPLY, factsBlock: eligible, inboundMessage: 'the grass is looking bad again', intendedActions: sendLink });
      expect(out.ok).toBe(false);
      expect(out.violations[0]).toMatch(/reported a lawn issue/);
    });
    test('no resolvable lane in the inbound text and none named in the reply → violation', () => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      expect(validateReserviceOffer({ reply: GENERIC_REPLY, factsBlock: eligible, inboundMessage: 'can you come back out?', intendedActions: sendLink }).ok).toBe(false);
    });

    // Codex round-4 P2: the reported-lane resolver must be the re-service
    // mechanism's OWN lane mapping (reservice-scheduler.reportedReserviceLane),
    // not sms-service-intent.js's lead-intake regexClassify — that classifier
    // lumps termite/rodent/mosquito words into its 'pest' bucket, which would
    // let those EXCLUDED specialties (reservice-scheduler's own
    // laneForCoverageRow carves them out of the self-bookable pest lane) ride
    // the free PEST re-service link. A pest-only-eligible customer reporting
    // one of these must be blocked (the generic offer resolves to no
    // coverable lane), not waved through as "pest".
    test.each([
      ['termites are back', 'termites'],
      ['saw a mosquito problem again', 'mosquitoes'],
      ['rats in the attic again', 'rats'],
    ])('a reported %s issue never resolves to the pest lane, even on a pest-only-eligible account', (inboundMessage) => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      const out = validateReserviceOffer({ reply: GENERIC_REPLY, factsBlock: eligible, inboundMessage, intendedActions: sendLink });
      expect(out.ok).toBe(false);
      expect(out.violations[0]).not.toMatch(/reported a pest issue/);
    });
  });

  // Codex round-5 P1: the reported issue's own lane from the inbound is
  // resolved and checked EVERY time — not only when the reply names no lane.
  // A reply naming a lane that IS itself eligible must still be rejected
  // when the customer's own report is about an excluded specialty or a
  // different (also-eligible) lane.
  describe('validateReserviceOffer: the reported lane is checked even when the reply NAMES a lane', () => {
    const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
    const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');

    test('pest-only customer reports a lawn issue, reply promises a (technically eligible) pest re-service → rejected', () => {
      const pestOnly = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      const out = validateReserviceOffer({
        reply: 'We will come back for a free pest re-service.',
        factsBlock: pestOnly,
        inboundMessage: 'the grass is looking bad again',
        intendedActions: sendLink,
      });
      expect(out.ok).toBe(false);
    });

    test('customer reports termites (excluded specialty), reply promises a free pest re-service → rejected', () => {
      const pestOnly = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      const out = validateReserviceOffer({
        reply: 'We will come back for a free pest re-service.',
        factsBlock: pestOnly,
        inboundMessage: 'the termites are back',
        intendedActions: sendLink,
      });
      expect(out.ok).toBe(false);
    });

    test('customer reports ants (pest), reply promises a free pest re-service → ok', () => {
      const pestOnly = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      const out = validateReserviceOffer({
        reply: 'We will come back for a free pest re-service.',
        factsBlock: pestOnly,
        inboundMessage: 'the ants are back',
        intendedActions: sendLink,
      });
      expect(out.ok).toBe(true);
    });
  });

  // Codex round-5 P2: the re-service link page shows the customer its own
  // real availability — a promise must never ALSO offer or book a specific
  // appointment slot right in the reply.
  describe('validateReserviceOffer: rejects appointment slots in a free re-service reply', () => {
    const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
    const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
    const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
    const reply = 'We will come back for a free pest re-service. How about Tuesday 9:00 AM - 11:00 AM?';

    test('non-empty offered_times on a re-service promise → rejected', () => {
      const out = validateReserviceOffer({
        reply, factsBlock: eligible, inboundMessage: 'the ants are back', intendedActions: sendLink,
        offeredTimes: [{ date: 'Tuesday', window: '9:00 AM - 11:00 AM' }],
      });
      expect(out.ok).toBe(false);
    });

    test('a book_appointment action on a re-service promise → rejected', () => {
      const out = validateReserviceOffer({
        reply, factsBlock: eligible, inboundMessage: 'the ants are back',
        intendedActions: [...sendLink, { type: 'book_appointment' }],
        offeredTimes: [],
      });
      expect(out.ok).toBe(false);
    });

    test('no offered_times and no book_appointment action → the offer itself still passes', () => {
      const out = validateReserviceOffer({
        reply: 'We will come back for a free pest re-service.',
        factsBlock: eligible, inboundMessage: 'the ants are back', intendedActions: sendLink, offeredTimes: [],
      });
      expect(out.ok).toBe(true);
    });
  });

  // Codex round-2 finding: validateReserviceOffer returned early (ok:true,
  // no checks run at all) unless the reply said "free"/"complimentary" —
  // "Your pest re-service is covered; we'll text the booking link now"
  // skipped eligibility, lane, and action checks entirely.
  describe('validateReserviceOffer: a re-service promise without "free"/"complimentary" wording is still detected (Codex round-2)', () => {
    const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
    test.each([
      'Your pest re-service is covered; we\'ll text the booking link now.',
      'We\'ll send the re-service link over shortly.',
      'Your revisit is included — the booking link is on its way.',
      'No charge for the re-service — come back out this week.',
    ])('%s → detected as a re-service promise (still requires eligibility + action, same as a "free" offer)', (reply) => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
      const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      const inboundMessage = 'still have ants';
      // Not eligible: caught, same as a "free"-worded offer would be.
      expect(validateReserviceOffer({ reply, factsBlock: notEligible, inboundMessage, intendedActions: sendLink }).ok).toBe(false);
      // Eligible + the send-link action present: passes.
      expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage, intendedActions: sendLink }).ok).toBe(true);
      // Eligible but MISSING the send-link action: still caught (Codex
      // round-1 P2 (c) applies here too, not just to "free"-worded offers).
      expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage, intendedActions: [] }).ok).toBe(false);
    });

    test('an unrelated "covered"/"included"/"link" sentence with no re-service term is NOT detected (false-positive control)', () => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
      expect(validateReserviceOffer({ reply: 'Your invoice is covered — here is the payment link.', factsBlock: notEligible }).ok).toBe(true);
      expect(validateReserviceOffer({ reply: 'Your annual plan includes two more treatments this year.', factsBlock: notEligible }).ok).toBe(true);
    });
  });

  describe('isReserviceOfferPromise — the single entry point both FREE_RESERVICE_OFFER_RE and the round-2 broadened detection feed', () => {
    test('true for a "free" offer, true for a covered/included/link promise, false for unrelated text', () => {
      const { isReserviceOfferPromise } = require('../services/sms-shadow-drafter');
      expect(isReserviceOfferPromise('We can come back for a free re-service.')).toBe(true);
      expect(isReserviceOfferPromise('Your pest re-service is covered; we will text the link now.')).toBe(true);
      expect(isReserviceOfferPromise('Your balance is $95, due at the next visit.')).toBe(false);
    });
  });

  // Codex round-6 P1: isReserviceOfferPromise treated generic "free ... visit
  // | return" as a re-service promise, so the unconditional send-time check
  // rejected routine copy that never promised anything re-service-specific.
  describe('isReserviceOfferPromise — requires a re-service-specific noun, not bare "free"/"visit"/"return" (Codex round-6 P1)', () => {
    const { isReserviceOfferPromise } = require('../services/sms-shadow-drafter');

    test.each([
      'Feel free to return to your estimate link anytime.',
      'Your balance is $95, due at the next visit.',
      'Feel free to visit our website for more info.',
      'You are free to return the equipment whenever it suits you.',
    ])('%s → NOT a re-service promise', (text) => {
      expect(isReserviceOfferPromise(text)).toBe(false);
    });

    // PR #5336 pre-push audit P1: the round-6 narrowing dropped plain
    // free-visit offers; they are explicit promises and must stay guarded.
    test.each([
      'A complimentary visit is on us.',
      'We can send a technician for a free visit.',
      "We won't charge you for the visit.",
      'No charge for the visit.',
      'The return trip is on the house.',
      'We can come back out at no cost.',
    ])('%s → an explicit free-visit offer IS a promise', (text) => {
      expect(isReserviceOfferPromise(text)).toBe(true);
    });

    test.each([
      'Feel free to call us to schedule a visit.',
      "You're free to visit the portal anytime.",
      'You can count on us to come back and treat.',
      'We offer a free estimate, then a visit on Tuesday.',
    ])('%s → idiom / free estimate, NOT a promise', (text) => {
      expect(isReserviceOfferPromise(text)).toBe(false);
    });

    // The two quoted wordings guard end to end: draft time, send time, and
    // the promise-clause picker (no lane word -> snapshot fallback).
    test.each([
      'A complimentary visit is on us.',
      'We can send a technician for a free visit.',
    ])('%s → validated at draft time and revalidated at send time', async (reply) => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
      const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
      const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      expect(validateReserviceOffer({ reply, factsBlock: notEligible, inboundMessage: 'still have ants', intendedActions: sendLink }).ok).toBe(false);
      expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage: 'still have ants', intendedActions: sendLink }).ok).toBe(true);
      // Send time (no lane word in the promise clause -> the pest snapshot decides,
      // after the excluded-specialty check).
      const { drafter } = loadWith({ lanes: ['lawn'] });
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody: `Sorry about the ants in the yard. ${reply}`, customerId: 'cust-1', promisedLanes: ['pest'] }))
        .resolves.toMatch(/no longer eligible for a free pest re-service/);
      // ...and an excluded specialty in the same kind of clause is still rejected first.
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody: reply.replace(/visit/, 'termite visit'), customerId: 'cust-1', promisedLanes: ['pest'] }))
        .resolves.toMatch(/excluded specialty/);
    });

    // PR #5336 pre-push audit P1: a truthful eligibility DENIAL names the same
    // words as a promise but promises nothing.
    const DENIALS = [
      'You are not eligible for a free re-service.',
      'We cannot offer a free pest re-service.',
      "Unfortunately we can't send a free re-service.",
      'Your plan no longer qualifies for a free re-service.',
      "A free re-service isn't covered under your plan.",
      "Your plan doesn't include a free re-service.",
      'We are not able to offer a complimentary visit.',
      'We are not yet eligible for a free re-service.',
      // Codex round-8 P2: a negator directly on the price word is a denial.
      'This re-service is not free.',
      "The visit isn't complimentary.",
      'The re-service is not covered at no cost.',
      "The visit isn't free.",
    ];
    test.each(DENIALS)('%s → a denial, NOT a promise', (text) => {
      expect(isReserviceOfferPromise(text)).toBe(false);
    });

    test.each([
      "We won't charge you for the visit.",
      'No charge for the visit.',
      'Sorry, you are not eligible for a free re-service, but your free lawn re-service is covered.',
      'You are not eligible for a free pest re-service. However, a complimentary visit is on us.',
      // PR #5336 pre-push audit P1 (denial scoping): an unrelated denial in the
      // same clause never suppresses a real offer; contrastive conjunctions split.
      'We cannot offer a refund but we can provide a free pest re-service.',
      "we can't offer a refund, however a complimentary visit is on us",
      'We cannot offer a refund and will send a free re-service.',
      'We cannot offer a refund and a free re-service is on us.',
      // Pre-push audit P1 (every offer): a denied offer never hides a later affirmative one.
      'We cannot offer a free lawn re-service and will send a free pest re-service.',
      'We will send a free pest re-service but cannot offer a free lawn re-service.',
      // Codex round-8 P2: a copula BEFORE "free" no longer excludes it.
      "Your visit is free; we'll text the booking link now.",
      'The re-service is free.',
      'The visit is free of charge.',
    ])('%s → still a promise (price-word negation / separate affirmative clause / unrelated denial)', (text) => {
      expect(isReserviceOfferPromise(text)).toBe(true);
    });

    // Round-8 P2 #1 end to end: a copular free-visit promise gets the eligibility AND
    // the send_reservice_link action checks, and "free to <verb>" idioms still don't.
    test('"Your visit is free; we\'ll text the booking link now." → eligibility + send-link action are enforced', () => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const reply = "Your visit is free; we'll text the booking link now.";
      const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
      const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
      expect(validateReserviceOffer({ reply, factsBlock: notEligible, inboundMessage: 'still have ants', intendedActions: sendLink }).ok).toBe(false);
      expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage: 'still have ants', intendedActions: [] }).ok).toBe(false);
      expect(validateReserviceOffer({ reply, factsBlock: eligible, inboundMessage: 'still have ants', intendedActions: sendLink }).ok).toBe(true);
    });

    // The promised lane comes from the AFFIRMATIVE offer only: the denied lawn offer never counts.
    test.each([
      'We cannot offer a free lawn re-service and will send a free pest re-service.',
      'We will send a free pest re-service but cannot offer a free lawn re-service.',
    ])('%s → a promise for the PEST lane only (draft + send time)', async (reply) => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
      const pestOnly = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
      const out = validateReserviceOffer({ reply, factsBlock: pestOnly, intendedActions: sendLink });
      expect(out.ok).toBe(true);
      expect(out.promisedLanes).toEqual(['pest']);
      // A customer eligible for neither lane is refused; a lawn-only customer is refused a PEST promise.
      expect(validateReserviceOffer({ reply, factsBlock: `X\n${reserviceFactLine([])}\nBILLING:`, intendedActions: sendLink }).ok).toBe(false);
      expect(validateReserviceOffer({ reply, factsBlock: `X\n${reserviceFactLine(['lawn'])}\nBILLING:`, intendedActions: sendLink }).ok).toBe(false);
      // Send time: live pest eligibility alone is enough (lawn is never consulted); lawn-only blocks the pest promise.
      await expect(loadWith({ lanes: ['pest'] }).drafter.reservicePromiseStillEligible({ outgoingBody: reply, customerId: 'cust-1', promisedLanes: null })).resolves.toBeNull();
      await expect(loadWith({ lanes: ['lawn'] }).drafter.reservicePromiseStillEligible({ outgoingBody: reply, customerId: 'cust-1', promisedLanes: null })).resolves.toMatch(/no longer eligible for a free pest re-service/);
    });

    // Codex round-9 (PR #5336) P2 #2: a lane is PROMISED only when a service word
    // directly modifies the offer noun; location words never produce a lane.
    test.each([
      ["We'll send your free pest re-service link for the ants in your yard.", ['pest']],
      ['We can come back for a free lawn re-service.', ['lawn']],
      ['We can send your free re-service for your lawn.', ['lawn']],
      ['Good news — free weed-treatment re-service link is on its way.', ['lawn']],
      ['Your free pest and lawn re-service is covered.', ['pest', 'lawn']],
    ])('%s → promised lanes %j', (reply, expected) => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const both = `X\n${reserviceFactLine(['pest', 'lawn'])}\nBILLING:`;
      const out = validateReserviceOffer({ reply, factsBlock: both, intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }] });
      expect(out.ok).toBe(true);
      expect(out.promisedLanes).toEqual(expected);
    });

    test('a location word alone ("the ants in your yard") names no lane → snapshot fallback at send time', async () => {
      const outgoingBody = 'We will send a free re-service, the ants in your yard sound rough.';
      // Draft time: no lane modifier and no resolvable reported lane → asked to name the line.
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      expect(validateReserviceOffer({ reply: outgoingBody, factsBlock: `X\n${reserviceFactLine(['pest'])}\nBILLING:`, intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }] }).ok).toBe(false);
      // Send time: falls back to the snapshot (pest live → passes; lawn not consulted).
      await expect(loadWith({ lanes: ['pest'] }).drafter.reservicePromiseStillEligible({ outgoingBody, customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toBeNull();
      await expect(loadWith({ lanes: ['lawn'] }).drafter.reservicePromiseStillEligible({ outgoingBody, customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toMatch(/no longer eligible for a free pest re-service/);
    });

    test("the pest promise that mentions the yard sends for a pest-only customer (the round-9 quoted case)", async () => {
      await expect(loadWith({ lanes: ['pest'] }).drafter.reservicePromiseStillEligible({
        outgoingBody: "We'll send your free pest re-service link for the ants in your yard.", customerId: 'cust-1', promisedLanes: ['pest'],
      })).resolves.toBeNull();
    });

    // Codex round-10 (PR #5336).
    test.each([
      ['A free visit to treat your lawn.', ['lawn']],
      ["We'll send a technician back for a complimentary visit to take care of the ants.", ['pest']],
      ['Free inspection of your lawn is on us.', ['lawn']],
    ])('%s → purpose clause / inspection names the lane %j', (reply, expected) => {
      const { isReserviceOfferPromise, namedReserviceLanesInText } = require('../services/sms-shadow-drafter');
      expect(isReserviceOfferPromise(reply)).toBe(true);
      expect(namedReserviceLanesInText(reply)).toEqual(expected);
    });

    test('a pest-eligible customer is NOT waved through "a free visit to treat your lawn" at send time (lane lawn, not the pest snapshot)', async () => {
      await expect(loadWith({ lanes: ['pest'] }).drafter.reservicePromiseStillEligible({ outgoingBody: 'A free visit to treat your lawn.', customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toMatch(/no longer eligible for a free lawn re-service/);
    });

    test('a denied hit at the clause level never hides an affirmative offer at a coarser level', () => {
      const { isReserviceOfferPromise, namedReserviceLanesInText } = require('../services/sms-shadow-drafter');
      const reply = "We can't offer a free lawn re-service, but we can send another pest visit, free of charge.";
      expect(isReserviceOfferPromise(reply)).toBe(true);
      expect(namedReserviceLanesInText(reply)).toEqual(['pest']);
    });

    test('"free inspection" is a guarded technician-visit offer (draft + send time)', async () => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const reply = "We'll do a free pest inspection this week.";
      expect(validateReserviceOffer({ reply, factsBlock: `X\n${reserviceFactLine([])}\nBILLING:`, intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }] }).ok).toBe(false);
      await expect(loadWith({ lanes: [] }).drafter.reservicePromiseStillEligible({ outgoingBody: reply, customerId: 'cust-1', promisedLanes: null })).resolves.toMatch(/no longer eligible for a free pest re-service/);
    });

    // Codex round-11 P1 #1 (PR #5336): a promise visible only at a coarser
    // granularity must not be dropped when another sentence has a finer hit.
    test('two-sentence body: the pest link promise AND the lawn visit are both promised (union of granularities)', () => {
      const { validateReserviceOffer, reserviceFactLine, namedReserviceLanesInText } = require('../services/sms-shadow-drafter');
      const reply = "We'll send your free pest re-service link. We can also provide a lawn visit, free of charge.";
      expect(namedReserviceLanesInText(reply)).toEqual(['pest', 'lawn']);
      const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
      // pest-only customer: the second offer (lawn) is rejected at draft time, not silently snapshotted as pest only.
      expect(validateReserviceOffer({ reply, factsBlock: `X\n${reserviceFactLine(['pest'])}\nBILLING:`, intendedActions: sendLink }).ok).toBe(false);
      const both = validateReserviceOffer({ reply, factsBlock: `X\n${reserviceFactLine(['pest', 'lawn'])}\nBILLING:`, intendedActions: sendLink });
      expect(both.ok).toBe(true);
      expect(both.promisedLanes).toEqual(['pest', 'lawn']);
    });

    // Codex round-11 P1 #2: NEW-version decisions need the snapshot AND the send action, in every branch.
    test('new-version (real_answers2) with no snapshot, empty actions, edited body naming a live pest lane → blocked', async () => {
      const outgoingBody = "We'll send your free pest re-service link now";
      const { drafter } = loadWith({ lanes: ['pest'] });
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers2', draftId: null, intendedActions: [] } })).resolves.toMatch(/no promised re-service lane on record/);
      const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
      await expect(agentDecisionSendBlockReason({
        decision: { id: 'd1', customer_id: 'cust-1', suggested_message: outgoingBody, input_snapshot: JSON.stringify({ intended_actions: [] }), prompt_version: 'house_voice_v12_real_answers2' },
        outgoingBody,
      })).resolves.toMatch(/re-service promise unsendable/);
    });

    test('new-version WITH a snapshot but no send_reservice_link action → blocked; with both → sends', async () => {
      const outgoingBody = "We'll send your free pest re-service link now";
      const meta = (intendedActions) => ({ promptVersion: 'house_voice_v12_real_answers2', draftId: null, intendedActions });
      const { drafter } = loadWith({ lanes: ['pest'] });
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody, customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta([]) })).resolves.toMatch(/no send_reservice_link action on record/);
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody, customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta([{ type: 'escalate', note: 'send_reservice_link' }]) })).resolves.toBeNull();
    });

    // Codex round-11 P2 (PR #5336): the promised lane is revalidated against the SAME
    // availability the public page uses — coverage minus open callbacks.
    describe('an already-booked lane is not promisable (shared lane availability)', () => {
      const pestPromise = "We'll send your free pest re-service link now";
      const lawnPromise = "We'll send your free lawn re-service link now";

      test('lane booked between draft and send → blocked with an "already booked" reason', async () => {
        const { drafter } = loadWith({ lanes: ['pest', 'lawn'], booked: ['pest'] });
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: pestPromise, customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toMatch(/already booked/);
      });

      test('the OTHER lane is still open → passes', async () => {
        const { drafter } = loadWith({ lanes: ['pest', 'lawn'], booked: ['pest'] });
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: lawnPromise, customerId: 'cust-1', promisedLanes: ['lawn'] })).resolves.toBeNull();
      });

      test('a lane no longer covered still reads "no longer eligible"; a covered-but-booked lane reads "already booked"', async () => {
        const { drafter } = loadWith({ lanes: ['lawn'], booked: [] });
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: pestPromise, customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toMatch(/no longer eligible for a free pest re-service/);
      });

      test('both send entry points block it (new-version card with snapshot + action, and a grandfathered card)', async () => {
        const action = [{ type: 'escalate', note: 'send_reservice_link' }];
        loadWith({ lanes: ['pest'], booked: ['pest'] });
        const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
        await expect(agentDecisionSendBlockReason({
          decision: { id: 'd1', customer_id: 'cust-1', suggested_message: pestPromise, input_snapshot: JSON.stringify({ reservice_lanes_snapshot: ['pest'], intended_actions: action }), prompt_version: 'house_voice_v12_real_answers2' },
          outgoingBody: pestPromise,
        })).resolves.toMatch(/re-service promise unsendable \(a free pest re-service is already booked/);
        await expect(agentDecisionSendBlockReason({
          decision: { id: 'd2', customer_id: 'cust-1', suggested_message: pestPromise, input_snapshot: JSON.stringify({ intended_actions: action }), prompt_version: 'house_voice_v12_real_answers' },
          outgoingBody: pestPromise,
        })).resolves.toMatch(/already booked/);
      });

      test('draft time: the FREE RE-SERVICE fact lists only bookable lanes, so an already-booked lane is not offered', async () => {
        const { drafter } = loadWith({ lanes: ['pest', 'lawn'], booked: ['pest'] });
        process.env.GATE_SMS_REAL_ANSWERS = 'true';
        await expect(drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toEqual({ lanes: ['lawn'], booked: { pest: { date: '2026-10-05' } } });
        const facts = `X\n${drafter.reserviceFactLine(['lawn'])}\nBILLING:`;
        expect(drafter.validateReserviceOffer({ reply: pestPromise, factsBlock: facts, intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }] }).ok).toBe(false);
        expect(drafter.validateReserviceOffer({ reply: lawnPromise, factsBlock: facts, intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }] }).ok).toBe(true);
      });
    });

    // Codex round-12 P1 (PR #5336): lanes derive only from the affirmative offer
    // span + its attached modifier/purpose phrase, never from the rest of the sentence.
    test.each([
      "Your lawn treatment is scheduled, and I'll send your free pest re-service link.",
      "Your lawn treatment is scheduled and I'll send your free pest re-service link.",
    ])('%s → a pest-only customer is NOT rejected (lanes [pest])', (reply) => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const out = validateReserviceOffer({ reply, factsBlock: `X\n${reserviceFactLine(['pest'])}\nBILLING:`, intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }] });
      expect(out.ok).toBe(true);
      expect(out.promisedLanes).toEqual(['pest']);
    });

    test('an unrelated excluded-specialty word elsewhere in the sentence does not reject the promise; one attached to the offer does', async () => {
      const { drafter } = loadWith({ lanes: ['pest'] });
      const ok = "Sorry about the termites in the shed, your free pest re-service link is on the way.";
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody: ok, customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toBeNull();
      const bad = "We'll send your free re-service link for the termites.";
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody: bad, customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toMatch(/excluded specialty/);
    });

    // Codex round-13 P2 #1 (PR #5336): a covered lane that already holds an open callback
    // is "already booked", never "not eligible" (which steered the model to a paid visit).
    describe('already-booked re-service fact', () => {
      const open = { pest: { date: '2026-10-05', windowStart: '09:00' } };

      test('the fact names the booked lane and its appointment; validation still reads bookable lanes only', () => {
        const { reserviceFactLine, validateReserviceOffer } = require('../services/sms-shadow-drafter');
        const only = reserviceFactLine([], open);
        expect(only).toContain('pest already booked (2026-10-05, 9:00 AM - 11:00 AM)');
        expect(only).not.toMatch(/at 09:00/);
        expect(only).not.toContain('not eligible');
        const mixed = reserviceFactLine(['lawn'], open);
        expect(mixed).toContain('eligible for lawn');
        expect(mixed).toContain('pest already booked');
        const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
        // No bookable lane → a free-re-service promise is still refused.
        expect(validateReserviceOffer({ reply: "We'll send your free pest re-service link now", factsBlock: `X\n${only}\nBILLING:`, intendedActions: sendLink }).ok).toBe(false);
        // The pest word inside "pest already booked" never makes pest promisable next to a lawn-eligible fact.
        expect(validateReserviceOffer({ reply: "We'll send your free pest re-service link now", factsBlock: `X\n${mixed}\nBILLING:`, intendedActions: sendLink }).ok).toBe(false);
        expect(validateReserviceOffer({ reply: "We'll send your free lawn re-service link now", factsBlock: `X\n${mixed}\nBILLING:`, intendedActions: sendLink }).ok).toBe(true);
      });

      test('fetchReserviceFactState: bookable lanes + booked lanes with the open callback; gate off → null', async () => {
        process.env.GATE_SMS_REAL_ANSWERS = 'true';
        const { drafter } = loadWith({ lanes: ['pest'], booked: ['pest'] });
        await expect(drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toEqual({ lanes: [], booked: { pest: { date: '2026-10-05' } } });
        const both = loadWith({ lanes: ['pest', 'lawn'], booked: ['pest'] });
        await expect(both.drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toEqual({ lanes: ['lawn'], booked: { pest: { date: '2026-10-05' } } });
        delete process.env.GATE_SMS_REAL_ANSWERS;
        await expect(loadWith({ lanes: ['pest'], booked: ['pest'] }).drafter.fetchReserviceFactState({ customerId: 'cust-1' })).resolves.toBeNull();
      });

      test('the prompt tells the model to reference the existing appointment, not offer a link, OPEN TIMES or a paid visit', () => {
        const { buildSystemPrompt } = require('../services/sms-shadow-drafter');
        const prompt = buildSystemPrompt();
        expect(prompt).toContain('says that service line is ALREADY BOOKED');
        expect(prompt).toContain('refer to the appointment already on the schedule');
      });
    });

    // Pre-push audit P1 (PR #5336): the action-carrying decision is ALWAYS revalidated, so the
    // detector missing a promise can never let it through.
    describe('structural backstop: a decision carrying send_reservice_link always revalidates its snapshot lanes', () => {
      const missed = 'We will have someone stop by again for the ants, no cost to you.';
      const meta = { promptVersion: 'house_voice_v12_real_answers2', draftId: null, intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }] };

      test('the phrasing really is one the body detector misses', () => {
        expect(require('../services/sms-shadow-drafter').isReserviceOfferPromise(missed)).toBe(false);
      });

      test('blocked when the snapshot lane is no longer bookable; passes when it is', async () => {
        await expect(loadWith({ lanes: ['pest'], booked: ['pest'] }).drafter.reservicePromiseStillEligible({ outgoingBody: missed, customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta })).resolves.toMatch(/already booked/);
        await expect(loadWith({ lanes: [] }).drafter.reservicePromiseStillEligible({ outgoingBody: missed, customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta })).resolves.toMatch(/no longer eligible/);
        await expect(loadWith({ lanes: ['pest'] }).drafter.reservicePromiseStillEligible({ outgoingBody: missed, customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta })).resolves.toBeNull();
      });

      test('through the real immediate-send check; a decision WITHOUT the action and a non-promise body is untouched', async () => {
        loadWith({ lanes: [], booked: [] });
        const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
        const withAction = { id: 'd1', customer_id: 'cust-1', suggested_message: missed, input_snapshot: JSON.stringify({ reservice_lanes_snapshot: ['pest'], intended_actions: meta.intendedActions }), prompt_version: 'house_voice_v12_real_answers2' };
        await expect(agentDecisionSendBlockReason({ decision: withAction, outgoingBody: missed })).resolves.toMatch(/re-service promise unsendable/);
        await expect(agentDecisionSendBlockReason({ decision: { ...withAction, input_snapshot: JSON.stringify({ intended_actions: [] }) }, outgoingBody: missed })).resolves.toBeNull();
      });
    });

    // Pre-push audit P1 #2 (PR #5336): the scheduled-send recheck never blocks a plain non-promise
    // message on its own plumbing.
    describe('scheduledReserviceBlockReason (scheduler.js recheck)', () => {
      const throwingDb = () => { throw new Error('db down'); };
      const rowDb = (row) => () => ({ where: () => ({ first: async () => row }) });

      test('DB throw on a NON-promise scheduled send → BLOCKED (round-19 P1: an unreadable decision row fails closed)', async () => {
        loadWith({ lanes: ['pest'] });
        const { scheduledReserviceBlockReason } = require('../services/agent-decision-send-checks');
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: 'Your balance is $95, due at the next visit.', dbh: throwingDb })).resolves.toBe('reservice_recheck_failed');
        // A pre-deploy queued row (no carries flag) with a body that evades both the detector and the prescreen.
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: 'Someone will pop back by Thursday for the ants.', carriesAction: false, dbh: throwingDb })).resolves.toBe('reservice_recheck_failed');
      });

      test('DB throw on a re-service PROMISE → blocked (fail closed)', async () => {
        loadWith({ lanes: ['pest'] });
        const { scheduledReserviceBlockReason } = require('../services/agent-decision-send-checks');
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: "We'll send your free pest re-service link now.", dbh: throwingDb })).resolves.toBe('reservice_recheck_failed');
      });

      test('decision carrying the action: a missed-promise body is revalidated (blocked when booked, sends when bookable)', async () => {
        const missed = 'We will have someone stop by again for the ants, no cost to you.';
        const row = { customer_id: 'cust-1', prompt_version: 'house_voice_v12_real_answers2', input_snapshot: JSON.stringify({ reservice_lanes_snapshot: ['pest'], intended_actions: [{ type: 'escalate', note: 'send_reservice_link' }] }) };
        loadWith({ lanes: ['pest'], booked: ['pest'] });
        await expect(require('../services/agent-decision-send-checks').scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: missed, dbh: rowDb(row) })).resolves.toMatch(/already booked/);
        loadWith({ lanes: ['pest'] });
        await expect(require('../services/agent-decision-send-checks').scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: missed, dbh: rowDb(row) })).resolves.toBeNull();
      });

      // Codex round-15 P1 #1: a failed decision read never lets an action-carrying decision through.
      test('row read fails: the scheduled row\'s own carries_reservice_link flag blocks a missed-promise body', async () => {
        loadWith({ lanes: ['pest'] });
        const { scheduledReserviceBlockReason } = require('../services/agent-decision-send-checks');
        const missed = 'We will have someone stop by again for the ants, no cost to you.';
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: missed, carriesAction: true, dbh: throwingDb })).resolves.toBe('reservice_recheck_failed');
      });

      test('row read fails, action unknown: FAIL CLOSED whatever the body says (round-19 P1)', async () => {
        loadWith({ lanes: ['pest'] });
        const { scheduledReserviceBlockReason } = require('../services/agent-decision-send-checks');
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: 'We will have someone stop by again for the ants, no cost to you.', dbh: throwingDb })).resolves.toBe('reservice_recheck_failed');
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: 'See you Tuesday at 9!', dbh: throwingDb })).resolves.toBe('reservice_recheck_failed');
      });

      // Codex round-16 P1 #1: a MISSING decision row is not a pre-deploy decision to grandfather.
      test('decision row missing (first() → undefined): fail closed like a failed read, whatever the body says', async () => {
        loadWith({ lanes: ['pest'] });
        const { scheduledReserviceBlockReason } = require('../services/agent-decision-send-checks');
        const missingRowDb = () => ({ where: () => ({ first: async () => undefined }) });
        const missed = 'We will have someone stop by again for the ants, no cost to you.';
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: missed, carriesAction: true, dbh: missingRowDb })).resolves.toBe('reservice_recheck_failed');
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: missed, dbh: missingRowDb })).resolves.toBe('reservice_recheck_failed');
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: "We'll send your free pest re-service link now.", dbh: missingRowDb })).resolves.toBe('reservice_recheck_failed');
        await expect(scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: 'See you Tuesday at 9!', dbh: missingRowDb })).resolves.toBe('reservice_recheck_failed');
      });

      test('/schedule-sms records carries_reservice_link from the decision snapshot', () => {
        const { decisionCarriesReserviceLink } = require('../services/agent-decision-send-checks');
        expect(decisionCarriesReserviceLink({ input_snapshot: JSON.stringify({ intended_actions: [{ type: 'escalate', note: 'send_reservice_link' }] }) })).toBe(true);
        expect(decisionCarriesReserviceLink({ input_snapshot: { intended_actions: [{ type: 'escalate' }] } })).toBe(false);
        expect(decisionCarriesReserviceLink({ input_snapshot: null })).toBe(false);
      });

      test('an ordinary decision (no action) with a non-promise body sends without touching eligibility', async () => {
        const { loadEligibleReserviceLanes } = loadWith({ lanes: [] });
        const row = { customer_id: 'cust-1', prompt_version: 'house_voice_v12_real_answers2', input_snapshot: JSON.stringify({ intended_actions: [] }) };
        await expect(require('../services/agent-decision-send-checks').scheduledReserviceBlockReason({ agentDecisionId: 'd1', outgoingBody: 'See you Tuesday!', dbh: rowDb(row) })).resolves.toBeNull();
        expect(loadEligibleReserviceLanes).not.toHaveBeenCalled();
      });
    });

    // Codex round-15 P1 #2: the pre-deploy set is an explicit list pinned to the exported constant.
    describe('reserviceSnapshotVersionEmitted — explicit identities, pinned to REAL_ANSWERS_PROMPT_VERSION', () => {
      const drafter = () => require('../services/sms-shadow-drafter');

      test('the current real-answers identity (and its category-tagged forms) is snapshot-emitting', () => {
        const { REAL_ANSWERS_PROMPT_VERSION, reserviceSnapshotVersionEmitted } = drafter();
        expect(reserviceSnapshotVersionEmitted(REAL_ANSWERS_PROMPT_VERSION)).toBe(true);
        expect(reserviceSnapshotVersionEmitted(`${REAL_ANSWERS_PROMPT_VERSION}+bc`)).toBe(true);
      });

      test('the pre-deploy identities (missing, v1..v11, PROMPT_VERSION, bare v12) are grandfathered, tagged or not', () => {
        const { PROMPT_VERSION, PRE_DEPLOY_PROMPT_IDENTITIES, reserviceSnapshotVersionEmitted } = drafter();
        expect(PRE_DEPLOY_PROMPT_IDENTITIES).toContain(PROMPT_VERSION);
        expect(PRE_DEPLOY_PROMPT_IDENTITIES).toContain('house_voice_v12_real_answers');
        for (const identity of [null, undefined, '', ...PRE_DEPLOY_PROMPT_IDENTITIES, 'house_voice_v12_real_answers+bc']) {
          expect(reserviceSnapshotVersionEmitted(identity)).toBe(false);
        }
      });

      test('a future or unrecognized identity is never grandfathered', () => {
        const { REAL_ANSWERS_PROMPT_VERSION, PRE_DEPLOY_PROMPT_IDENTITIES, reserviceSnapshotVersionEmitted } = drafter();
        for (const identity of ['house_voice_v12_real_answers3', 'house_voice_v13', 'house_voice_v12_other', 'something_else']) {
          expect(reserviceSnapshotVersionEmitted(identity)).toBe(true);
        }
        // The constant can never appear in the pre-deploy list (a bump that reuses an old identity would fail here).
        expect(PRE_DEPLOY_PROMPT_IDENTITIES).not.toContain(REAL_ANSWERS_PROMPT_VERSION);
      });
    });

    // Codex round-15 P2 #1: an offer split across ADJACENT sentences is one offer.
    test('an offer split across adjacent sentences is validated at draft time (not waved through for an ineligible customer)', () => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
      for (const reply of ["We'll send someone back out. There won't be any charge.", "No charge. We'll come back out."]) {
        expect(validateReserviceOffer({ reply, factsBlock: `X\n${reserviceFactLine([])}\nBILLING:`, inboundMessage: 'still have ants', intendedActions: sendLink }).ok).toBe(false);
        expect(validateReserviceOffer({ reply, factsBlock: `X\n${reserviceFactLine(['pest'])}\nBILLING:`, inboundMessage: 'still have ants', intendedActions: sendLink }).ok).toBe(true);
      }
      // The guard: an estimate price beside a bare visit is not an offer.
      expect(validateReserviceOffer({ reply: 'No charge for the estimate. See you at the visit.', factsBlock: `X\n${reserviceFactLine([])}\nBILLING:` }).ok).toBe(true);
    });

    // Codex round-16 P1 #2: the pest-report prescreen is built lazily from the shared list, never a silent fallback.
    describe('PEST_REPORT_TEXT_RE is built lazily from the shared pest-noun list', () => {
      test('covers the full shared list plus the excluded specialties', () => {
        const { PEST_REPORT_TEXT_RE } = require('../services/sms-shadow-drafter');
        for (const noun of ['ants', 'roaches', 'cockroaches', 'spiders', 'fleas', 'ticks', 'wasps', 'bees', 'hornets', 'silverfish', 'scorpions', 'earwigs', 'centipedes', 'millipedes', 'palmetto bugs', 'bugs', 'pests', 'termites', 'mosquitoes', 'rodents', 'mice', 'rats']) {
          expect(PEST_REPORT_TEXT_RE.test(`${noun} are back`)).toBe(true);
        }
      });

      test('a scheduler mock that omits RESERVICE_PEST_NOUNS_SOURCE throws instead of quietly narrowing the prescreen', () => {
        jest.resetModules();
        jest.doMock('../services/reservice-scheduler', () => ({ reserviceSelfServeEnabled: () => true }));
        const { PEST_REPORT_TEXT_RE } = require('../services/sms-shadow-drafter'); // module load must not need the list
        expect(() => PEST_REPORT_TEXT_RE.test('ants are back')).toThrow(/RESERVICE_PEST_NOUNS_SOURCE/);
        jest.dontMock('../services/reservice-scheduler');
        jest.resetModules();
      });
    });

    // Codex round-16 P2: an action-carrying draft is always validated and gets a snapshot.
    describe('a draft carrying send_reservice_link with wording the detector misses', () => {
      const missed = 'We will have someone stop by again for the ants, no cost to you.';
      const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
      const facts = (lanes) => `X\n${require('../services/sms-shadow-drafter').reserviceFactLine(lanes)}\nBILLING:`;

      test('the phrasing really is one the body detector misses', () => {
        expect(require('../services/sms-shadow-drafter').isReserviceOfferPromise(missed)).toBe(false);
      });

      test('action + pest report + pest bookable → snapshot [pest], and the card is then sendable', async () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        const out = validateReserviceOffer({ reply: missed, factsBlock: facts(['pest']), intendedActions: sendLink, inboundMessage: 'the ants are back' });
        expect(out.ok).toBe(true);
        expect(out.promisedLanes).toEqual(['pest']);
        loadWith({ lanes: ['pest'] });
        const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
        await expect(agentDecisionSendBlockReason({
          decision: { id: 'd1', customer_id: 'cust-1', suggested_message: missed, input_snapshot: JSON.stringify({ reservice_lanes_snapshot: out.promisedLanes, intended_actions: sendLink }), prompt_version: 'house_voice_v12_real_answers2' },
          outgoingBody: missed,
        })).resolves.toBeNull();
      });

      test('no reported lane but a single bookable lane → that lane', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        // (a body naming no lane of its own — the whole-body scan would otherwise read "ants" as pest)
        const out = validateReserviceOffer({ reply: 'We will have someone stop by again, no cost to you.', factsBlock: facts(['lawn']), intendedActions: sendLink, inboundMessage: '' });
        expect(out.ok).toBe(true);
        expect(out.promisedLanes).toEqual(['lawn']);
      });

      test('no derivable lane (two bookable lanes, unresolved report) → rejected, not published', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        const out = validateReserviceOffer({ reply: 'We will have someone stop by again, no cost to you.', factsBlock: facts(['pest', 'lawn']), intendedActions: sendLink, inboundMessage: 'hello' });
        expect(out.ok).toBe(false);
      });

      test('action but the customer is not eligible / reported a different lane → rejected', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        expect(validateReserviceOffer({ reply: missed, factsBlock: facts([]), intendedActions: sendLink, inboundMessage: 'the ants are back' }).ok).toBe(false);
        expect(validateReserviceOffer({ reply: missed, factsBlock: facts(['lawn']), intendedActions: sendLink, inboundMessage: 'the ants are back' }).ok).toBe(false);
      });

      // Codex round-17 P2 #1: an action-backed body the detector misses is classified over the WHOLE body.
      test('send time: a pest card edited to also treat weeds is blocked (lawn not in the pest snapshot); pest wording passes', async () => {
        const edited = "We'll have someone stop by again, then treat your weeds at no cost.";
        const pestWording = 'We will have someone stop by again for the ants, no cost to you.';
        const { drafter } = loadWith({ lanes: ['pest', 'lawn'] });
        const meta = { promptVersion: 'house_voice_v12_real_answers2', draftId: null, intendedActions: sendLink };
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: edited, customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta })).resolves.toMatch(/outside the promised lane/);
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: pestWording, customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta })).resolves.toBeNull();
        // ...and an excluded specialty named anywhere in such a body is blocked too.
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: 'We will have someone stop by again for the termites, no cost to you.', customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta })).resolves.toMatch(/excluded specialty/);
        // A DETECTED promise keeps the offer-span scoping (a lawn word elsewhere never counts).
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: "Your lawn treatment is scheduled, and I'll send your free pest re-service link.", customerId: 'cust-1', promisedLanes: ['pest'], decisionMeta: meta })).resolves.toBeNull();
      });

      test('draft time: an action-only body naming a lane the customer is not eligible for is rejected', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        const out = validateReserviceOffer({ reply: "We'll have someone stop by again, then treat your weeds at no cost.", factsBlock: facts(['pest']), intendedActions: sendLink, inboundMessage: 'the ants are back' });
        expect(out.ok).toBe(false);
      });

      test('no action and a non-promise body is untouched', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        expect(validateReserviceOffer({ reply: missed, factsBlock: facts([]), intendedActions: [], inboundMessage: 'hello' }).ok).toBe(true);
      });
    });

    // Codex round-18 P2 #2 (PR #5336): an eligible pest report whose reply omits the offer is revised, not accepted.
    describe('an eligible pest report must be offered the covered re-service', () => {
      const { reserviceFactLine } = require('../services/sms-shadow-drafter');
      const facts = (lanes, booked) => `X\n${reserviceFactLine(lanes, booked)}\nBILLING:`;
      const report = 'the ants are back again';

      test('reply with no offer and no link action → rejected so it revises', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        const out = validateReserviceOffer({ reply: 'So sorry to hear that.', factsBlock: facts(['pest']), intendedActions: [], inboundMessage: report });
        expect(out.ok).toBe(false);
        expect(out.violations[0]).toMatch(/offer the covered free re-service/);
      });

      test('a model-emitted escalate (reply "" + followup_promised) does NOT satisfy the owed offer (Codex round-20 P2)', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        for (const reply of ['', 'So sorry to hear that.']) {
          for (const intendedActions of [[{ type: 'escalate', note: 'followup_promised' }], [{ type: 'escalate' }]]) {
            const out = validateReserviceOffer({ reply, factsBlock: facts(['pest']), intendedActions, inboundMessage: report });
            expect(out.ok).toBe(false);
            expect(out.violations[0]).toMatch(/offer the covered free re-service/);
          }
        }
        // a plain pest-report intent doesn't suppress it either
        expect(validateReserviceOffer({ reply: '', factsBlock: facts(['pest']), intendedActions: [{ type: 'escalate', note: 'followup_promised' }], inboundMessage: report }).ok).toBe(false);
      });

      // Codex round-20 P2: only the customer's own true hand-off words suppress the offer — never intent, never frustration.
      test('plain frustration and pest wording keep the offer owed; refund/cancel/damage/legal/chemical wording suppresses it', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        const owed = (inboundMessage) => validateReserviceOffer({ reply: 'Sorry.', factsBlock: facts(['pest']), intendedActions: [], inboundMessage }).ok === false;
        for (const m of ['the ants came back', "I'm frustrated, the roaches are back", 'so upset, ants are back again', 'angry and disappointed, the ants are still showing up', "I'm sick of these roaches, they're back", 'sick and tired of the ants coming back', 'the roach poison is not working, they are back']) expect(owed(m)).toBe(true);
        for (const m of ['the ants came back, I want a refund', 'roaches are back, cancel my service', 'ants are back and you charged me twice', 'the ants are back, I am calling my lawyer', 'your spray killed my plants, the ants are back and there is damage', 'ants are back and my dog got sick from the chemical']) expect(owed(m)).toBe(false);
      });

      // Codex round-19 P2: a pronoun-only report ("they're back") from a customer with a pest relationship
      // is a pest report when the facts list the pest lane — the same signal needsOpenTimes uses.
      test('pronoun-only report + pest relationship + pest lane in the facts → offer owed; without either, not', () => {
        const { validateReserviceOffer, pestReportSignal } = require('../services/sms-shadow-drafter');
        const withHistory = { customer: { id: 'cust-1' }, serviceHistory: [{ type: 'General Pest Control' }] };
        const noHistory = { customer: { id: 'cust-1' }, serviceHistory: [] };
        const args = { reply: 'So sorry to hear that.', factsBlock: facts(['pest']), intendedActions: [], inboundMessage: "they're back" };
        const out = validateReserviceOffer({ ...args, context: withHistory });
        expect(out.ok).toBe(false);
        expect(out.violations[0]).toMatch(/offer the covered free re-service/);
        expect(validateReserviceOffer({ ...args, context: noHistory }).ok).toBe(true);
        expect(validateReserviceOffer({ ...args }).ok).toBe(true); // no context at all
        expect(validateReserviceOffer({ ...args, context: withHistory, factsBlock: facts(['lawn']) }).ok).toBe(true);
        expect(validateReserviceOffer({ ...args, context: withHistory, factsBlock: facts([]) }).ok).toBe(true);
        expect(validateReserviceOffer({ ...args, context: withHistory, inboundMessage: 'call me back' }).ok).toBe(true);
        expect(pestReportSignal("they're back", withHistory)).toBe(true);
        expect(pestReportSignal("they're back", noHistory)).toBe(false);
      });

      test('the pronoun report\'s generic offer resolves the pest lane, so it converges', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        const out = validateReserviceOffer({
          reply: "Sorry about that! I'm sending your free re-service booking link now.",
          factsBlock: facts(['pest', 'lawn']),
          intendedActions: [{ type: 'escalate', note: 'send_reservice_link' }],
          inboundMessage: "they're back",
          context: { customer: { id: 'cust-1' }, serviceHistory: [{ type: 'General Pest Control' }] },
        });
        expect(out.ok).toBe(true);
        expect(out.promisedLanes).toEqual(['pest']);
      });

      test('NOT forced when the lane is already booked, not eligible, an escalation hand-off, or not a pest report', () => {
        const { validateReserviceOffer } = require('../services/sms-shadow-drafter');
        expect(validateReserviceOffer({ reply: 'Sorry.', factsBlock: facts([], { pest: { date: '2026-10-05' } }), intendedActions: [], inboundMessage: report }).ok).toBe(true);
        expect(validateReserviceOffer({ reply: 'Sorry.', factsBlock: facts([]), intendedActions: [], inboundMessage: report }).ok).toBe(true);
        // Codex round-20 P2: a MODEL-emitted escalate is not a hand-off — only an independent complaint/intent is.
        expect(validateReserviceOffer({ reply: 'Sorry.', factsBlock: facts(['pest']), intendedActions: [], inboundMessage: 'the ants are back again, I want a refund' }).ok).toBe(true);
        expect(validateReserviceOffer({ reply: 'Sorry.', factsBlock: facts(['pest']), intendedActions: [], inboundMessage: 'the ants are back and I am thinking of cancelling' }).ok).toBe(true);
        expect(validateReserviceOffer({ reply: 'Thanks!', factsBlock: facts(['pest']), intendedActions: [], inboundMessage: 'thanks, no bugs since!' }).ok).toBe(true);
        expect(validateReserviceOffer({ reply: 'Sorry.', factsBlock: facts(['lawn']), intendedActions: [], inboundMessage: report }).ok).toBe(true);
      });
    });

    // Codex round-18 P2 #1: the already-booked callback rides the snapshot and is rechecked at send time.
    describe('an already-booked appointment reference is rechecked at send time', () => {
      const booked = { pest: { date: '2026-10-08', windowStart: '09:00' } };
      const body = 'Your free pest re-service is already scheduled for Thursday.';
      const meta = { promptVersion: 'house_voice_v12_real_answers2', draftId: null, intendedActions: [], bookedCallbacks: booked };
      const state = (drafterLoad) => drafterLoad.drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: meta });

      test('snapshot keeps lane date + window only (no callback id / reschedule url)', () => {
        const { reserviceBookedSnapshot } = require('../services/sms-shadow-drafter');
        expect(reserviceBookedSnapshot({ pest: { date: '2026-10-08', windowStart: '09:00', rescheduleUrl: '/reschedule/x', id: 'abc' }, lawn: {} })).toEqual({ pest: { date: '2026-10-08', windowStart: '09:00' } });
      });

      test('callback cancelled or moved → blocked (reservice_booking_changed); unchanged → sends', async () => {
        const open = (o) => { const d = loadWith({ lanes: ['pest'] }); return d; };
        // still open, same date/window: the mock reports the booked lane as open with only a date, so use a custom loader
        jest.resetModules();
        const mk = (openMap) => {
          jest.resetModules();
          const { RESERVICE_LANE_WORD_PATTERNS, RESERVICE_PEST_NOUNS_SOURCE, reportedReserviceExcludedSpecialty, reportedReserviceLane } = jest.requireActual('../services/reservice-scheduler');
          jest.doMock('../services/reservice-scheduler', () => ({
            reserviceSelfServeEnabled: () => true,
            loadReserviceLaneAvailability: async () => ({ eligible: ['pest'], open: openMap, bookable: openMap.pest ? [] : ['pest'] }),
            RESERVICE_LANE_WORD_PATTERNS, RESERVICE_PEST_NOUNS_SOURCE, reportedReserviceExcludedSpecialty, reportedReserviceLane,
          }));
          return { drafter: require('../services/sms-shadow-drafter') };
        };
        await expect(state(mk({}))).resolves.toMatch(/reservice_booking_changed/);
        await expect(state(mk({ pest: { date: '2026-10-09', windowStart: '09:00' } }))).resolves.toMatch(/reservice_booking_changed/);
        await expect(state(mk({ pest: { date: '2026-10-08', windowStart: '13:00' } }))).resolves.toMatch(/reservice_booking_changed/);
        await expect(state(mk({ pest: { date: '2026-10-08', windowStart: '09:00' } }))).resolves.toBeNull();
        // A body that does not reference the appointment is not held up by it.
        await expect(mk({}).drafter.reservicePromiseStillEligible({ outgoingBody: 'See you soon!', customerId: 'cust-1', promisedLanes: null, decisionMeta: meta })).resolves.toBeNull();
      });

      test('the stored day/date also counts as a reference; through the real send check', async () => {
        const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
        loadWith({ lanes: ['pest'] }); // no open callback at all
        await expect(agentDecisionSendBlockReason({
          decision: { id: 'd1', customer_id: 'cust-1', suggested_message: 'x', input_snapshot: JSON.stringify({ reservice_booked_snapshot: booked, intended_actions: [] }), prompt_version: 'house_voice_v12_real_answers2' },
          outgoingBody: 'We will see you Thursday, October 8.',
        })).resolves.toMatch(/reservice_booking_changed/);
      });
    });

    // Self-audit table (Codex round-10, PR #5336): adversarial promises (punctuation,
    // conjunctions, purpose clauses, new nouns, plurals, waive/comp wording), denials
    // and idioms. [sentence, isPromise, promisedLanes].
    const ADVERSARIAL = [
  ["Your free pest re-service is already scheduled for Thursday.", false, []],
  ["Your complimentary lawn re-service is on the schedule for Friday.", false, []],
  ["Your free re-service is coming up on Tuesday.", false, []],
  ["Your free pest re-service is booked for Thursday, and I'll send a free lawn re-service link.", true, ['lawn']],
  ["We'll get your free pest re-service scheduled for Thursday.", true, ['pest']],

  ["We can't offer a free lawn re-service, but we can send another pest visit, free of charge.", true, ['pest']],
  ["A free visit to treat your lawn.", true, ['lawn']],
  ["We'll send a technician back for a complimentary visit to take care of the ants.", true, ['pest']],
  ["Free inspection of your lawn is on us.", true, ['lawn']],
  ["We'll do a free pest inspection this week.", true, ['pest']],
  ["A complimentary assessment visit for your lawn.", true, ['lawn']],
  ["We can come back and look at it for free.", true, []],
  ["No charge - we'll come back out for the pests.", true, ['pest']],
  ["No charge (we'll come back out to spray the lawn).", true, ['lawn']],
  ["Your free re-service is covered; the link is coming.", true, []],
  ["FREE RE-SERVICE: we will send the link now!", true, []],
  ["We will re-treat your lawn at no cost to you.", true, ['lawn']],
  ["Your callback visit for the roaches is on the house.", true, ['pest']],
  ["Good news!! Free re-service for your lawn AND pests.", true, ['pest', 'lawn']],
  ["We can't offer a refund; however a free pest re-service is yours.", true, ['pest']],
  ["I can't promise a date but the re-service is free.", true, []],
  ["Sorry about that. It's free of charge, we'll send a tech back out to re-spray.", true, []],
  ["We won't charge you for the follow-up treatment on the lawn.", true, ['lawn']],
  ["The revisit is included in your plan.", true, []],
  ["Your re-service is complimentary, and we'll text the link.", true, []],
  ["Can't wait to help - your free pest re-service link is on the way.", true, ['pest']],
  ["We are unable to offer a free lawn re-service, but a complimentary pest re-service is available.", true, ['pest']],
  ["Nope, not a problem: the return trip is free.", true, []],
  ["We'll send a tech out again at no charge to treat your lawn.", true, ['lawn']],
  ["Complimentary follow-up: we'll re-spray for the ants.", true, ['pest']],
  ["There's no charge for us to come back out.", true, []],
  ["We'll gladly re-service the lawn for free.", true, ['lawn']],
  ["Don't worry, this one's on the house - a pest re-service.", true, ['pest']],
  ["We're happy to come back out for free. We can't do it this week though.", true, []],
  ["Free re-service? Yes!", true, []],
  ["We'll waive the charge for the return visit.", true, []],
  ["We will not bill you for the follow-up visit.", true, []],
  ["The re-service will cost you nothing.", true, []],
  ["We'll re-treat the yard for the ants without charge.", true, ['pest']],
  ["We don't do free re-services, sorry.", false, []],
  ["Free re-service isn't something we can do for you.", false, []],
  ["No free re-service this time, sorry.", false, []],
  ["That would not be free, unfortunately: the re-service is billable.", false, []],
  ["We don't give free visits after the warranty period.", false, []],
  ["Feel free to text us any questions about your visit.", false, []],
  ["A pest-free home is our goal when we visit.", false, []],
  ["Waiting on us to schedule the visit? We are on it.", false, []],
  ["It's on us to get the visit on the calendar.", false, []],
  ["We'd love to come back sometime, no pressure.", false, []],
  ["Our free-of-charge estimate is available online.", false, []],
  ["We offer free visits after every treatment.", true, []],
  ["Sorry, we cannot offer free re-services.", false, []],
  ["Free lawn re-service isn't available, but pest visits are complimentary.", true, ['pest']],
  ["Not free: the visit costs $50, but the inspection is free.", true, []],
  ["No charge, no problem - I'll have someone come back out.", true, []],
  ["Your lawn re-service: free. Pest re-service: not eligible.", true, ['lawn']],
  ["Re-service: not free.", false, []],
  ["We can't do a free re-service, but we'd be happy to book a paid visit.", false, []],
  ["A free lawn re-service is not something we can offer.", false, []],
  ["Free? No. We charge for re-services after 30 days.", false, []],
  ["Don't worry, we'll make it right at no cost to you and send someone back out to treat the ants.", true, ['pest']],
  ["It is free. The re-service link is coming.", true, []],
  ["We'll send your free pest re-service link. We can also provide a lawn visit, free of charge.", true, ['pest', 'lawn']],
  ["We'll send your free pest re-service, and a lawn visit, free of charge.", true, ['pest', 'lawn']],
  ["We can't offer a free lawn re-service. Your free pest re-service link is on the way.", true, ['pest']],
  ["Your free pest re-service link is on the way. Sorry, we can't offer a free lawn re-service.", true, ['pest']],
  ["Your lawn treatment is scheduled, and I'll send your free pest re-service link.", true, ['pest']],
  ["Your lawn treatment is scheduled and I'll send your free pest re-service link.", true, ['pest']],
  ["Your lawn is looking great. We'll send your free pest re-service link for the ants.", true, ['pest']],
  ["Sorry about the termites in the shed, your free pest re-service link is on the way.", true, ['pest']],
  ["Your pest re-service is covered; your lawn visit is Tuesday at 9.", true, ['pest']],
  ["We offer a free termite estimate before scheduling service.", false, []],
  ["We offer a free lawn quote before scheduling service.", false, []],
  ["Complimentary pest consultation, then we schedule the visit.", false, []],
  ["No charge for the estimate, and we book the visit after.", false, []],
  ["We'll send your free pest re-service and a free quote.", true, ['pest']],
  ["A free cost assessment comes first, then the treatment visit.", false, []],
  ["There is no additional charge for your scheduled service.", false, []],
  ["No charge for your regular treatment; it is included in your plan.", false, []],
  ["Your next visit is on us, thanks for being a member.", false, []],
  ["The service is included at no cost with your plan.", false, []],
  ["There's no charge for the upcoming visit.", false, []],
  ["Your annual treatment is complimentary with WaveGuard.", false, []],
  ["We'll come back out for another visit at no charge.", true, []],
  ["Another treatment is on the house.", true, []],
  ["We can do a free treatment for the ants.", true, ['pest']],
  ["We can do a complimentary service call.", true, []],
  ["Your regular treatment is complimentary with your plan.", false, []],
  ["We'll send a tech for a no-charge lawn treatment.", true, ['lawn']],
  ["Another lawn treatment at no charge.", true, ['lawn']],
  ["The treatment is free of charge.", true, []],
  ["Your scheduled service is free with your plan.", false, []],
  ["Feel free to call about your service.", false, []],
  ["We offer a free service estimate.", false, []],
  ["We'll send someone back out. There won't be any charge.", true, []],
  ["No charge. We'll come back out.", true, []],
  ["We'll send someone back out for the lawn. It's on us.", true, ['lawn']],
  ["It's free! We'll send a tech back out for the ants.", true, ['pest']],
  ["No charge for the estimate. See you at the visit.", false, []],
  ["No charge for the estimate. We'll come back to you with a quote.", false, []],
  ["We can't come back out this week. There won't be any charge for rescheduling.", false, []],
  ["Your visit is Tuesday. It's free to reschedule.", false, []],
  ["We'll send someone back out. See you Tuesday.", false, []],
  ["Your visit tomorrow is free.", false, []],
  ["There is no charge for your visit on Tuesday.", false, []],
  ["The visit tomorrow is on us.", false, []],
  ["Tuesday's visit is free with your plan.", false, []],
  ["No charge for the visit on Friday at 9.", false, []],
  ["Our visit today is complimentary.", false, []],
  ["Your visit is free; we'll text the booking link now.", true, []],
  ["A complimentary visit is on us.", true, []],
  ["We can send a technician for a free visit.", true, []],
  ["We'll schedule a free visit this week.", true, []],
  ["We can't offer a free lawn re-service.", false, []],
  ["You're not eligible for a free re-service right now.", false, []],
  ["Unfortunately that isn't covered - the re-service is not free.", false, []],
  ["We cannot offer a complimentary visit or a free re-service.", false, []],
  ["Sorry, your plan doesn't include a free lawn re-service.", false, []],
  ["A free inspection isn't included in your plan.", false, []],
  ["There is no longer a free re-service available on your account.", false, []],
  ["Feel free to call us if the ants come back.", false, []],
  ["You're free to reschedule your visit any time.", false, []],
  ["Your balance is $95, due at the next visit.", false, []],
  ["We offer a free estimate for new customers.", false, []],
  ["Feel free to visit our website or come back to the estimate link.", false, []],
  ["Thanks for the review, we hope to visit again soon.", false, []],
  ["Your annual plan includes two treatments this year.", false, []],
  ["You can count on us to come back and take care of it.", false, []],
  ["Is the gate free of dogs on the day of the visit?", false, []],
  ["We'll inspect the property on Tuesday between 9 and 11.", false, []],
  ["Your invoice is covered - here is the payment link.", false, []],
  ["We can't offer a free lawn re-service nor a free pest re-service.", false, []],
  ["Your already scheduled free pest re-service falls on Thursday.", false, []],
  ["The booked complimentary lawn re-service is Tuesday at 9.", false, []],
  ["Your upcoming free pest re-service is confirmed.", false, []],
  ["I'll send your scheduled free pest re-service link now.", true, ['pest']],
  ["Your lawn visit is booked, and I'll send your free pest re-service link.", true, ['pest']],
  ["You are booked Tuesday. Your free pest re-service link is on the way.", true, ['pest']],
  ["We can't offer a free lawn re-service or send your free pest re-service link now.", true, ['pest']],
  ["We can't offer a free lawn re-service or we'll send a free pest re-service.", true, ['pest']],
  ["We can't offer a free lawn re-service, a free pest re-service link is on the way.", true, ['pest']],
  ["We can't offer a free lawn re-service and a free pest re-service is yours.", true, ['pest']],
  ["We can't offer a free lawn re-service but a complimentary pest re-service, yes.", true, ['pest']],
  ["We do not offer a free re-service, a complimentary visit, and your visit is free; link is coming.", true, []]
    ];
    test('the lazy offer-span copies are built from source parts: no greedy {0,60} gap survives (round-19 P1)', () => {
      const { RESERVICE_OFFER_SPAN_RES } = require('../services/sms-shadow-drafter');
      expect(RESERVICE_OFFER_SPAN_RES).toHaveLength(2);
      for (const rx of RESERVICE_OFFER_SPAN_RES) {
        expect(rx.source).toContain('{0,60}?');
        expect(rx.source.replace(/\{0,60\}\?/g, '')).not.toMatch(/\{0,60\}/);
        expect(rx.flags).toContain('g');
      }
    });

    test.each(ADVERSARIAL)('adversarial: %s → promise=%s lanes=%j', (sentence, isPromise, lanes) => {
      const { isReserviceOfferPromise, namedReserviceLanesInText } = require('../services/sms-shadow-drafter');
      expect(isReserviceOfferPromise(sentence)).toBe(isPromise);
      if (isPromise) expect(namedReserviceLanesInText(sentence)).toEqual(lanes);
    });

    // Codex round-9 (PR #5336) P2 #3: pending cards created BEFORE the deploy carry
    // no reservice_lanes_snapshot. Grandfather them on live eligibility; a
    // NEW-version decision missing its snapshot stays fail-closed.
    describe('pre-deploy decisions (no snapshot) are grandfathered on live eligibility', () => {
      const body = "Good news — we'll send your free re-service link now.";
      const sendLinkAction = [{ type: 'escalate', note: 'send_reservice_link' }];
      const predeploy = { id: 'd1', customer_id: 'cust-1', suggested_message: body, input_snapshot: JSON.stringify({ draft_id: null, intended_actions: sendLinkAction }), prompt_version: 'house_voice_v12_real_answers' };
      const newVersion = { ...predeploy, prompt_version: 'house_voice_v12_real_answers2' };

      test('pre-deploy + live-eligible → sends; pre-deploy + ineligible → blocked (both send entry points)', async () => {
        const { drafter } = loadWith({ lanes: ['pest'] });
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers', draftId: null, intendedActions: sendLinkAction } })).resolves.toBeNull();
        const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
        await expect(agentDecisionSendBlockReason({ decision: predeploy, outgoingBody: body })).resolves.toBeNull();
        const ineligible = loadWith({ lanes: [] });
        await expect(ineligible.drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v11', draftId: null, intendedActions: sendLinkAction } })).resolves.toMatch(/no longer eligible/);
        const { agentDecisionSendBlockReason: blockAgain } = require('../services/agent-decision-send-checks');
        await expect(blockAgain({ decision: predeploy, outgoingBody: body })).resolves.toMatch(/re-service promise unsendable/);
      });

      test('a named lane must itself be live-eligible for a pre-deploy decision', async () => {
        const { drafter } = loadWith({ lanes: ['pest'] });
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: 'We can send your free lawn re-service link now.', customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: null, draftId: null, intendedActions: sendLinkAction } })).resolves.toMatch(/no longer eligible for a free lawn re-service/);
      });

      test('recovered draft facts limit which live lane counts when no lane is named', async () => {
        const factsPest = `X\n${require('../services/sms-shadow-drafter').reserviceFactLine(['pest'])}\nBILLING:`;
        const { drafter } = loadWith({ lanes: ['lawn'] }); // only lawn live; the draft facts said pest
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers', factsBlock: factsPest, intendedActions: sendLinkAction } })).resolves.toMatch(/no longer eligible/);
        const ok = loadWith({ lanes: ['pest'] });
        await expect(ok.drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers', factsBlock: factsPest, intendedActions: sendLinkAction } })).resolves.toBeNull();
      });

      // Codex round-19 P2: a grandfathered generic promise revalidates the REPORTED lane, not "any lane".
      test('grandfathered generic promise: the reported lane recovered from the persisted inbound must stay bookable; unrecoverable → EVERY facts lane must', async () => {
        const facts = (lanes) => `X\n${require('../services/sms-shadow-drafter').reserviceFactLine(lanes)}\nBILLING:`;
        const meta = (extra) => ({ promptVersion: 'house_voice_v12_real_answers', intendedActions: sendLinkAction, factsBlock: facts(['pest', 'lawn']), ...extra });
        const withInbound = (inbound) => {
          jest.resetModules();
          jest.doMock('../models/db', () => () => ({ where: () => ({ first: async () => ({ inbound_message: inbound, facts_block: facts(['pest', 'lawn']), intended_actions: sendLinkAction }) }) }));
          return loadWith({ lanes: ['lawn'] }).drafter; // pest cancelled since the draft; lawn still eligible
        };
        // reported lane recovered (pest) → pest cancelled → blocked even though lawn is bookable
        await expect(withInbound('the ants are back').reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers', draftId: 'dr1' } })).resolves.toMatch(/no longer eligible for a free pest re-service/);
        // reported lane NOT recoverable ("they're back") → every fact lane required → pest is gone → blocked
        await expect(withInbound("they're back").reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers', draftId: 'dr1' } })).resolves.toMatch(/no longer eligible for a free pest re-service/);
        jest.dontMock('../models/db');
        // ...and both lanes bookable → sends
        const both = loadWith({ lanes: ['pest', 'lawn'] });
        await expect(both.drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: meta({}) })).resolves.toBeNull();
        // facts lanes given directly (no draft read): pest cancelled → blocked
        const lawnOnly = loadWith({ lanes: ['lawn'] });
        await expect(lawnOnly.drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: meta({}) })).resolves.toMatch(/no longer eligible for a free pest re-service/);
      });

      test('a pre-deploy decision WITHOUT a send_reservice_link action stays blocked, even for an eligible customer (Codex round-10 P2)', async () => {
        const { drafter } = loadWith({ lanes: ['pest'] });
        for (const intendedActions of [[], [{ type: 'escalate' }], [{ type: 'book_appointment' }]]) {
          await expect(drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers', factsBlock: null, intendedActions } })).resolves.toMatch(/no send_reservice_link action on record/);
        }
        const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
        await expect(agentDecisionSendBlockReason({ decision: { ...predeploy, input_snapshot: JSON.stringify({ draft_id: null }) }, outgoingBody: body })).resolves.toMatch(/re-service promise unsendable \(no send_reservice_link action/);
      });

      test('a NEW-version decision missing its snapshot stays fail-closed, even for an eligible customer', async () => {
        const { drafter } = loadWith({ lanes: ['pest'] });
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers2', draftId: null } })).resolves.toMatch(/no promised re-service lane on record/);
        const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
        await expect(agentDecisionSendBlockReason({ decision: newVersion, outgoingBody: body })).resolves.toMatch(/re-service promise unsendable \(no promised re-service lane/);
        // ...and a category-suffixed new version is still "new".
        await expect(drafter.reservicePromiseStillEligible({ outgoingBody: body, customerId: 'cust-1', promisedLanes: null, decisionMeta: { promptVersion: 'house_voice_v12_real_answers2+bc', draftId: null } })).resolves.toMatch(/no promised re-service lane on record/);
      });
    });

    test.each(DENIALS.slice(0, 2))('%s → passes draft validation for an ineligible customer (nothing to validate)', (reply) => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
      expect(validateReserviceOffer({ reply, factsBlock: notEligible, inboundMessage: 'still have ants', intendedActions: [] }).ok).toBe(true);
    });

    // Both send paths (agent-decision-send-checks for the immediate /sms send
    // and the /schedule-sms verification; scheduler.js's queued-send recheck)
    // delegate to reservicePromiseStillEligible, so the ineligible /
    // no-snapshot customer is exercised through it and through the real
    // agentDecisionSendBlockReason.
    test.each(DENIALS)('%s → sends for an ineligible customer with no snapshot (both send paths)', async (outgoingBody) => {
      const { drafter, loadEligibleReserviceLanes } = loadWith({ lanes: [] });
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody, customerId: 'cust-1', promisedLanes: null })).resolves.toBeNull();
      const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
      await expect(agentDecisionSendBlockReason({
        decision: { id: 'd1', customer_id: 'cust-1', suggested_message: outgoingBody, input_snapshot: null, prompt_version: 'older' },
        outgoingBody,
      })).resolves.toBeNull();
      expect(loadEligibleReserviceLanes).not.toHaveBeenCalled();
    });

    // The unrelated-denial promises are checked (not skipped) for an ineligible customer at draft time and send time.
    test.each([
      'We cannot offer a refund but we can provide a free pest re-service.',
      "we can't offer a refund, however a complimentary visit is on us",
    ])('%s → an ineligible customer is NOT waved through (draft + send)', async (reply) => {
      const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
      const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
      expect(validateReserviceOffer({ reply, factsBlock: notEligible, inboundMessage: 'still have ants', intendedActions: [] }).ok).toBe(false);
      const { drafter } = loadWith({ lanes: [] });
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody: reply, customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toMatch(/no longer eligible/);
    });

    test("\"We won't charge you for the visit.\" is still blocked for an ineligible customer (both send paths)", async () => {
      const outgoingBody = "We won't charge you for the visit.";
      const { drafter } = loadWith({ lanes: [] });
      await expect(drafter.reservicePromiseStillEligible({ outgoingBody, customerId: 'cust-1', promisedLanes: ['pest'] })).resolves.toMatch(/no longer eligible/);
      const { agentDecisionSendBlockReason } = require('../services/agent-decision-send-checks');
      await expect(agentDecisionSendBlockReason({
        decision: { id: 'd1', customer_id: 'cust-1', suggested_message: outgoingBody, input_snapshot: JSON.stringify({ reservice_lanes_snapshot: ['pest'] }), prompt_version: 'older' },
        outgoingBody,
      })).resolves.toMatch(/re-service promise unsendable/);
    });

    test('a genuine re-service promise still counts, with each of the specific nouns', () => {
      expect(isReserviceOfferPromise('We will come back out for free.')).toBe(true);
      expect(isReserviceOfferPromise('A complimentary callback visit is on us.')).toBe(true);
      expect(isReserviceOfferPromise('No charge for the follow-up treatment.')).toBe(true);
      expect(isReserviceOfferPromise('We can re-spray at no cost.')).toBe(true);
    });
  });

  // Codex round-6 P1: reservicePromiseStillEligible (and therefore the
  // unconditional send-time check in agent-decision-send-checks.js) is gated
  // entirely on isReserviceOfferPromise — once that detector is narrowed, an
  // ordinary reply naming no re-service promise revalidates to null (nothing
  // to check), even with no snapshot on the decision.
  test('reservicePromiseStillEligible: the estimate-link sentence passes; a real promise still checks', async () => {
    const { reservicePromiseStillEligible } = require('../services/sms-shadow-drafter');
    await expect(reservicePromiseStillEligible({
      outgoingBody: 'Feel free to return to your estimate link anytime.',
      customerId: 'cust-1',
      promisedLanes: null,
    })).resolves.toBeNull();
    // A genuine promise with no eligible lane on record still fails closed.
    await expect(reservicePromiseStillEligible({
      outgoingBody: "Good news — we'll send your free re-service link now.",
      customerId: 'cust-1',
      promisedLanes: null,
    })).resolves.toMatch(/no promised re-service lane/);
  });

  // Codex round-3 P2: "revisit" as an ORDINARY business-admin verb ("revisit
  // your options/the schedule/an estimate") tripped RESERVICE_COVERAGE_RE
  // whenever it landed near "link" — never a promise to send anyone back
  // out. Fixed by requiring "revisit" to have no non-visit administrative
  // object; a bare "revisit" (no object) or one governing a visit/pest-
  // shaped noun still counts (regression coverage for the round-2 fixture
  // that legitimately relies on the bare form).
  describe('isReserviceOfferPromise / RESERVICE_COVERAGE_RE — "revisit" false positives (Codex round-3 P2)', () => {
    const { isReserviceOfferPromise } = require('../services/sms-shadow-drafter');

    test.each([
      'Use the estimate link to revisit your options.',
      'Check your portal link if you would like to revisit your account details.',
      'Log into the portal link to revisit your account history.',
      'We can revisit the schedule next week if that works better.',
      'Feel free to revisit your estimate any time.',
    ])('%s → NOT detected as a re-service promise', (reply) => {
      expect(isReserviceOfferPromise(reply)).toBe(false);
    });

    test('a genuine re-service promise phrased with "revisit" still counts (regression: round-2 fixture)', () => {
      expect(isReserviceOfferPromise('Your revisit is included — the booking link is on its way.')).toBe(true);
    });

    test('"revisit" governing a visit/pest-shaped noun still counts', () => {
      expect(isReserviceOfferPromise('We can schedule a revisit visit for free.')).toBe(true);
      expect(isReserviceOfferPromise('No charge to revisit the property this week.')).toBe(true);
    });

    test('other re-service nouns are unaffected by the "revisit" narrowing', () => {
      expect(isReserviceOfferPromise('Your pest re-service is covered; we will text the link now.')).toBe(true);
      expect(isReserviceOfferPromise('No charge for the re-service — come back out this week.')).toBe(true);
    });
  });
});

// Owner ruling 2026-09-29: a pest report ("pests came back", "still seeing X
// after service") is NOT a complaint for hand-off purposes — the AI offers
// the free re-service itself when eligible, instead of handing off, with
// GATE_SMS_AGENT_COMPLAINTS at its prod default (off).
describe('PEST REPORTS rule — offers the free re-service directly, independent of GATE_SMS_AGENT_COMPLAINTS (owner ruling 2026-09-29)', () => {
  const prior = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    delete process.env.GATE_SMS_AGENT_COMPLAINTS; // prod default: off
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior;
    delete process.env.GATE_SMS_AGENT_COMPLAINTS;
  });

  test('the prompt carries the PEST REPORTS rule with complaints OFF, and still holds real complaints for a person', () => {
    const { buildSystemPrompt } = require('../services/sms-shadow-drafter');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('PEST REPORTS');
    expect(prompt).toContain('are NOT a complaint for hand-off purposes');
    expect(prompt).toContain('Offer a free re-service ONLY when FREE RE-SERVICE in the facts says eligible');
    expect(prompt).toContain('{"type":"escalate","note":"send_reservice_link"}');
    expect(prompt).toContain('NEVER quote OPEN TIMES for a re-service');
    // Real complaints (angry/damage/disputes) still hold while the gate is off.
    expect(prompt).toMatch(/HELD FOR A PERSON: complaints,/);
  });

  // Codex round-1 P2 (a): the precedence between "PEST REPORTS are NOT a
  // complaint" and "HELD FOR A PERSON: complaints" must live IN the rendered
  // bullet the model actually sees, not only in a code comment.
  test('the rendered bullet itself states the tie-break: an actual complaint stays held, pest activity never overrides it', () => {
    const { buildSystemPrompt } = require('../services/sms-shadow-drafter');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('ONLY when it is a plain report of pest activity');
    expect(prompt).toContain('it is HELD FOR A PERSON while that category is still held above');
    expect(prompt).toContain('pest activity never overrides an actual complaint');
  });

  test('not eligible (or the fact is absent): routes to a normal visit via OPEN TIMES, never a free offer', () => {
    const { buildSystemPrompt } = require('../services/sms-shadow-drafter');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('never offer or imply a free visit');
    expect(prompt).toContain('offer 2–3 SPECIFIC times from OPEN TIMES for a normal visit when OPEN TIMES is present');
    expect(prompt).toContain('only when OPEN TIMES is absent');
  });

  test('the FREE RE-SERVICE fact is available to this rule with complaints off', () => {
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    const context = { summary: 'Dana — Quarterly Pest, Venice', upcomingServices: [] };
    expect(buildFactsBlock(context, { reserviceLanes: ['pest'] })).toContain('FREE RE-SERVICE: eligible for pest');
  });

  test('validateReserviceOffer still blocks an ineligible offer with complaints off', () => {
    const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
    const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
    expect(validateReserviceOffer({ reply: 'Good news — we will come back for a free re-service.', factsBlock: notEligible }).ok).toBe(false);
  });
});

// Codex round-1 P2 (b): the availability-fetch predicate (needsOpenTimes)
// must cover the FULL pest-report class the PEST REPORTS bullet names, not
// just the subset SAVE_SALE_TEXT_RE already catches.
describe('PEST_REPORT_TEXT_RE — the pest-report signal for the OPEN TIMES fetch (Codex round-1 P2 (b), widened round 2)', () => {
  const { PEST_REPORT_TEXT_RE, SAVE_SALE_TEXT_RE } = require('../services/sms-shadow-drafter');

  test('matches a pest noun + activity verb anywhere in the text, in either order', () => {
    for (const text of [
      'the ants are back', 'I saw roaches again', 'found more ants again',
      // Codex round 2: the finding's own examples — no fixed "back"/"again"
      // phrasing, still a pest noun + activity verb.
      'the roaches have returned', 'more ants showed up after the treatment',
    ]) {
      expect(PEST_REPORT_TEXT_RE.test(text)).toBe(true);
    }
    // Confirms these really are the GAP this regex closes — SAVE_SALE_TEXT_RE
    // does not catch them on its own.
    expect(SAVE_SALE_TEXT_RE.test('the ants are back')).toBe(false);
    expect(SAVE_SALE_TEXT_RE.test('I saw roaches again')).toBe(false);
    expect(SAVE_SALE_TEXT_RE.test('the roaches have returned')).toBe(false);
    expect(SAVE_SALE_TEXT_RE.test('more ants showed up after the treatment')).toBe(false);
  });

  test('"still seeing spiders" is already covered by SAVE_SALE_TEXT_RE (regression check, not a PEST_REPORT_TEXT_RE match)', () => {
    expect(SAVE_SALE_TEXT_RE.test('still seeing spiders')).toBe(true);
  });

  test('does not match a bare activity word with no pest noun (structural change: "they\'re back"/"it is back again" alone are no longer enough)', () => {
    for (const text of ["they're back", 'it is back again', 'call me back', 'see you again soon', "I'll be back tomorrow", 'talk to you again', 'text me back when you can']) {
      expect(PEST_REPORT_TEXT_RE.test(text)).toBe(false);
    }
  });

  test('does not match a bare pest noun with no activity verb', () => {
    expect(PEST_REPORT_TEXT_RE.test('we have ants under contract')).toBe(false);
  });

  // Documented choice (task spec): a closing/gratitude message that happens
  // to name a pest but carries no activity/sighting verb does not fire —
  // there is nothing to act on, and fetching OPEN TIMES for it would be
  // pointless even though harmless.
  test('negative control: a gratitude close naming a pest but no activity verb does not fire', () => {
    expect(PEST_REPORT_TEXT_RE.test('thanks, no bugs since!')).toBe(false);
  });
});

// Codex round-3 P2: "they're back" — the PEST REPORTS bullet's OWN example —
// names no pest noun at all, so PEST_REPORT_TEXT_RE structurally (and, by
// design per the test above, correctly) does not fire on it alone. This is
// the context-gated branch that closes that specific gap.
describe('PRONOUN_RETURN_TEXT_RE + customerHasPestRelationship — the pronoun-only pest-report signal (Codex round-3 P2)', () => {
  const { PRONOUN_RETURN_TEXT_RE, customerHasPestRelationship } = require('../services/sms-shadow-drafter');

  test('matches bare pronoun/return phrasings with no pest noun', () => {
    for (const text of [
      "they're back", 'it\'s back', 'they came back', 'they come back',
      'they returned', 'back again', 'still there', 'still here',
      "They're Back!",
    ]) {
      expect(PRONOUN_RETURN_TEXT_RE.test(text)).toBe(true);
    }
  });

  test('does not match unrelated "back"/"again" phrasings with no return-of-pests meaning', () => {
    for (const text of ['call me back', "I'll be back tomorrow", 'talk to you again', 'text me back when you can', 'see you again soon']) {
      expect(PRONOUN_RETURN_TEXT_RE.test(text)).toBe(false);
    }
  });

  describe('customerHasPestRelationship', () => {
    test('true for any recurring plan tier on file', () => {
      expect(customerHasPestRelationship({ customer: { tier: 'Gold' } })).toBe(true);
    });

    test('true for a completed pest-family visit in serviceHistory', () => {
      expect(customerHasPestRelationship({ serviceHistory: [{ type: 'General Pest Control' }] })).toBe(true);
      expect(customerHasPestRelationship({ serviceHistory: [{ type: 'WaveGuard Pest' }] })).toBe(true);
    });

    test('false for a rodent/termite/mosquito/tree/shrub-only history with no tier', () => {
      expect(customerHasPestRelationship({ serviceHistory: [{ type: 'Rodent Pest Control' }] })).toBe(false);
      expect(customerHasPestRelationship({ serviceHistory: [{ type: 'Termite Bait Stations' }] })).toBe(false);
      expect(customerHasPestRelationship({ serviceHistory: [{ type: 'Mosquito Misting' }] })).toBe(false);
      expect(customerHasPestRelationship({ serviceHistory: [{ type: 'Tree & Shrub Care' }] })).toBe(false);
    });

    test('false with no history and no tier', () => {
      expect(customerHasPestRelationship({})).toBe(false);
      expect(customerHasPestRelationship(null)).toBe(false);
      expect(customerHasPestRelationship({ serviceHistory: [] })).toBe(false);
    });
  });
});

describe('round-7 deterministic guards (gate on)', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
  });
  const drafter = require('../services/sms-shadow-drafter');

  test('validateComplianceCopy: banned claims are violations; the sanctioned idiom with technician-confirms-timing is not; gate off does not run', () => {
    for (const reply of ['The product is pet-safe.', 'It is EPA-approved.', 'You can re-enter after 30 minutes.', 'It is completely safe.']) {
      expect(drafter.validateComplianceCopy({ reply }).ok).toBe(false);
    }
    expect(drafter.validateComplianceCopy({ reply: 'It is safe once dry, and your technician will confirm the timing.' }).ok).toBe(true);
    // Codex r8 P1: only the EXACT standalone idiom is exempt — a compound prefix or a timing modifier is still screened
    expect(drafter.validateComplianceCopy({ reply: 'It is pet-safe once dry; our technician will confirm timing.' }).ok).toBe(false);
    expect(drafter.validateComplianceCopy({ reply: 'It is safe once dry in 30 minutes; our technician will confirm the timing.' }).ok).toBe(false);
    expect(drafter.validateComplianceCopy({ reply: 'Kids-safe once dry — we will confirm the timing.' }).ok).toBe(false);
    expect(drafter.validateComplianceCopy({ reply: 'It is safe once dry — about 45 minutes — and we confirm the timing.' }).ok).toBe(false);
    expect(drafter.validateComplianceCopy({ reply: 'Thanks for reaching out — a manager will follow up within the hour.' }).ok).toBe(true);
    expect(drafter.validateComplianceCopy({ reply: '' }).ok).toBe(true);
    delete process.env.GATE_SMS_REAL_ANSWERS;
    expect(drafter.validateComplianceCopy({ reply: 'The product is pet-safe.' }).ok).toBe(true);
  });

  test('validateReserviceOffer is per service line: a pest-only customer is not offered a free LAWN re-service', () => {
    const pestOnly = `X\n${drafter.reserviceFactLine(['pest'])}\nBILLING:`;
    const both = `X\n${drafter.reserviceFactLine(['pest', 'lawn'])}\nBILLING:`;
    const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
    expect(drafter.validateReserviceOffer({ reply: 'We can come back for a free lawn re-service.', factsBlock: pestOnly, intendedActions: sendLink }).ok).toBe(false);
    expect(drafter.validateReserviceOffer({ reply: 'We can come back for a free pest re-service.', factsBlock: pestOnly, intendedActions: sendLink }).ok).toBe(true);
    // No line named in the reply: the reported lane is resolved from the
    // inbound text instead (Codex round-1 P2 (d)) — still passes when it
    // resolves to the eligible lane.
    expect(drafter.validateReserviceOffer({ reply: 'We can come back for a free re-service.', factsBlock: pestOnly, inboundMessage: 'still have ants', intendedActions: sendLink }).ok).toBe(true);
    expect(drafter.validateReserviceOffer({ reply: 'We can come back for a free lawn re-service.', factsBlock: both, intendedActions: sendLink }).ok).toBe(true);
  });

  // Codex round-6 P1: namedReserviceLanesInText used to know only bare
  // "pest" and "lawn|turf|grass" — a reply naming a broader lawn word like
  // "weed-treatment" named NO lane at all under the old list, even though
  // reportedReserviceLane (the inbound-report classifier) already recognized
  // it as lawn. Both now share reservice-scheduler's RESERVICE_LANE_WORD_
  // PATTERNS, so the reply-side check agrees.
  test('validateReserviceOffer: a reply naming the broader lawn vocabulary ("weed-treatment") resolves to the lawn lane', () => {
    const pestOnly = `X\n${drafter.reserviceFactLine(['pest'])}\nBILLING:`;
    const lawnEligible = `X\n${drafter.reserviceFactLine(['lawn'])}\nBILLING:`;
    const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
    expect(drafter.validateReserviceOffer({
      reply: 'Good news — free weed-treatment re-service link is on its way.', factsBlock: lawnEligible, intendedActions: sendLink,
    }).ok).toBe(true);
    // Not eligible for lawn: caught, exactly as a bare "lawn" reply would be.
    expect(drafter.validateReserviceOffer({
      reply: 'Good news — free weed-treatment re-service link is on its way.', factsBlock: pestOnly, intendedActions: sendLink,
    }).ok).toBe(false);
  });

  // Codex round-7 (PR #5336) P2 #2: the lane is read from the re-service
  // PROMISE clause, not every lane word in the reply — "yard" in the
  // acknowledgement is a location, not a lawn offer.
  test('validateReserviceOffer: an acknowledgement naming "yard" does not turn a pest promise into a pest+lawn one', () => {
    const pestOnly = `X\n${drafter.reserviceFactLine(['pest'])}\nBILLING:`;
    const lawnOnly = `X\n${drafter.reserviceFactLine(['lawn'])}\nBILLING:`;
    const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
    const reply = "Sorry the ants are back in your yard. Your free pest re-service is covered; we'll text the link now.";
    const ok = drafter.validateReserviceOffer({ reply, factsBlock: pestOnly, inboundMessage: 'ants are back in the yard', intendedActions: sendLink });
    expect(ok.ok).toBe(true);
    expect(ok.promisedLanes).toEqual(['pest']);
    // ...and a lawn-only customer is still refused a PEST promise by that same clause.
    expect(drafter.validateReserviceOffer({ reply, factsBlock: lawnOnly, intendedActions: sendLink }).ok).toBe(false);
  });

  test('validateReserviceOffer: "free lawn re-service" still names lawn; a promise clause naming an excluded specialty is rejected', () => {
    const both = `X\n${drafter.reserviceFactLine(['pest', 'lawn'])}\nBILLING:`;
    const sendLink = [{ type: 'escalate', note: 'send_reservice_link' }];
    const lawn = drafter.validateReserviceOffer({ reply: 'Sorry about the ants. We can come back for a free lawn re-service.', factsBlock: both, intendedActions: sendLink });
    expect(lawn.ok).toBe(true);
    expect(lawn.promisedLanes).toEqual(['lawn']);
    const termite = drafter.validateReserviceOffer({ reply: "We'll send your free termite re-service link.", factsBlock: both, intendedActions: sendLink });
    expect(termite.ok).toBe(false);
    expect(termite.violations.join(' ')).toMatch(/excluded specialty/);
  });

  test('replyQuotesUngroundedAmount: a FAILED or pending payment does not back "your payment went through"', () => {
    const failed = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95, status: 'failed' }] } };
    const pending = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95, status: 'pending' }] } };
    const paid = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95, status: 'paid' }] } };
    expect(drafter.replyQuotesUngroundedAmount('Your $95 payment went through — thank you!', failed)).toBe(true);
    expect(drafter.replyQuotesUngroundedAmount('We received your $95 payment.', pending)).toBe(true);
    expect(drafter.replyQuotesUngroundedAmount('We received your $95 payment.', paid)).toBe(false);
  });
});


describe('follow-up #1: an edited follow-up promise with unrecognized timing is unsendable', () => {
  const { followupPromiseEdited, followupPromiseBlockReason } = require('../services/sms-followup-sla');
  const promised = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };
  const DAY = new Date('2026-09-29T14:00:00Z'); // 10:00 ET
  const NIGHT = new Date('2026-09-30T01:00:00Z'); // 21:00 ET
  const original = 'Sorry about that — someone will follow up within the hour.';

  test('the drafted phrase edited into "within 60 minutes" → edited (the promise stayed, the timing left the phrase list)', () => {
    expect(followupPromiseEdited({ inputSnapshot: promised, originalBody: original, body: 'Sorry about that — someone will follow up within 60 minutes.' })).toBe(true);
    expect(followupPromiseBlockReason({ inputSnapshot: promised, originalBody: original, body: 'Sorry about that — someone will follow up within 60 minutes.', now: DAY })).toBe('sla_phrase_edited');
  });
  test('kept verbatim → not edited; unrelated wording edits → not edited; stale beats edited', () => {
    expect(followupPromiseEdited({ inputSnapshot: promised, originalBody: original, body: original })).toBe(false);
    expect(followupPromiseEdited({ inputSnapshot: promised, originalBody: original, body: 'So sorry about that — someone will follow up within the hour. Thank you!' })).toBe(false);
    expect(followupPromiseBlockReason({ inputSnapshot: promised, originalBody: original, body: original, now: DAY })).toBeNull();
    expect(followupPromiseBlockReason({ inputSnapshot: promised, originalBody: original, body: original, now: NIGHT })).toBe('sla_phrase_stale');
  });
  test('no recorded promise, or no original body known → never edited', () => {
    expect(followupPromiseEdited({ inputSnapshot: { intended_actions: [] }, originalBody: original, body: 'within 60 minutes' })).toBe(false);
    expect(followupPromiseEdited({ inputSnapshot: promised, originalBody: null, body: 'within 60 minutes' })).toBe(false);
  });
});

describe('service identity: the model picks the job the OPEN TIMES are sized for (owner 2026-09-28)', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  const CATALOG = [
    { service_key: 'termite_bait', name: 'Termite Bait Station System Service' },
    { service_key: 'termite_liquid', name: 'Termite Liquid Treatment Service' },
    { service_key: 'flea_tick', name: 'Flea Control Service' },
  ];
  let dispatch;
  let getAvailableSlots;
  beforeEach(() => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    jest.resetModules();
    dispatch = jest.fn();
    getAvailableSlots = jest.fn(async () => ({ days: [] }));
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: jest.fn(async () => CATALOG) }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    // only the identity lane is stubbed; any other dispatch keeps its real path
    jest.doMock('../services/llm/call', () => {
      const actual = jest.requireActual('../services/llm/call');
      return { ...actual, dispatchWithFallback: (policy, payload, options) => (payload?.laneId === 'sms_service_identity' ? dispatch(policy, payload, options) : actual.dispatchWithFallback(policy, payload, options)) };
    });
  });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    jest.dontMock('../services/call-booking-catalog'); jest.dontMock('../services/availability'); jest.dontMock('../services/llm/call'); jest.dontMock('../services/call-booking-catalog');
    jest.resetModules();
  });
  const answer = (json) => dispatch.mockResolvedValueOnce({ ok: true, json });
  const none = () => answer({ about: 'none', visit: null, service: null });
  const client = { messages: { create: async () => ({ content: [{ text: JSON.stringify({ reply: 'Let me check and get right back to you.', intended_actions: [], missing_info: null }) }] }) } };
  const draft = (drafter, inboundMessage, context, extra = {}) => drafter.generateGroundedDraft({
    client, context: { summary: 'x', customer: { id: 'c1' }, ...context }, inboundMessage, intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: true, city: 'Venice', ...extra,
  });
  const bait = { upcomingServices: [{ type: 'Termite Bait Station System Service', date: '2026-10-01' }] };
  const lastLookup = () => getAvailableSlots.mock.calls[getAvailableSlots.mock.calls.length - 1];

  test('the model is offered only the customer\'s visits, their open estimate and the bookable catalog, on the fastStructured policy', async () => {
    answer({ about: 'unclear', visit: null, service: null });
    const drafter = require('../services/sms-shadow-drafter');
    const MODELS = require('../config/models');
    await draft(drafter, 'Can you add liquid termite treatment Tuesday?', { ...bait, serviceHistory: [{ type: 'Quarterly Pest Control Service', date: '2026-09-01' }] }, { openEstimate: { id: 'est-9', service: 'Mosquito Control' } });
    const [policy, payload] = dispatch.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.fastStructured);
    expect(payload).toMatchObject({ laneId: 'sms_service_identity', jsonMode: true });
    expect(payload.text).toContain('V1: Termite Bait Station System Service (scheduled');
    expect(payload.text).toContain('C1: Quarterly Pest Control Service (completed');
    expect(payload.text).toContain('Their open estimate: Mosquito Control');
    expect(payload.text).toContain('termite_liquid: Termite Liquid Treatment Service');
    expect(payload.jsonSchema.properties.visit.enum).toEqual(['V1', 'C1', null]);
    expect(payload.jsonSchema.properties.service.enum).toEqual(['termite_bait', 'termite_liquid', 'flea_tick', null]);
    expect(payload.jsonSchema.properties.about.enum).toEqual(['visit', 'estimate', 'new_service', 'none', 'unclear']);
    // no open estimate → "estimate" is not an answer the provider can give
    answer({ about: 'unclear', visit: null, service: null });
    await draft(drafter, 'Can you add liquid termite treatment Tuesday?', bait);
    expect(dispatch.mock.calls[1][1].jsonSchema.properties.about.enum).toEqual(['visit', 'new_service', 'none', 'unclear']);
    // a brand-new customer with a catalog that failed open: nothing to pick,
    // so neither option property is sent (no bare null-typed property)
    CATALOG.length = 0;
    try {
      none();
      await draft(drafter, 'Can you come Tuesday?', { upcomingServices: [], serviceHistory: [] });
      const schema = dispatch.mock.calls[2][1].jsonSchema;
      expect(schema.required).toEqual(['about']);
      expect(Object.keys(schema.properties)).toEqual(['about']);
      expect(schema.properties.about.enum).toEqual(['none', 'unclear']);
      expect(lastLookup()[2].serviceType).toBeUndefined(); // "none" → the engine default, times offered
    } finally {
      CATALOG.push({ service_key: 'termite_bait', name: 'Termite Bait Station System Service' }, { service_key: 'termite_liquid', name: 'Termite Liquid Treatment Service' }, { service_key: 'flea_tick', name: 'Flea Control Service' });
    }
  });

  test('a picked visit or catalog service prices the lookup; a named treatment beside a same-family visit is new work', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    answer({ about: 'new_service', visit: null, service: 'termite_liquid' });
    await draft(drafter, 'Can you add liquid termite treatment Tuesday?', bait);
    expect(lastLookup()).toEqual(['Venice', null, expect.objectContaining({ serviceType: 'Termite Liquid Treatment Service' })]);
    answer({ about: 'visit', visit: 'V1', service: null });
    await draft(drafter, 'Can we move my termite visit to Friday?', bait);
    expect(lastLookup()).toEqual(['Venice', null, expect.objectContaining({ serviceType: 'Termite Bait Station System Service' })]);
  });

  test('unclear, an option it was never offered, a failed call or a thrown error all WITHHOLD OPEN TIMES', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    answer({ about: 'unclear', visit: null, service: null });
    answer({ about: 'visit', visit: 'V7', service: null }); // no V7 was offered
    answer({ about: 'new_service', visit: null, service: 'palm_injection' }); // not in the bookable catalog
    dispatch.mockResolvedValueOnce({ ok: false, reason: 'openai_timeout' });
    dispatch.mockRejectedValueOnce(new Error('boom'));
    for (let i = 0; i < 5; i += 1) {
      const r = await draft(drafter, 'The mosquitoes came back, but can you add lawn service Tuesday?', bait);
      expect(r.factsBlock).not.toContain('OPEN TIMES (real');
    }
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('"none" keeps the rule from before: the one upcoming visit, several withheld, the last completed visit, then the engine default', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    none(); await draft(drafter, 'When can you come?', bait);
    expect(lastLookup()).toEqual(['Venice', null, expect.objectContaining({ serviceType: 'Termite Bait Station System Service' })]);
    getAvailableSlots.mockClear();
    none(); await draft(drafter, 'When can you come?', { upcomingServices: [...bait.upcomingServices, { type: 'Flea Control Service', date: '2026-10-02' }] });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    none(); await draft(drafter, 'When can you come back?', { upcomingServices: [], serviceHistory: [{ type: 'Quarterly Pest Control Service', date: '2026-09-01' }] });
    expect(lastLookup()).toEqual(['Venice', null, expect.objectContaining({ serviceType: 'Quarterly Pest Control Service' })]);
    none(); await draft(drafter, 'When can you come?', { upcomingServices: [], serviceHistory: [] });
    expect(lastLookup()[2].serviceType).toBeUndefined();
  });

  test('an open estimate prices the lookup when the model picks it, or when nothing is named and no visit is upcoming; a named service never falls to it', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    const openEstimate = { id: 'est-9', service: 'Mosquito Control' };
    answer({ about: 'estimate', visit: null, service: null });
    await draft(drafter, 'Sounds good, can we do Tuesday?', bait, { openEstimate });
    expect(lastLookup()[1]).toBe('est-9');
    none(); await draft(drafter, 'Tuesday works', { upcomingServices: [] }, { openEstimate });
    expect(lastLookup()[1]).toBe('est-9');
    none(); await draft(drafter, 'Tuesday works', bait, { openEstimate }); // an upcoming visit is the job, not the estimate
    expect(lastLookup()).toEqual(['Venice', null, expect.objectContaining({ serviceType: 'Termite Bait Station System Service' })]);
    answer({ about: 'new_service', visit: null, service: 'flea_tick' });
    await draft(drafter, 'Can you add flea treatment Tuesday?', { upcomingServices: [] }, { openEstimate });
    expect(lastLookup()).toEqual(['Venice', null, expect.objectContaining({ serviceType: 'Flea Control Service' })]);
  });

  test('no model call with the gate off, on a frozen replay, with no city to look up, or when the message is linked to an estimate', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    await draft(drafter, 'Can you come Tuesday?', bait, { estimateId: 'est-1' });
    expect(lastLookup()[1]).toBe('est-1');
    await draft(drafter, 'Can you come Tuesday?', bait, { factsBlock: 'FROZEN\nFOLLOW-UP SLA RIGHT NOW: within the hour\n' });
    await draft(drafter, 'Can you come Tuesday?', bait, { city: null }); // the backfill lane passes no city
    process.env.GATE_SMS_REAL_ANSWERS = 'false';
    await draft(drafter, 'Can you come Tuesday?', bait);
    expect(dispatch).not.toHaveBeenCalled();
  });
});


describe('follow-up #7: the promised deadline is pinned by phrase + draft time, not just the window', () => {
  const { followupDeadline, followupDeadlinePassed, followupPromiseBlockReason } = require('../services/sms-followup-sla');
  const promised = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };
  const MON_NIGHT = new Date('2026-09-29T01:30:00Z'); // Mon Sep 28 21:30 ET
  const TUE_NIGHT = new Date('2026-09-30T01:30:00Z'); // Tue Sep 29 21:30 ET
  const TUE_8AM = new Date('2026-09-29T12:00:00Z');  // Tue 08:00 ET
  const MON_10AM = new Date('2026-09-28T14:00:00Z'); // Mon 10:00 ET

  test('deadlines: within the hour → +60 min; by 9 AM tomorrow → next ET 9:00; by 9 AM this morning → same ET 9:00', () => {
    expect(followupDeadline('within the hour', MON_10AM).toISOString()).toBe('2026-09-28T15:00:00.000Z');
    expect(followupDeadline('by 9 AM tomorrow morning', MON_NIGHT).toISOString()).toBe('2026-09-29T13:00:00.000Z'); // Tue 09:00 EDT
    expect(followupDeadline('by 9 AM this morning', new Date('2026-09-29T10:00:00Z')).toISOString()).toBe('2026-09-29T13:00:00.000Z');
    expect(followupDeadline('anything else', MON_10AM)).toBeNull();
    expect(followupDeadline('within the hour', 'not a date')).toBeNull();
  });

  test('"by 9 AM tomorrow morning" drafted Monday night, sent Tuesday night → deadline passed (the window alone would call it current)', () => {
    const body = 'A manager will reach out by 9 AM tomorrow morning.';
    expect(followupDeadlinePassed({ body, draftedAt: MON_NIGHT, now: TUE_NIGHT })).toBe(true);
    expect(followupDeadlinePassed({ body, draftedAt: MON_NIGHT, now: TUE_8AM })).toBe(false);
    expect(followupPromiseBlockReason({ inputSnapshot: promised, body, draftedAt: MON_NIGHT, now: TUE_NIGHT })).toBe('sla_deadline_passed');
    // before the deadline the window rule still speaks: at 8 AM "tomorrow morning" is no longer the current phrase
    expect(followupPromiseBlockReason({ inputSnapshot: promised, body, draftedAt: MON_NIGHT, now: TUE_8AM })).toBe('sla_phrase_stale');
    // same night it was drafted, inside its window → sendable
    expect(followupPromiseBlockReason({ inputSnapshot: promised, body, draftedAt: MON_NIGHT, now: new Date('2026-09-29T02:00:00Z') })).toBeNull();
  });

  test('"within the hour" drafted at 10 AM and sent two hours later → passed; no draft time known → the window rule alone applies', () => {
    const body = 'Someone will follow up within the hour.';
    expect(followupPromiseBlockReason({ inputSnapshot: promised, body, draftedAt: MON_10AM, now: new Date('2026-09-28T16:30:00Z') })).toBe('sla_deadline_passed');
    expect(followupPromiseBlockReason({ inputSnapshot: promised, body, draftedAt: MON_10AM, now: new Date('2026-09-28T14:30:00Z') })).toBeNull();
    expect(followupPromiseBlockReason({ inputSnapshot: promised, body, draftedAt: null, now: new Date('2026-09-28T16:30:00Z') })).toBeNull();
  });
});


// Codex #5194 P2 ("Timestamp the SLA when its facts are generated"): the
// phrase a draft carries is rendered off the instant the facts block was
// built, not the agent_decisions row's created_at (which lands after the
// whole draft→verify→revise loop). slaDraftedAt is the one shared helper
// both send seams (agent-decision-send-checks.js, scheduler.js) call to
// resolve which instant anchors the deadline.
describe('slaDraftedAt: anchors the SLA deadline to facts_generated_at, falling back to created_at', () => {
  const { slaDraftedAt, followupPromiseBlockReason } = require('../services/sms-followup-sla');
  const promised = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };

  test('a facts timestamp before the 8 PM boundary, with created_at drifted past the SAME boundary a day later, anchors on the facts time', () => {
    // Facts built Monday 8:01 PM ET (hour 20) — the drafter renders "by 9 AM
    // tomorrow morning" (Tuesday 9 AM) from THIS instant. An abnormally slow
    // verify/revise loop (retries, provider latency) doesn't finish until
    // Tuesday 8:30 PM ET — past the SAME 8 PM boundary a full day later.
    const factsGeneratedAt = '2026-09-29T00:01:00.000Z'; // Mon 2026-09-28 20:01 ET
    const createdAt = new Date('2026-09-30T00:30:00.000Z'); // Tue 2026-09-29 20:30 ET
    const decision = { input_snapshot: JSON.stringify({ facts_generated_at: factsGeneratedAt }), created_at: createdAt };

    expect(slaDraftedAt(decision).toISOString()).toBe(new Date(factsGeneratedAt).toISOString());

    const body = 'A manager will reach out by 9 AM tomorrow morning.';
    // Checked 5 minutes after the row was finally written: Tuesday 8:35 PM
    // ET. The window rule alone reads this as CURRENT (it's evening again,
    // so "tomorrow morning" is once more the live phrase) — only the pinned
    // deadline can catch that the ORIGINAL Tuesday 9 AM promise is now over
    // 11 hours late.
    const now = new Date('2026-09-30T00:35:00.000Z'); // Tue 2026-09-29 20:35 ET
    expect(followupPromiseBlockReason({
      inputSnapshot: promised, body, draftedAt: slaDraftedAt(decision), now,
    })).toBe('sla_deadline_passed');
    // The BUG this fixes: anchoring on the stale created_at instead re-reads
    // the boundary check a day later, rolling "tomorrow morning" out to
    // WEDNESDAY 9 AM — not yet passed — and the window-only check also
    // reads the phrase as current, so the very same send-check would
    // wrongly wave the day-late promise through.
    expect(followupPromiseBlockReason({
      inputSnapshot: promised, body, draftedAt: createdAt, now,
    })).toBeNull();
  });

  test('a legacy row with no facts_generated_at falls back to created_at', () => {
    const createdAt = new Date('2026-09-28T14:00:00.000Z');
    expect(slaDraftedAt({ input_snapshot: JSON.stringify({ sms: { body: 'hi' } }), created_at: createdAt })).toBe(createdAt);
    expect(slaDraftedAt({ input_snapshot: null, created_at: createdAt })).toBe(createdAt);
    expect(slaDraftedAt({ created_at: createdAt })).toBe(createdAt);
  });

  test('an invalid or garbage facts_generated_at falls back to created_at', () => {
    const createdAt = new Date('2026-09-28T14:00:00.000Z');
    expect(slaDraftedAt({ input_snapshot: JSON.stringify({ facts_generated_at: 'not-a-date' }), created_at: createdAt })).toBe(createdAt);
    expect(slaDraftedAt({ input_snapshot: JSON.stringify({ facts_generated_at: 12345 }), created_at: createdAt })).toBe(createdAt);
    expect(slaDraftedAt({ input_snapshot: JSON.stringify({ facts_generated_at: '' }), created_at: createdAt })).toBe(createdAt);
    expect(slaDraftedAt({ input_snapshot: '{not json', created_at: createdAt })).toBe(createdAt);
  });

  test('input_snapshot may already be a parsed object (not every caller stores JSON text)', () => {
    const createdAt = new Date('2026-09-28T14:00:00.000Z');
    const factsGeneratedAt = '2026-09-28T13:00:00.000Z';
    expect(slaDraftedAt({ input_snapshot: { facts_generated_at: factsGeneratedAt }, created_at: createdAt }).toISOString())
      .toBe(new Date(factsGeneratedAt).toISOString());
  });
});


describe('#5194 review rounds', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; jest.resetModules(); });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
    jest.resetModules();
  });

  test('the deadline for "by 9 AM tomorrow morning" on a row inserted after midnight is that row\'s own 9 AM, not a day later', () => {
    const { followupDeadline } = require('../services/sms-followup-sla');
    // drafted 23:58 ET Monday, row inserted 00:02 ET Tuesday (= 04:02Z) → Tuesday 9 AM
    expect(followupDeadline('by 9 AM tomorrow morning', new Date('2026-09-29T04:02:00Z')).toISOString()).toBe('2026-09-29T13:00:00.000Z');
    // drafted and inserted 21:30 ET Monday → Tuesday 9 AM (unchanged)
    expect(followupDeadline('by 9 AM tomorrow morning', new Date('2026-09-29T01:30:00Z')).toISOString()).toBe('2026-09-29T13:00:00.000Z');
  });

  test('amount guard: an unparseable priced clause cannot ride along with a grounded figure ("balance is $95, and the fee is fifty dollars")', () => {
    const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
    const context = { billing: { outstandingBalance: 95, recentPayments: [] } };
    expect(replyQuotesUngroundedAmount('Your balance is $95, and the fee is fifty dollars.', context)).toBe(true);
    expect(replyQuotesUngroundedAmount('Your balance is $95.', context)).toBe(false);
    // r8 P1: the same clause — a readable figure cannot carry an unreadable one
    expect(replyQuotesUngroundedAmount('Your balance is $95 plus a fee of fifty dollars.', context)).toBe(true);
    expect(replyQuotesUngroundedAmount('Your balance is $95 and the fee is 45.', context)).toBe(true);
  });

  test('SLA edit: the deadline follows the ORIGINAL promise — "tomorrow morning" edited to the now-current "this morning" before 9 AM still sends', () => {
    const { followupPromiseBlockReason } = require('../services/sms-followup-sla');
    const promised = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };
    const original = 'A manager will reach out by 9 AM tomorrow morning.';
    const edited = 'A manager will reach out by 9 AM this morning.';
    const MON_NIGHT = new Date('2026-09-29T01:30:00Z');
    expect(followupPromiseBlockReason({ inputSnapshot: promised, originalBody: original, body: edited, draftedAt: MON_NIGHT, now: new Date('2026-09-29T11:30:00Z') })).toBeNull(); // Tue 07:30 ET
    expect(followupPromiseBlockReason({ inputSnapshot: promised, originalBody: original, body: edited, draftedAt: MON_NIGHT, now: new Date('2026-09-29T14:00:00Z') })).toBe('sla_deadline_passed'); // Tue 10:00 ET
  });

  test('billingAmountCents is the one definition of the owed and paid figures both amount guards use', () => {
    const { billingAmountCents } = require('../services/sms-shadow-drafter');
    const context = { billing: { outstandingBalance: 0, openInvoice: { amountDue: 45.5 }, recentPayments: [{ amount: 95, status: 'paid' }, { amount: 60, status: 'failed' }, { amount: null }] } };
    const { owed, paid } = billingAmountCents(context);
    expect([...owed]).toEqual([4550]); // a zero balance is not owed; the open invoice is
    expect([...paid].sort((a, b) => a - b)).toEqual([6000, 9500]);
    expect([...billingAmountCents(context, { settledOnly: true }).paid]).toEqual([9500]);
    expect(billingAmountCents(null)).toEqual({ owed: new Set(), paid: new Set() });
  });
});
