const {
  OUTREACH_TEMPLATES,
  DEFAULT_SEQUENCE_PLAN,
  RECURRING_SEQUENCE_PLAN,
  MULTI_TREATMENT_FIRST_PLAN,
  NO_LINK_TEMPLATE_KEYS,
  CAP_EXEMPT_TEMPLATE_KEYS,
  ASK_TOUCH_SQL,
  CAP_TOUCH_SQL,
  getOutreachTemplate,
  renderOutreachBody,
} = require('../services/review-outreach-templates');

describe('review outreach templates', () => {
  test('every template has a stable id, name, and sentiment', () => {
    const ids = new Set();
    for (const t of OUTREACH_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(['happy', 'issue', 'neutral']).toContain(t.sentiment);
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
    }
  });

  test('getOutreachTemplate resolves by id and returns null for unknown', () => {
    expect(getOutreachTemplate('friendly_ask')?.id).toBe('friendly_ask');
    expect(getOutreachTemplate('nope')).toBeNull();
  });

  test('the one-time cadence is Day 0/4/7 ending on email, reminder SMS weekdays-only (owner spec 2026-08-05: touch 2 lands 3-5 days after treatment, touch 3 lands 5-7; 3-day rule 2026-09-07 puts the email 72 h after the Day-4 SMS)', () => {
    expect(DEFAULT_SEQUENCE_PLAN.map((s) => s.day)).toEqual([0, 4, 7]);
    // Every later step sits at least 3 days after the previous one.
    for (let i = 1; i < DEFAULT_SEQUENCE_PLAN.length; i++) {
      expect(DEFAULT_SEQUENCE_PLAN[i].day - DEFAULT_SEQUENCE_PLAN[i - 1].day).toBeGreaterThanOrEqual(3);
    }
    expect(DEFAULT_SEQUENCE_PLAN.map((s) => s.channel)).toEqual(['sms', 'sms', 'email']);
    expect(DEFAULT_SEQUENCE_PLAN[1].weekdaysOnly).toBe(true);
    // Every step references a real template.
    for (const step of DEFAULT_SEQUENCE_PLAN) {
      expect(getOutreachTemplate(step.templateKey)).not.toBeNull();
    }
  });

  test('recurring customers get exactly one Day-0 ask', () => {
    expect(RECURRING_SEQUENCE_PLAN).toHaveLength(1);
    expect(RECURRING_SEQUENCE_PLAN[0]).toMatchObject({ day: 0, channel: 'sms' });
    expect(getOutreachTemplate(RECURRING_SEQUENCE_PLAN[0].templateKey)).not.toBeNull();
  });

  test('the multi-treatment first-visit plan is one cap-exempt ask that still carries the link', () => {
    expect(MULTI_TREATMENT_FIRST_PLAN).toHaveLength(1);
    expect(MULTI_TREATMENT_FIRST_PLAN[0]).toMatchObject({ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' });
    const tpl = getOutreachTemplate('first_treatment_ask');
    expect(tpl.body).toContain('{review_url}'); // it IS an ask, just cap-exempt
    expect(NO_LINK_TEMPLATE_KEYS).not.toContain('first_treatment_ask');
    expect(CAP_EXEMPT_TEMPLATE_KEYS).toContain('first_treatment_ask');
    // The personalized funnel-attribution variant must be exempt too, or a
    // personalized first ask would cooldown-block the final-visit cadence.
    expect(CAP_EXEMPT_TEMPLATE_KEYS).toContain('first_treatment_ask_personalized');
    // Funnel/supersede SQL still counts it as an ask; only the cap ignores it.
    expect(ASK_TOUCH_SQL).not.toContain('first_treatment_ask');
    expect(CAP_TOUCH_SQL).toContain("'first_treatment_ask'");
    expect(CAP_TOUCH_SQL).toContain("'first_treatment_ask_personalized'");
    for (const key of NO_LINK_TEMPLATE_KEYS) {
      expect(CAP_EXEMPT_TEMPLATE_KEYS).toContain(key);
    }
  });

  test('every template fits ONE GSM segment as sent (owner spec 2026-08-06)', () => {
    const { countSegments } = require('../services/messaging/segment-counter');
    const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
    // Worst realistic inputs: 12-char first name, an 11-char technician
    // FIRST name (sendOutreachTouch substitutes first name only), real
    // shortened-link length.
    const vars = {
      first: 'Christopher2',
      tech: 'Christopher',
      sender: 'Christopher with Waves',
      service_type: 'pest control service',
      review_url: 'https://portal.wavespestcontrol.com/l/abcde',
    };
    // …and the no-name fallback ('Your tech', substituted when neither the
    // row's tech_name nor its technician_id resolves) must fit too.
    const { tech: _named, sender: _signed, ...noTech } = vars;
    for (const t of OUTREACH_TEMPLATES) {
      const requireLink = t.body.includes('{review_url}');
      for (const [label, v] of [['named', vars], ['fallback', noTech]]) {
        const body = normalizeGsmPunctuation(renderOutreachBody(t.body, v, { requireLink }));
        const s = countSegments(body);
        expect({ id: t.id, vars: label, encoding: s.encoding, segments: s.segmentCount })
          .toEqual({ id: t.id, vars: label, encoding: 'GSM_7', segments: 1 });
      }
    }
  });

  test('renderOutreachBody substitutes every placeholder', () => {
    const out = renderOutreachBody(
      'Hi {first} ({name}) — {tech} finished your {service_type} on {date}: {review_url}',
      { first: 'Stan', name: 'Stan Smith', tech: 'Adam', service_type: 'pest control', review_url: 'https://x/y', date: '6/26' },
    );
    expect(out).toBe('Hi Stan (Stan Smith) — Adam finished your pest control on 6/26: https://x/y');
    expect(out).not.toMatch(/\{[a-z_]+\}/);
  });

  test('renderOutreachBody falls back to sensible defaults', () => {
    const out = renderOutreachBody('Hey {first}, {tech} here', {});
    expect(out).toBe('Hey there, Your tech here');
  });

  test('{sender} is the tech on the record, else the company — never the "Your tech" fallback', () => {
    expect(renderOutreachBody('{sender}.', { tech: 'Adam' })).toBe('Adam with Waves.');
    expect(renderOutreachBody('{sender}.', {})).toBe('Waves Pest Control.');
    expect(renderOutreachBody('{sender}.', { sender: 'Sam with Waves', tech: 'Adam' })).toBe('Sam with Waves.');
  });

  test('the cadence Day-0 step is the controlled day0_ask (day-agnostic, uniform reply invite); legacy friendly_ask plans map onto it', () => {
    const { DAY0_ASK_TEMPLATE_KEY, isDay0ControlledAsk } = require('../services/review-outreach-templates');
    expect(DEFAULT_SEQUENCE_PLAN[0].templateKey).toBe(DAY0_ASK_TEMPLATE_KEY);
    expect(RECURRING_SEQUENCE_PLAN[0].templateKey).toBe(DAY0_ASK_TEMPLATE_KEY);
    const tpl = getOutreachTemplate(DAY0_ASK_TEMPLATE_KEY);
    expect(tpl.body).not.toMatch(/\btoday\b|\btonight\b/i);
    expect(tpl.body).toContain("Reply if anything's off.");
    expect(tpl.body).toContain('{sender}');
    expect(tpl.body).toContain('{review_url}');
    expect(isDay0ControlledAsk({ sequenceStep: 0, channel: 'sms', templateId: 'friendly_ask' })).toBe(true);
    expect(isDay0ControlledAsk({ sequenceStep: 0, channel: 'sms', templateId: null })).toBe(true);
    expect(isDay0ControlledAsk({ sequenceStep: 0, channel: 'sms', templateId: 'first_treatment_ask' })).toBe(false);
    expect(isDay0ControlledAsk({ sequenceStep: 1, channel: 'sms', templateId: 'friendly_ask' })).toBe(false);
    expect(isDay0ControlledAsk({ sequenceStep: 0, channel: 'email', templateId: 'friendly_ask' })).toBe(false);
    // Any other link-bearing ask an admin's custom plan names at step 0 is
    // controlled too (codex #4139 r2) — no-link check-ins are not asks.
    expect(isDay0ControlledAsk({ sequenceStep: 0, channel: 'sms', templateId: 'post_service_hot' })).toBe(true);
    expect(isDay0ControlledAsk({ sequenceStep: 0, channel: 'sms', templateId: 'service_specific_pest' })).toBe(true);
    expect(isDay0ControlledAsk({ sequenceStep: 0, channel: 'sms', templateId: 'resolution_check' })).toBe(false);
  });

  test('requireLink appends the review URL when an edited body dropped it', () => {
    const out = renderOutreachBody(
      'Hey {first}, loved having you as a customer!',
      { first: 'Stan', review_url: 'https://r/abc' },
      { requireLink: true },
    );
    expect(out).toContain('https://r/abc');
  });

  test('requireLink does not double-append when the link is present', () => {
    const out = renderOutreachBody(
      'Hey {first}: {review_url}',
      { first: 'Stan', review_url: 'https://r/abc' },
      { requireLink: true },
    );
    expect(out.match(/https:\/\/r\/abc/g)).toHaveLength(1);
  });

  test('issue templates carry no review link', () => {
    const resolution = getOutreachTemplate('resolution_check');
    expect(resolution.body).not.toContain('{review_url}');
  });
});
