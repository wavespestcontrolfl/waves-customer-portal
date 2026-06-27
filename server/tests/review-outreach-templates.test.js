const {
  OUTREACH_TEMPLATES,
  DEFAULT_SEQUENCE_PLAN,
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

  test('the default cadence is Day 0/3/7 ending on email', () => {
    expect(DEFAULT_SEQUENCE_PLAN.map((s) => s.day)).toEqual([0, 3, 7]);
    expect(DEFAULT_SEQUENCE_PLAN[DEFAULT_SEQUENCE_PLAN.length - 1].channel).toBe('email');
    // Every step references a real template.
    for (const step of DEFAULT_SEQUENCE_PLAN) {
      expect(getOutreachTemplate(step.templateKey)).not.toBeNull();
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
    expect(out).toBe('Hey there, Adam here');
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
