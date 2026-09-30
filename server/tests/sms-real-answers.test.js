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

  // Codex round-18 P1: the `via <tender>` suffix on Recent payments is a v12-only rendering (its prompt
  // rule is gated), so gate-off facts with a payment row of KNOWN tender must equal main's rendering
  // (pinned here: "<amount> <status> <date>", no suffix).
  test('Recent payments has NO "via <tender>" suffix gate-off, even for rows with a known tender (v11 facts unchanged)', () => {
    const context = {
      summary: 'Test customer',
      billing: {
        outstandingBalance: 0,
        recentPayments: [
          { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' },
          { amount: 45, status: 'processing', payment_date: '2026-09-10', description: 'Invoice INV-9 — zelle' },
        ],
      },
    };
    clearGates();
    const off = buildFactsBlock(context);
    expect(off.split('\n').filter((l) => l.startsWith('- Recent payments:'))).toEqual([
      '- Recent payments: $120.00 paid Saturday, Sep 12; $45.00 processing Thursday, Sep 10',
    ]);
    expect(off).not.toMatch(/ via (?:card|Zelle|bank)/);
    process.env[GATE] = 'false';
    expect(buildFactsBlock(context)).toBe(off);
    // gate on: the suffix (and its paired prompt rule) appear
    process.env[GATE] = 'true';
    expect(buildFactsBlock(context, { now: new Date('2026-09-29T15:00:00Z') }))
      .toContain('- Recent payments: $120.00 paid Saturday, Sep 12 via card; $45.00 processing Thursday, Sep 10 via Zelle');
  });

  // Codex round-16 P1: a partial refund keeps payments.status = 'paid'; gate-on facts render it, gate-off is unchanged.
  test('partially refunded row: gate-on renders the refund, gate-off stays byte-identical to v11', () => {
    const context = {
      summary: 'Test customer',
      billing: { outstandingBalance: 0, recentPayments: [{ amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card', refund_status: 'partial', refund_amount: 30 }] },
    };
    clearGates();
    expect(buildFactsBlock(context).split('\n').filter((l) => l.startsWith('- Recent payments:'))).toEqual(['- Recent payments: $120.00 paid Saturday, Sep 12']);
    process.env[GATE] = 'true';
    expect(buildFactsBlock(context, { now: new Date('2026-09-29T15:00:00Z') }))
      .toContain('- Recent payments: $120.00 paid Saturday, Sep 12 via card (partially refunded $30.00)');
  });

  test('PROMPT_VERSION export stays house_voice_v11 (the live/default cohort identity)', () => {
    expect(PROMPT_VERSION).toBe('house_voice_v11');
    expect(REAL_ANSWERS_PROMPT_VERSION).toBe('house_voice_v12_real_answers_cf_pf');
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
      '(SERVICE HISTORY, UPCOMING SERVICES, OPEN TIMES, BILLING, PENDING ESTIMATE, PROPERTY & PREFERENCES, LAWN HEALTH, ACCOUNT FLAGS, RECENT PHONE CALLS, LATEST CALL TRANSCRIPT, COMPANY FACTS, the thread)'
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
    expect(allFour.length).toBe(39); // '_cf_pf' + '+bclm'
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
    expect(result.promptVersion).toBe('house_voice_v12_real_answers_cf_pf');
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
    expect(insertedRows[0].prompt_version).toBe('house_voice_v12_real_answers_cf_pf');
    expect(insertedRows[0].facts_block).toContain('OPEN TIMES (real, bookable slots, ET');
    expect(insertedRows[0].facts_block).toContain('Tuesday, September 29: 9:00 AM - 11:00 AM');
  });

  test('gate on but not a scheduling-intent message: OPEN TIMES omitted, AvailabilityEngine never called', async () => {
    const { insertedRows, getAvailableSlots } = await runDraft({ gateOn: true, schedulingIntent: false });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(insertedRows[0].facts_block).not.toContain('OPEN TIMES');
    expect(insertedRows[0].prompt_version).toBe('house_voice_v12_real_answers_cf_pf'); // the prompt rewrite still applies; only the section is withheld
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
  // Independent-review P1 (round 3, PR #5331, finding 2): a receipt
  // confirmation must also NAME the date the row was paid — dates added to
  // both the reply and the fixture rows below where the assertion expects a
  // grounded (false) verdict.
  test('a FRACTIONAL amount inside the acknowledgement is still an acknowledgement ("$95.50 payment")', () => {
    const ctx = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95.5, status: 'paid', payment_date: '2026-09-12' }] } };
    expect(replyQuotesUngroundedAmount('We received your $95.50 payment from Sep 12 — thank you!', ctx)).toBe(false);
    expect(replyQuotesUngroundedAmount('Thank you for your payment of $95.50 from Sep 12.', ctx)).toBe(false);
    expect(replyQuotesUngroundedAmount('Your balance is $95.50.', ctx)).toBe(true);
  });
  test('"your balance is $95" on a zero-balance account with a $95 payment → ungrounded', () => {
    expect(replyQuotesUngroundedAmount('Your balance is $95.', context)).toBe(true);
    expect(replyQuotesUngroundedAmount('Thanks for reaching out — your balance is $95.', context)).toBe(true);
  });
  test('a real acknowledgement of the $95 payment → grounded', () => {
    const ctx = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95, status: 'paid', payment_date: '2026-09-12' }] } };
    expect(replyQuotesUngroundedAmount('We received your $95 payment from Sep 12 — thank you!', ctx)).toBe(false);
    expect(replyQuotesUngroundedAmount('Thank you for your payment of $95 from Sep 12.', ctx)).toBe(false);
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
    // Independent-review P1 (round 3, PR #5331, finding 2): the receipt
    // clause must also name the date its row was paid.
    const context = { billing: { outstandingBalance: 120.5, recentPayments: [{ amount: 95, status: 'paid', payment_date: '2026-09-12' }] } };
    expect(replyQuotesUngroundedAmount('We received your $95 payment from Sep 12; your remaining balance is $120.50.', context)).toBe(false);
    expect(replyQuotesUngroundedAmount('We received your $95 payment from Sep 12 and your remaining balance is $120.50.', context)).toBe(false);
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

  test('facts block: the line renders only with BOTH gates on, and fails closed to "not eligible"', () => {
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    expect(buildFactsBlock(CONTEXT, { reserviceLanes: ['pest', 'lawn'] })).toContain('FREE RE-SERVICE: eligible for pest and lawn');
    expect(buildFactsBlock(CONTEXT, { reserviceLanes: [] })).toContain('FREE RE-SERVICE: not eligible');
    expect(buildFactsBlock(CONTEXT)).toContain('FREE RE-SERVICE: not eligible'); // no lanes passed
    delete process.env.GATE_SMS_AGENT_COMPLAINTS;
    expect(buildFactsBlock(CONTEXT, { reserviceLanes: ['pest'] })).not.toContain('FREE RE-SERVICE');
    process.env.GATE_SMS_AGENT_COMPLAINTS = 'true';
    delete process.env.GATE_SMS_REAL_ANSWERS;
    expect(buildFactsBlock(CONTEXT, { reserviceLanes: ['pest'] })).not.toContain('FREE RE-SERVICE');
  });

  function loadWith({ lanes = ['pest'], selfServe = true, row = { id: 'cust-1', active: true }, throws = false } = {}) {
    jest.resetModules();
    const reserviceLanesForCustomer = jest.fn(async () => { if (throws) throw new Error('boom'); return lanes; });
    jest.doMock('../services/reservice-scheduler', () => ({ reserviceSelfServeEnabled: () => selfServe, reserviceLanesForCustomer }));
    jest.doMock('../models/db', () => {
      const db = jest.fn(() => ({ where: () => ({ first: async () => row }) }));
      return db;
    });
    return { drafter: require('../services/sms-shadow-drafter'), reserviceLanesForCustomer };
  }

  test('fetchReserviceLanes: eligible lanes come from reserviceLanesForCustomer on the live customer row', async () => {
    const { drafter, reserviceLanesForCustomer } = loadWith({ lanes: ['pest', 'lawn'] });
    await expect(drafter.fetchReserviceLanes({ customerId: 'cust-1' })).resolves.toEqual(['pest', 'lawn']);
    expect(reserviceLanesForCustomer).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1' }));
  });

  test('fetchReserviceLanes fails closed: self-serve off, inactive/missing customer, no id, or a lookup error → []', async () => {
    await expect(loadWith({ selfServe: false }).drafter.fetchReserviceLanes({ customerId: 'cust-1' })).resolves.toEqual([]);
    await expect(loadWith({ row: { id: 'cust-1', active: false } }).drafter.fetchReserviceLanes({ customerId: 'cust-1' })).resolves.toEqual([]);
    await expect(loadWith({ row: null }).drafter.fetchReserviceLanes({ customerId: 'cust-1' })).resolves.toEqual([]);
    await expect(loadWith({}).drafter.fetchReserviceLanes({ customerId: null })).resolves.toEqual([]);
    await expect(loadWith({ throws: true }).drafter.fetchReserviceLanes({ customerId: 'cust-1' })).resolves.toEqual([]);
  });

  test('fetchReserviceLanes: either gate off → null (no fact rendered, mechanism never consulted)', async () => {
    delete process.env.GATE_SMS_AGENT_COMPLAINTS;
    const { drafter, reserviceLanesForCustomer } = loadWith({});
    await expect(drafter.fetchReserviceLanes({ customerId: 'cust-1' })).resolves.toBeNull();
    expect(reserviceLanesForCustomer).not.toHaveBeenCalled();
  });

  test('validateReserviceOffer: a free-visit offer is a violation unless the facts say eligible', () => {
    const { validateReserviceOffer, reserviceFactLine } = require('../services/sms-shadow-drafter');
    const eligible = `X\n${reserviceFactLine(['pest'])}\nBILLING:`;
    const notEligible = `X\n${reserviceFactLine([])}\nBILLING:`;
    for (const reply of ['We can come back for a free re-service.', 'We will re-treat at no charge.', 'A complimentary visit is on us.']) {
      expect(validateReserviceOffer({ reply, factsBlock: notEligible }).ok).toBe(false);
      expect(validateReserviceOffer({ reply, factsBlock: 'no such line' }).ok).toBe(false);
      expect(validateReserviceOffer({ reply, factsBlock: eligible }).ok).toBe(true);
    }
    expect(validateReserviceOffer({ reply: 'I am sorry about that — a manager will reach out within the hour.', factsBlock: notEligible }).ok).toBe(true);
    delete process.env.GATE_SMS_REAL_ANSWERS; // gate off: the check does not run
    expect(validateReserviceOffer({ reply: 'We can come back for a free re-service.', factsBlock: notEligible }).ok).toBe(true);
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
    expect(drafter.validateReserviceOffer({ reply: 'We can come back for a free lawn re-service.', factsBlock: pestOnly }).ok).toBe(false);
    expect(drafter.validateReserviceOffer({ reply: 'We can come back for a free pest re-service.', factsBlock: pestOnly }).ok).toBe(true);
    expect(drafter.validateReserviceOffer({ reply: 'We can come back for a free re-service.', factsBlock: pestOnly }).ok).toBe(true); // no line named
    expect(drafter.validateReserviceOffer({ reply: 'We can come back for a free lawn re-service.', factsBlock: both }).ok).toBe(true);
  });

  test('replyQuotesUngroundedAmount: a FAILED or pending payment does not back "your payment went through"', () => {
    const failed = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95, status: 'failed', payment_date: '2026-09-12' }] } };
    const pending = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95, status: 'pending', payment_date: '2026-09-12' }] } };
    const paid = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 95, status: 'paid', payment_date: '2026-09-12' }] } };
    expect(drafter.replyQuotesUngroundedAmount('Your $95 payment went through — thank you!', failed)).toBe(true);
    expect(drafter.replyQuotesUngroundedAmount('We received your $95 payment.', pending)).toBe(true);
    // Independent-review P1 (round 3, PR #5331, finding 2): the receipt
    // clause must also name the date its row was paid.
    expect(drafter.replyQuotesUngroundedAmount('We received your $95 payment from Sep 12.', paid)).toBe(false);
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
