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

// isFaqBlockedService is the exported single source of truth the GENERATOR
// side (blog-writer prompt, writer-agent-config) and content-quality-gate
// condition on. It must match exactly what faqBlockedFinding enforces at
// publish — same blocklist, same normalization.
describe('isFaqBlockedService (exported policy helper)', () => {
  test('is exported alongside FAQ_BLOCKED_SERVICES', () => {
    expect(typeof guardrails.isFaqBlockedService).toBe('function');
    expect(guardrails.FAQ_BLOCKED_SERVICES instanceof Set).toBe(true);
  });

  test('returns true for every id on the blocklist', () => {
    for (const id of guardrails.FAQ_BLOCKED_SERVICES) {
      expect(guardrails.isFaqBlockedService(id)).toBe(true);
    }
  });

  test('matches display-cased plural blog tags (same normalization as the publish guard)', () => {
    for (const tag of ['Rodents', 'Termites', 'Spiders', 'Bed Bugs', 'Cockroaches', 'Wasps']) {
      expect(guardrails.isFaqBlockedService(tag)).toBe(true);
    }
  });

  test('returns false for non-blocked services/tags', () => {
    for (const value of ['Mosquitoes', 'Ants', 'Fleas & Ticks', 'Lawn Disease', 'Pest Control', 'pest', 'pest-control', 'Lawn Care', 'lawn-care', '', null, undefined]) {
      expect(guardrails.isFaqBlockedService(value)).toBe(false);
    }
  });

  // blog-writer's normalizeTag collapses raw topics into canonical display
  // tags; "Roaches" and "Stinging Insects" do NOT reduce to their blocked ids
  // (cockroach, wasp) via lowercase/de-pluralize alone, so they need explicit
  // aliases. Without them, a cockroach/wasp post got the FAQ-required prompt
  // AND bypassed the publish-time FAQ_BLOCKED_SERVICE guard.
  test('matches canonical blog tags via the alias map (Roaches→cockroach, Stinging Insects→wasp)', () => {
    for (const tag of ['Roaches', 'roaches', 'roach', 'Stinging Insects', 'stinging insects', 'stinging-insects', 'Palmetto Bug']) {
      expect(guardrails.isFaqBlockedService(tag)).toBe(true);
    }
  });

  test('every canonical blog tag whose service is blocked resolves as blocked', () => {
    // BLOG_TAGS (blog-writer) ∩ FAQ-blocked services — every canonical-tag
    // form of a blocked service must be covered, alias or normalization.
    for (const tag of ['Roaches', 'Rodents', 'Termites', 'Spiders', 'Bed Bugs', 'Stinging Insects', 'Lawn Pests']) {
      expect(guardrails.isFaqBlockedService(tag)).toBe(true);
    }
  });

  test('publish-time FAQ_BLOCKED_SERVICE guard fires for canonical tags too', () => {
    for (const tag of ['Roaches', 'Stinging Insects']) {
      const r = guardrails.evaluate(
        { body: '## Frequently Asked Questions\nQ: ...' },
        { service: ['pest-control', tag] }, // publishAstro's [category, tag] form
      );
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE' && f.severity === 'P0')).toBe(true);
    }
  });

  test('alias map only fires on whole normalized values, not substrings', () => {
    for (const value of ['approach', 'approaches', 'roach-motel-review-guide', 'wasp-free lawn care']) {
      expect(guardrails.isFaqBlockedService(value)).toBe(false);
    }
  });

  test('accepts the [category, tag] array form publishAstro uses', () => {
    expect(guardrails.isFaqBlockedService(['pest-control', 'Rodents'])).toBe(true);
    expect(guardrails.isFaqBlockedService(['pest-control', 'Mosquitoes'])).toBe(false);
  });

  test('agrees with the publish-time FAQ_BLOCKED_SERVICE finding for every blocklist id', () => {
    for (const id of guardrails.FAQ_BLOCKED_SERVICES) {
      const r = guardrails.evaluate({ body: '## Frequently Asked Questions\nQ: ...' }, { service: id });
      expect(r.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE' && f.severity === 'P0')).toBe(true);
    }
  });
});

describe('hardcoded price: comma-grouped and single-digit amounts (regression)', () => {
  test('comma-grouped price is P0 — "$1,200" previously produced no finding at all', () => {
    const r = guardrails.evaluate({ body: 'A termite bond costs $1,200 per year with no exceptions.' }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
  });
  test('five-figure comma price and "dollars" word form are P0', () => {
    expect(guardrails.findHardcodedPrice('Full tenting runs $12,500 for large homes.')).toBe('$12,500');
    expect(guardrails.findHardcodedPrice('Expect to pay 1,200 dollars up front.')).toBe('1,200 dollars');
  });
  test('single-digit price is P0 — "$9" previously slipped the 2-digit minimum', () => {
    const r = guardrails.evaluate({ body: 'The bait stations cost $9 each at the store.' }, {});
    expect(r.findings.some((f) => f.code === 'HARDCODED_PRICE' && f.severity === 'P0')).toBe(true);
  });
  test('comma-grouped amounts keep the calculator and regulatory exemptions', () => {
    expect(guardrails.findHardcodedPrice('Use our calculator — most quotes land near $1,200 depending on home size.')).toBe(null);
    expect(guardrails.findHardcodedPrice('The county ordinance carries fines of up to $1,000 per violation.')).toBe(null);
  });
  test('findHardcodedPrice is exported for the seo-completion gate (single-sourced policy)', () => {
    expect(typeof guardrails.findHardcodedPrice).toBe('function');
    expect(guardrails.findHardcodedPrice('no price talk here')).toBe(null);
  });
});

describe('brand-token leak: case-insensitive (regression)', () => {
  const spokeDomains = ['sarasotaflpestcontrol.com'];
  test('ALL-CAPS and lowercase brand leak on a spoke like the canonical casing', () => {
    for (const brand of ['WAVES PEST CONTROL', 'waves pest control', 'Waves Pest Control']) {
      const r = guardrails.evaluate({ body: `${brand} treats homes here.` }, { domains: spokeDomains });
      expect(r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK' && f.severity === 'P0')).toBe(true);
    }
  });
  test('hub-anchor exemption still applies regardless of casing', () => {
    const body = 'Backed by [waves pest control in Sarasota](https://www.wavespestcontrol.com/pest-control-sarasota-fl/).';
    const r = guardrails.evaluate({ body }, { domains: spokeDomains });
    expect(r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK')).toBe(false);
  });
});

describe('outbound-link gate (DISALLOWED_EXTERNAL_LINK)', () => {
  test('an off-fleet absolute link is P0 — the injected-spam-backlink shape', () => {
    const r = guardrails.evaluate({ body: 'Read [this guide](https://evil-seo.example/buy-links) for more.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
  test('hub, spoke, and relative internal links are allowed', () => {
    const body = [
      'See [the hub](https://www.wavespestcontrol.com/pest-library/),',
      'the spoke at https://sarasotaflpestcontrol.com/blog/x/,',
      'and [pricing](/pest-control-calculator/).',
    ].join(' ');
    const r = guardrails.evaluate({ body }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('a spam URL hiding in editable meta is scanned too', () => {
    const r = guardrails.evaluate({
      body: 'Clean body copy.',
      frontmatter: { meta_description: 'Best tips — see https://spam.example/x for more.' },
    }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
  test('executable schemes and protocol-relative URLs are P0', () => {
    expect(guardrails.evaluate({ body: '<a href="javascript:alert(1)">x</a>' }, {}).pass).toBe(false);
    expect(guardrails.evaluate({ body: 'Load from //cdn.evil.example/x.js today.' }, {}).pass).toBe(false);
  });
  test('mailto: only allows the business domain', () => {
    expect(guardrails.evaluate({ body: 'Email [us](mailto:info@wavespestcontrol.com).' }, {}).findings
      .some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
    expect(guardrails.evaluate({ body: 'Email [me](mailto:bob@gmail.com).' }, {}).findings
      .some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
  test('prose slashes and path fragments do not trip the protocol-relative check', () => {
    const r = guardrails.evaluate({ body: 'Rates vary and//or depend on size; see src//content notes.' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('CONTENT_ALLOWED_LINK_DOMAINS extends the allowlist without a deploy', () => {
    const prev = process.env.CONTENT_ALLOWED_LINK_DOMAINS;
    process.env.CONTENT_ALLOWED_LINK_DOMAINS = 'entnemdept.ufl.edu, epa.gov';
    try {
      const r = guardrails.evaluate({ body: 'Per [UF/IFAS](https://entnemdept.ufl.edu/creatures/) research.' }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
      const r2 = guardrails.evaluate({ body: 'Per [somewhere](https://other.example/) instead.' }, {});
      expect(r2.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CONTENT_ALLOWED_LINK_DOMAINS;
      else process.env.CONTENT_ALLOWED_LINK_DOMAINS = prev;
    }
  });
});

describe('outbound-link gate: operator-intercept citation exceptions (Codex round 1)', () => {
  test('required_sources hosts are allowed for that draft (binding must-link citations)', () => {
    const r = guardrails.evaluate(
      { body: 'See [the study](https://news.example.org/study-2026) for details.' },
      { requiredSourceUrls: ['https://news.example.org/study-2026'] },
    );
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('operatorCitations allows curated citation hosts, subdomains included, and curated competitor source hosts', () => {
    for (const body of [
      'Per [UF/IFAS](https://entnemdept.ufl.edu/creatures/) research.',
      'Per [Orkin\'s published terms](https://www.orkin.com/terms) as of June 2026.',
      'Per [FDACS](https://www.fdacs.gov/Consumer-Resources) guidance.',
    ]) {
      const r = guardrails.evaluate({ body }, { operatorCitations: true });
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
    }
  });
  test('operatorCitations still blocks non-curated hosts and suffix-spoofed domains', () => {
    expect(guardrails.evaluate({ body: 'Buy [links](https://spam.example/x).' }, { operatorCitations: true })
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(true);
    expect(guardrails.evaluate({ body: 'See https://evil-ufl.edu/x now.' }, { operatorCitations: true })
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(true);
  });
  test('mined drafts (no operator flags) stay internal-only — UF/IFAS still blocks', () => {
    const r = guardrails.evaluate({ body: 'Per [UF/IFAS](https://entnemdept.ufl.edu/creatures/).' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
});

describe('outbound-link gate: unsafe schemes in Markdown destinations (Codex round 1)', () => {
  test('markdown links with javascript:/data: destinations are P0 (no href= text to match)', () => {
    for (const body of ['Click [here](javascript:alert(1)) now.', 'See [this](data:text/html;base64,xyz) file.']) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });
  test('relative markdown destinations are unaffected', () => {
    const r = guardrails.evaluate({ body: 'See [pricing](/pest-control-calculator/) today.' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('outbound-link gate: scheme + mailto hardening (Codex round 2)', () => {
  test('non-http absolute schemes are P0 even to otherwise-benign hosts', () => {
    for (const body of [
      'Grab the [file](ftp://spam.example/x) today.',
      '<a href="ftp://spam.example/x">download</a>',
      'Old-school gopher://archive.example/1 reference.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });
  test('angle-bracketed unsafe Markdown destinations are P0', () => {
    const r = guardrails.evaluate({ body: 'Click [here](<javascript:alert(1)>) now.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
  test('mailto recipient is validated before the query string (endsWith spoof)', () => {
    const r = guardrails.evaluate({ body: 'Email [us](mailto:attacker@gmail.com?subject=info@wavespestcontrol.com).' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
  test('every comma-separated mailto recipient must be on the business domain', () => {
    expect(guardrails.evaluate({ body: 'Email [both](mailto:info@wavespestcontrol.com,bob@gmail.com).' }, {})
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(true);
    expect(guardrails.evaluate({ body: 'Email [both](mailto:info@wavespestcontrol.com,office@wavespestcontrol.com).' }, {})
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('a business mailto with a subject query still passes', () => {
    const r = guardrails.evaluate({ body: 'Email [us](mailto:info@wavespestcontrol.com?subject=Quote%20request).' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('outbound-link gate: schemes WITHOUT :// in link destinations (Codex round 3)', () => {
  test('non-http schemes lacking :// are P0 in markdown, href, and autolink destinations', () => {
    for (const body of [
      'Grab the [file](ftp:spam.example/file) now.',
      '<a href="webcal:evil.example">calendar</a>',
      'Subscribe via <webcal:evil.example/feed> today.',
      'Call <tel:2125551234> now.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });
  test('prose colons, ratios, and angle-bracketed http autolinks do not trip the scheme scan', () => {
    for (const body of [
      'Plain prose with a colon: nothing else here.',
      'The ratio is 3:1 for termite baiting.',
      'Per <https://wavespestcontrol.com/blog/termites/> for details.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
    }
  });
});

describe('outbound-link gate: Waves tel links + no-slash http (Codex round 4)', () => {
  test('the writer-mandated tap-to-call Waves link passes', () => {
    for (const body of [
      'Call us at [(941) 297-5749](tel:+19412975749) for a same-day quote.',
      'Call [(941) 297-2606](tel:9412972606).',
      'Dial <tel:+19412972817> now.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
    }
  });
  test('a tel link to a NON-Waves number is P0', () => {
    const r = guardrails.evaluate({ body: 'Call [me](tel:+12125551234) instead.' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
  test('no-slash http(s) destinations are P0 (browsers navigate them but the host scan never saw them)', () => {
    for (const body of [
      '[spam](http:evil.com) here.',
      '<a href="https:evil.com/x">x</a>',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });
});

describe('outbound-link gate: universal tel validation, reference defs, trailing punctuation (Codex round 5)', () => {
  test('EVERY tel: destination reaches the Waves check — short/vanity forms included', () => {
    for (const body of ['Call [911](tel:911) in an emergency.', 'Call [us](tel:abc).']) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });
  test('Waves tracking lines (twilio-numbers isOwnedNumber) are valid tel targets', () => {
    const r = guardrails.evaluate({ body: 'Tracking line [(941) 326-5011](tel:+19413265011) for Bradenton.' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('reference-style Markdown definitions are scanned like inline destinations', () => {
    for (const body of [
      '[click][bad] link\n\n[bad]: javascript:alert(1)',
      '[click][bad] link\n\n[bad]: ftp:evil.example/x',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
    for (const body of [
      '[ok][ref]\n\n[ref]: /pest-control-calculator/',
      '[ok][ref]\n\n[ref]: https://wavespestcontrol.com/blog/',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
    }
  });
  test('trailing sentence punctuation is trimmed before host validation (no false P0 on legit links)', () => {
    for (const body of [
      'See https://wavespestcontrol.com, then call us.',
      'Visit https://wavespestcontrol.com/blog/. Then decide.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
    }
    // trimming must not open a hole for actually-external hosts
    const spam = guardrails.evaluate({ body: 'See https://spam.example, then run.' }, {});
    expect(spam.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
});
