/**
 * Event-level click attribution + bounded learning (owner spec
 * 2026-07-28, PR 5). Pure pieces: token scan/substitution/resolution,
 * rate math, learned-adjustment guardrails, kill switch.
 */

const {
  EVCLICK_TOKEN,
  evclickIdsInBody,
  buildEvclickSubstitutions,
  resolveEvclickDirect,
  rateAdjustment,
  applyLearnedAdjustments,
  clickLearningEnabled,
  trackingUrl,
} = require('../services/newsletter-event-clicks');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const BODY = `<a href="${EVCLICK_TOKEN(ID_A)}">Details</a> <a href="${EVCLICK_TOKEN(ID_B)}">Details</a>`;

afterEach(() => { delete process.env.NEWSLETTER_CLICK_LEARNING; });

describe('evclick tokens', () => {
  test('scan finds every distinct event id', () => {
    expect(evclickIdsInBody(BODY).sort()).toEqual([ID_A, ID_B].sort());
    expect(evclickIdsInBody('no tokens')).toEqual([]);
  });

  test('per-recipient substitution carries the engagement token; tokenless recipients get the DIRECT url', () => {
    const urlById = new Map([[ID_A, 'https://venue.example/a'], [ID_B, 'https://venue.example/b']]);
    const withToken = buildEvclickSubstitutions(BODY, { token: 'tok-123', urlById });
    expect(withToken[EVCLICK_TOKEN(ID_A)]).toBe(trackingUrl('tok-123', ID_A));
    const withoutToken = buildEvclickSubstitutions(BODY, { token: null, urlById });
    expect(withoutToken[EVCLICK_TOKEN(ID_A)]).toBe('https://venue.example/a');
  });

  test('direct resolution replaces tokens with event urls, homepage when unknown', () => {
    const urlById = new Map([[ID_A, 'https://venue.example/a']]);
    const html = resolveEvclickDirect(BODY, urlById);
    expect(html).toContain('https://venue.example/a');
    expect(html).toContain('https://www.wavespestcontrol.com/');
    expect(html).not.toContain('{{evclick:');
  });
});

describe('rateAdjustment (pure math)', () => {
  test('thin categories get ZERO adjustment — the discovery protection', () => {
    expect(rateAdjustment(20, 2, 5, { cap: 3 })).toBe(0);
    expect(rateAdjustment(0, 0, 5, { cap: 3 })).toBe(0);
  });

  test('above/below-mean rates produce clamped symmetric adjustments', () => {
    // 3 events, 30 clicks → rate 10 vs overall 5 → ratio 2 → +3 (capped)
    expect(rateAdjustment(30, 3, 5, { cap: 3 })).toBe(3);
    // rate 2.5 vs 5 → ratio .5 → -1.5 → -2 (rounded)
    expect(rateAdjustment(10, 4, 5, { cap: 3 })).toBeLessThan(0);
    expect(Math.abs(rateAdjustment(1, 100, 5, { cap: 3 }))).toBeLessThanOrEqual(3);
  });
});

describe('applyLearnedAdjustments guardrails', () => {
  const scored = [
    { id: 'x', editorial_score: 80, novelty_type: 'touring', region_zone: 'tampa', admin_status: 'approved' },
    { id: 'y', editorial_score: 76, novelty_type: 'ordinary', region_zone: 'sarasota', admin_status: 'approved' },
    { id: 'star', editorial_score: 80, novelty_type: 'touring', region_zone: 'tampa', admin_status: 'featured' },
    { id: 'sub', editorial_score: 60, novelty_type: 'touring', region_zone: 'tampa', admin_status: 'approved' },
  ];

  test('caps at ±5 total, never crosses the floor, stars and sub-floor rows untouched', () => {
    const out = applyLearnedAdjustments(scored, {
      categoryAdj: new Map([['touring', 3], ['ordinary', -3]]),
      zoneAdj: new Map([['tampa', 2], ['sarasota', -2]]),
    });
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(byId.x.editorial_score).toBe(85); // +3 +2
    expect(byId.x.learnedAdjustment).toBe(5);
    expect(byId.y.editorial_score).toBe(75); // 76 -5 floored at 75
    expect(byId.star.editorial_score).toBe(80);
    expect(byId.star.learnedAdjustment).toBeUndefined();
    expect(byId.sub.editorial_score).toBe(60);
  });

  test('empty adjustment maps are a no-op', () => {
    expect(applyLearnedAdjustments(scored, { categoryAdj: new Map(), zoneAdj: new Map() })).toBe(scored);
  });
});

describe('kill switch', () => {
  test('only the literal string false disables learning', () => {
    expect(clickLearningEnabled()).toBe(true);
    process.env.NEWSLETTER_CLICK_LEARNING = 'false';
    expect(clickLearningEnabled()).toBe(false);
  });
});
