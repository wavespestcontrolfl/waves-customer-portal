const {
  PROMPT_VERSION,
  VERDICTS,
  _test: { buildJudgePrompt, parseJudgeResponse, pairDraftWithHumanReply, judgeOne, REPLY_WINDOW_HOURS },
} = require('../services/sms-shadow-judge');
const { CUSTOMER_SMS_HOUSE_VOICE } = require('../services/ai-assistant/managed-agent-config');

const HOUR = 3600 * 1000;
const base = new Date('2026-06-10T12:00:00Z').getTime();
const at = (offsetHours) => new Date(base + offsetHours * HOUR).toISOString();

describe('shadow judge — reply pairing', () => {
  const draft = { id: 'd1', customer_id: 'c1', created_at: at(0) };

  test('pairs the first non-empty manual reply inside the window', () => {
    const outbounds = [
      { id: 'o0', customer_id: 'c1', message_body: '  ', created_at: at(0.5) },
      { id: 'o1', customer_id: 'c1', message_body: 'Hello Dale! All set.', created_at: at(1) },
      { id: 'o2', customer_id: 'c1', message_body: 'Second message', created_at: at(2) },
    ];
    expect(pairDraftWithHumanReply(draft, outbounds).id).toBe('o1');
  });

  test('ignores replies outside the reply window or before the inbound', () => {
    expect(pairDraftWithHumanReply(draft, [
      { id: 'old', customer_id: 'c1', message_body: 'Earlier thread', created_at: at(-1) },
      { id: 'late', customer_id: 'c1', message_body: 'Too late', created_at: at(REPLY_WINDOW_HOURS + 1) },
    ])).toBeNull();
    expect(pairDraftWithHumanReply(draft, [])).toBeNull();
  });

  test('clock-skew slack tolerates a reply logged seconds before the draft row', () => {
    const reply = { id: 'fast', customer_id: 'c1', message_body: 'Quick human', created_at: new Date(base - 60 * 1000).toISOString() };
    expect(pairDraftWithHumanReply(draft, [reply]).id).toBe('fast');
  });

  test('no pre-anchor slack on linked inbounds — prior-thread replies stay out (Codex P2 r2)', () => {
    // Human replied to the PREVIOUS message at 8:59; new inbound 9:00.
    // Same DB clock on both timestamps — that reply is not this draft's
    // ground truth, even though it's within the 2-min skew slack.
    const linked = { id: 'd1', customer_id: 'c1', inbound_at: at(0), created_at: at(0) };
    const priorReply = { id: 'prev', customer_id: 'c1', message_body: 'Answering your earlier text', created_at: new Date(base - 60 * 1000).toISOString() };
    expect(pairDraftWithHumanReply(linked, [priorReply])).toBeNull();
  });

  test('anchors on the inbound timestamp, not the slow drafter row (Codex P2)', () => {
    // Inbound 9:00, human replied 9:02, but the async drafter took 5 min —
    // draft row created_at 9:05. Anchoring on created_at would drop the
    // reply as "before the window".
    const slowDraft = { id: 'd1', customer_id: 'c1', inbound_at: at(0), created_at: at(5 / 60) };
    const reply = { id: 'o1', customer_id: 'c1', message_body: 'Fast human reply', created_at: at(2 / 60) };
    expect(pairDraftWithHumanReply({ ...slowDraft, created_at: at(5 / 60) }, [reply]).id).toBe('o1');
  });

  test('one reply is never reused across a burst — window ends at next inbound (Codex P2)', () => {
    // Customer texts at 9:00 and 9:30; Virginia replies once at 9:45.
    // The reply answers the 9:30 message: the 9:00 draft must NOT claim it.
    const reply = { id: 'o1', customer_id: 'c1', message_body: 'Answering your latest text', created_at: at(0.75) };
    const draftA = { id: 'dA', customer_id: 'c1', inbound_at: at(0), created_at: at(0) };
    const draftB = { id: 'dB', customer_id: 'c1', inbound_at: at(0.5), created_at: at(0.5) };
    expect(pairDraftWithHumanReply(draftA, [reply], { nextInboundAt: at(0.5) })).toBeNull();
    expect(pairDraftWithHumanReply(draftB, [reply], { nextInboundAt: null }).id).toBe('o1');
  });
});

describe('shadow judge — deterministic verdicts (no LLM spend)', () => {
  test('both silent = both_no_reply agreement', async () => {
    const judgment = await judgeOne({ id: 'd1', draft_response: '', intent: 'no_reply_needed' }, null);
    expect(judgment.verdict).toBe('both_no_reply');
    expect(judgment.scores).toBeNull();
    expect(judgment.model).toBeNull();
  });

  test('AI drafted text, human silent = human_no_reply, unscored', async () => {
    const judgment = await judgeOne({ id: 'd1', draft_response: 'Hello! Reply text.', intent: 'GENERAL' }, null);
    expect(judgment.verdict).toBe('human_no_reply');
    expect(judgment.scores).toBeNull();
  });

  test('AI silent but human replied = scored miss for the draft', async () => {
    const judgment = await judgeOne(
      { id: 'd1', draft_response: '', intent: 'GENERAL' },
      { id: 'o1', message_body: 'Hello! We will be there Friday.' }
    );
    expect(judgment.verdict).toBe('human_better');
    expect(judgment.scores.overall).toBeLessThanOrEqual(2);
    expect(judgment.human_replied).toBe(true);
    expect(judgment.draft_was_empty).toBe(true);
  });
});

describe('shadow judge — LLM response contract', () => {
  test('parses a bare verdict object and clamps scores to 0-10', () => {
    const parsed = parseJudgeResponse('{"voice": 12, "safety": -3, "actions": 7.6, "overall": 8, "verdict": "equivalent", "notes": "solid"}');
    expect(parsed.scores).toEqual({ voice: 10, safety: 0, actions: 8, overall: 8 });
    expect(parsed.verdict).toBe('equivalent');
  });

  test('parses fenced and prose-embedded responses', () => {
    expect(parseJudgeResponse('```json\n{"voice":9,"safety":9,"actions":9,"overall":9,"verdict":"draft_better","notes":"x"}\n```').verdict).toBe('draft_better');
    expect(parseJudgeResponse('Here you go: {"voice":1,"safety":2,"actions":3,"overall":2,"verdict":"human_better"} done').verdict).toBe('human_better');
  });

  test('rejects unusable payloads', () => {
    expect(parseJudgeResponse(null)).toBeNull();
    expect(parseJudgeResponse('no json')).toBeNull();
    expect(parseJudgeResponse('{"voice":9,"safety":9,"actions":9,"overall":9,"verdict":"maybe_fine"}')).toBeNull(); // unknown verdict
    expect(parseJudgeResponse('{"voice":"high","safety":9,"actions":9,"overall":9,"verdict":"equivalent"}')).toBeNull(); // non-numeric score
  });

  test('judge prompt pins the house voice and grades the draft, not the human', () => {
    const prompt = buildJudgePrompt({
      inboundMessage: 'What time Friday?',
      draftReply: 'Hello Dale! 8-10am Friday.',
      humanReply: 'Morning! We will be there 8-10.',
      intent: 'general_customer_sms_needs_review',
      contextSummary: 'Dale Cooper — Quarterly Pest',
    });
    expect(prompt).toContain(CUSTOMER_SMS_HOUSE_VOICE);
    expect(prompt).toContain('the human reply is the reference');
    expect(prompt).toContain('draft_unsafe');
    // template itself must be valid JSON if echoed literally
    const template = prompt.slice(prompt.indexOf('{', prompt.indexOf('Respond with ONLY')));
    expect(() => JSON.parse(template)).not.toThrow();
  });

  test('verdict + version constants are stable for the dashboard', () => {
    expect(PROMPT_VERSION).toBe('shadow_judge_v1');
    expect(VERDICTS).toEqual(expect.arrayContaining(['draft_better', 'equivalent', 'human_better', 'draft_unsafe', 'human_no_reply', 'both_no_reply']));
  });
});
