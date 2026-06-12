const {
  parseShadowResponse,
  buildSystemPrompt,
  buildUserPrompt,
  SHADOW_STATUS,
  DRAFTER,
  PROMPT_VERSION,
  INTENDED_ACTION_TYPES,
} = require('../services/sms-shadow-drafter');
const { CUSTOMER_SMS_HOUSE_VOICE, AGENT_CONFIG } = require('../services/ai-assistant/managed-agent-config');

describe('sms shadow drafter — response parsing', () => {
  test('parses a bare JSON object', () => {
    const parsed = parseShadowResponse(
      '{"reply":"Hello Dale! You are on the schedule.","intended_actions":[],"missing_info":null}'
    );
    expect(parsed).toEqual({
      reply: 'Hello Dale! You are on the schedule.',
      intended_actions: [],
      missing_info: null,
    });
  });

  test('parses a fenced code block', () => {
    const parsed = parseShadowResponse(
      '```json\n{"reply":"Hi Sarah, I hear you.","intended_actions":[{"type":"escalate","note":"complaint"}],"missing_info":null}\n```'
    );
    expect(parsed.reply).toBe('Hi Sarah, I hear you.');
    expect(parsed.intended_actions).toEqual([{ type: 'escalate', note: 'complaint' }]);
  });

  test('recovers an object embedded in prose', () => {
    const parsed = parseShadowResponse(
      'Here is the draft: {"reply":"Hello Tom! All set for Friday.","intended_actions":[],"missing_info":"exact arrival window"} hope that helps'
    );
    expect(parsed.reply).toBe('Hello Tom! All set for Friday.');
    expect(parsed.missing_info).toBe('exact arrival window');
  });

  test('drops unknown action types and keeps known ones', () => {
    const parsed = parseShadowResponse(
      '{"reply":"Hello!","intended_actions":[{"type":"launch_rocket"},{"type":"book_appointment"},{"type":42}]}'
    );
    expect(parsed.intended_actions).toEqual([{ type: 'book_appointment', note: undefined }]);
  });

  test('rejects unusable payloads', () => {
    expect(parseShadowResponse(null)).toBeNull();
    expect(parseShadowResponse('')).toBeNull();
    expect(parseShadowResponse('no json here at all')).toBeNull();
    expect(parseShadowResponse('{"intended_actions":[]}')).toBeNull(); // no reply
    expect(parseShadowResponse('{"reply":"   "}')).toBeNull(); // blank reply
    expect(parseShadowResponse('{"reply": 7}')).toBeNull(); // non-string reply
  });

  test('truncates oversized note and missing_info fields', () => {
    const parsed = parseShadowResponse(
      JSON.stringify({
        reply: 'Hello!',
        intended_actions: [{ type: 'escalate', note: 'x'.repeat(500) }],
        missing_info: 'y'.repeat(900),
      })
    );
    expect(parsed.intended_actions[0].note).toHaveLength(200);
    expect(parsed.missing_info).toHaveLength(500);
  });
});

describe('sms shadow drafter — prompt contract', () => {
  test('system prompt embeds the exact house voice the live assistant uses', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(CUSTOMER_SMS_HOUSE_VOICE);
    expect(AGENT_CONFIG.system).toContain(CUSTOMER_SMS_HOUSE_VOICE);
    expect(prompt).toContain('INTERNAL EVALUATION ONLY');
    expect(prompt).toContain('never be sent');
  });

  test('user prompt carries thread, intent, and scheduling-intent caution', () => {
    const context = {
      summary: 'Dale Cooper — Quarterly Pest, Sarasota',
      smsHistory: [
        { direction: 'outbound', body: 'See you Friday!' },
        { direction: 'inbound', body: 'What time Friday?' },
      ],
      flags: [{ type: 'overdue_balance', severity: 'high', detail: '$240.00 outstanding' }],
      lastService: { type: 'Quarterly Pest', date: '2026-06-01', notes: 'Treated exterior' },
      upcomingServices: [{ type: 'Quarterly Pest', date: '2026-06-19', window: '8-10am' }],
      billing: { outstandingBalance: 240 },
    };
    const prompt = buildUserPrompt(context, 'What time Friday?', { intent: 'general_customer_sms_needs_review' }, true);

    expect(prompt).toContain('Dale Cooper — Quarterly Pest, Sarasota');
    expect(prompt).toContain('[CUSTOMER] What time Friday?');
    expect(prompt).toContain('[WAVES] See you Friday!');
    expect(prompt).toContain('HIGH overdue_balance: $240.00 outstanding');
    expect(prompt).toContain('general_customer_sms_needs_review');
    expect(prompt).toContain('scheduling-intent detected');
    expect(prompt).toContain('$240.00 outstanding');
  });

  test('user prompt stays coherent on an empty context', () => {
    const prompt = buildUserPrompt({ summary: 'Unknown' }, 'Hi', null, false);
    expect(prompt).toContain('(no recent thread)');
    expect(prompt).toContain('No flags.');
    expect(prompt).toContain('Nothing scheduled');
    expect(prompt).toContain('CLASSIFIED INTENT: GENERAL');
    expect(prompt).not.toContain('scheduling-intent detected');
  });
});

describe('sms shadow drafter — structural unsendability', () => {
  test('shadow rows live outside every status admin-drafts can act on', () => {
    expect(SHADOW_STATUS).toBe('shadow');
    // admin-drafts approve/revise require status='pending' and the send
    // worker reads only approved/revised — if any of these ever equals
    // 'shadow' the silent-draft guarantee is broken.
    const ACTIONABLE_STATUSES = ['pending', 'approved', 'revised', 'sent'];
    expect(ACTIONABLE_STATUSES).not.toContain(SHADOW_STATUS);
  });

  test('telemetry identity constants are stable for the judge pass', () => {
    expect(DRAFTER).toBe('house_voice');
    expect(PROMPT_VERSION).toBe('house_voice_v1');
    expect(INTENDED_ACTION_TYPES).toContain('escalate');
    expect(INTENDED_ACTION_TYPES).toContain('none');
  });
});
