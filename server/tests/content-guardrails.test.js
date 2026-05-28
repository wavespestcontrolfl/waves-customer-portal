const guardrails = require('../services/content/content-guardrails');

describe('content-guardrails', () => {
  test('hardcoded price without calculator framing is P0', () => {
    const r = guardrails.evaluate({ body: 'Our pest control is just $49 per month for most homes.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
  });

  test('price near calculator/quote framing is allowed', () => {
    const r = guardrails.evaluate({ body: 'Pricing varies by home — use our calculator for an instant $ estimate.' }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(false);
  });

  test('literal brand on a multi-domain page is a P0 leak', () => {
    const r = guardrails.evaluate({
      body: 'Waves Pest Control keeps your home pest-free.',
      frontmatter: { domains: ['bradentonflpestcontrol.com'] },
    }, {});
    expect(r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK' && f.severity === 'P0')).toBe(true);
  });

  test('literal brand on a hub-only page (no domains) is allowed', () => {
    const r = guardrails.evaluate({
      body: 'Waves Pest Control keeps your home pest-free.',
      frontmatter: {},
    }, {});
    expect(r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK')).toBe(false);
  });

  test('refresh: live domains passed via opts catch a leak the draft frontmatter hides', () => {
    // Refresh draft carries no domains (frozen from live page); caller passes
    // the live page's domains explicitly.
    const r = guardrails.evaluate(
      { body: 'Waves Pest Control keeps your home pest-free.', frontmatter: {} },
      { domains: ['bradentonflpestcontrol.com'] },
    );
    expect(r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK' && f.severity === 'P0')).toBe(true);
  });

  test('FAQ section on a blocked service is P0', () => {
    const r = guardrails.evaluate({ body: '## FAQ\nQ: Do you handle rats?' }, { service: 'rodent' });
    expect(r.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE' && f.severity === 'P0')).toBe(true);
  });

  test('FAQ section on an allowed service is fine', () => {
    const r = guardrails.evaluate({ body: '## FAQ\nQ: When is the blackout?' }, { service: 'lawn-care' });
    expect(r.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('keyword stuffing is a P2 warning (non-blocking)', () => {
    const kw = 'pest control sarasota';
    const body = (`${kw} `).repeat(20) + 'filler '.repeat(40);
    const r = guardrails.evaluate({ body }, { primaryKeyword: kw });
    expect(r.findings.some((f) => f.code === 'KEYWORD_STUFFING' && f.severity === 'P2')).toBe(true);
    expect(r.pass).toBe(true); // P2 doesn't block
  });

  test('clean body passes', () => {
    const r = guardrails.evaluate({
      body: 'Ghost ants are common in Sarasota during the rainy season. Use our calculator for pricing.',
      frontmatter: {},
    }, { service: 'pest-control', primaryKeyword: 'ghost ants' });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
});
