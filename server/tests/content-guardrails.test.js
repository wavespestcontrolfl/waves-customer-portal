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

  test('regulatory fine amounts are not treated as service prices', () => {
    const r = guardrails.evaluate({
      body: '### Penalties and Fines\n\nCivil infractions can carry fines up to $500 per violation under the county ordinance.',
    }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('service prices near ordinance language still block', () => {
    const r = guardrails.evaluate({
      body: 'Ordinance violations can be confusing. Our lawn treatment plan is $99 per month for most homes.',
    }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
  });

  test('service prices near fine wording still block', () => {
    const r = guardrails.evaluate({
      body: 'Fines can be stressful. Our lawn treatment plan is $99 per month for most homes.',
    }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
  });

  test('service prices before later fine wording still block', () => {
    const r = guardrails.evaluate({
      body: 'Our lawn treatment plan is $99 per month and helps avoid county fines.',
    }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
  });

  test('generic customer penalties still block as prices', () => {
    const r = guardrails.evaluate({
      body: 'Our cancellation penalty is $50 if the visit is cancelled after arrival.',
    }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
  });

  test('customer penalties still block near county wording', () => {
    const r = guardrails.evaluate({
      body: 'County rules are complicated. Our cancellation penalty is $50 if the visit is cancelled after arrival.',
    }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
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

  test('literal brand on a sole-hub-domain page is allowed (not treated as multi-domain)', () => {
    // The legacy/default blog target_sites is just the hub; that must count as
    // hub-only, not a spoke/multi-domain publish.
    const r = guardrails.evaluate({
      body: 'Waves Pest Control keeps your home pest-free.',
      frontmatter: { domains: ['wavespestcontrol.com'] },
    }, {});
    expect(r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK')).toBe(false);
  });

  test('literal brand still leaks when the hub is bundled with a spoke domain', () => {
    const r = guardrails.evaluate({
      body: 'Waves Pest Control keeps your home pest-free.',
      frontmatter: { domains: ['wavespestcontrol.com', 'bradentonflpestcontrol.com'] },
    }, {});
    expect(r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK' && f.severity === 'P0')).toBe(true);
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

  test('brand-token leak hiding only in editable meta is caught for a multi-domain refresh', () => {
    const r = guardrails.evaluate(
      { body: 'Local, reliable pest control for your home.', frontmatter: { metaTitle: 'Waves Pest Control — Venice FL' } },
      { domains: ['veniceflpestcontrol.com'] },
    );
    expect(r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK' && f.severity === 'P0')).toBe(true);
  });

  test('hardcoded price hiding only in metaDescription is caught', () => {
    const r = guardrails.evaluate(
      { body: 'Local, reliable pest control for your home.', frontmatter: { metaDescription: 'Pest control from $49/month in Venice.' } },
      {},
    );
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
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

  test.each(['Rodents', 'Bed Bugs', 'Cockroaches', 'Spiders', 'Termites', 'Lawn Pests'])(
    'FAQ on a blocked service matches the legacy display tag "%s"',
    (tag) => {
      const r = guardrails.evaluate({ body: '## Frequently Asked Questions\nQ: ...' }, { service: tag });
      expect(r.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE' && f.severity === 'P0')).toBe(true);
    },
  );

  test('FAQ on an allowed display tag (Mosquitoes/Ants) is still fine', () => {
    for (const tag of ['Mosquitoes', 'Ants', 'Pest Control']) {
      const r = guardrails.evaluate({ body: '## FAQ\nQ: ...' }, { service: tag });
      expect(r.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE')).toBe(false);
    }
  });

  test('FAQ check evaluates ALL service fields — blocked topic on tag while category is broad', () => {
    // [category, tag] — category is the non-blocked broad value, tag is blocked.
    const r = guardrails.evaluate({ body: '## Frequently Asked Questions\nQ: ...' }, { service: ['pest-control', 'Rodents'] });
    expect(r.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE' && f.severity === 'P0')).toBe(true);
  });

  test('FAQ check with array of only-allowed services passes', () => {
    const r = guardrails.evaluate({ body: '## FAQ\nQ: ...' }, { service: ['pest-control', 'Mosquitoes'] });
    expect(r.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE')).toBe(false);
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
