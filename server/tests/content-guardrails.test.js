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

describe('outbound-link gate: angle-bracket protocol-relative, entity-encoded schemes, mailto headers (Codex round 6)', () => {
  test('angle-bracketed protocol-relative destinations are P0 (inline and reference-style)', () => {
    for (const body of [
      'Click [x](<//evil.example/x>) now.',
      '[x][r] link\n\n[r]: <//evil.example/x>',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });
  test('entity-encoded schemes are decoded before the scan (what the browser sees)', () => {
    for (const body of [
      '<a href="javascript&#58;alert(1)">x</a>',
      '<a href="javascript&#x3a;alert(1)">x</a>',
      '<a href="javascript&colon;alert(1)">x</a>',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
    // single decode, like a browser: &amp;#58; renders as literal text
    const prose = guardrails.evaluate({ body: 'Literal text about &amp;#58; entities in prose.' }, {});
    expect(prose.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('mailto to/cc/bcc query headers are held to the same recipient allowlist', () => {
    const bcc = guardrails.evaluate({ body: 'Email [us](mailto:info@wavespestcontrol.com?bcc=attacker@gmail.com).' }, {});
    expect(bcc.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    const ok = guardrails.evaluate({ body: 'Email [us](mailto:info@wavespestcontrol.com?cc=office@wavespestcontrol.com&subject=Hi).' }, {});
    expect(ok.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('control-char destinations, padded tel digits, semicolon recipients (Codex round 9)', () => {
  test('embedded tab/newline in a link destination is P0 (browsers strip them while parsing)', () => {
    for (const body of [
      '<a href="java&#x09;script:alert(1)">x</a>',
      '[x](java&#10;script:alert(1))',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });
  test('tel links must be a dialable Waves shape — a padded number ending in an owned line is P0', () => {
    for (const body of ['Call [x](tel:9999412975749).', 'Call [x](tel:219412975749).']) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
    expect(guardrails.evaluate({ body: 'Call [(941) 297-5749](tel:+19412975749).' }, {})
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('mailto recipients split on semicolons too (address portion and headers)', () => {
    expect(guardrails.evaluate({ body: 'Email [x](mailto:attacker@gmail.com;info@wavespestcontrol.com?subject=Hi).' }, {})
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    expect(guardrails.evaluate({ body: 'Email [x](mailto:info@wavespestcontrol.com?cc=attacker@gmail.com%3Binfo@wavespestcontrol.com).' }, {})
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    expect(guardrails.evaluate({ body: 'Email [us](mailto:info@wavespestcontrol.com;office@wavespestcontrol.com).' }, {})
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('quoted prices + encoded mailto header names (Codex round 8)', () => {
  test('quoted amounts are hard prices too', () => {
    expect(guardrails.findHardcodedPrice('The plan is "$9" per month flat.')).toBeTruthy();
    expect(guardrails.findHardcodedPrice('He quoted "$1,200" for the bond.')).toBeTruthy();
    // calculator framing still exempts
    expect(guardrails.findHardcodedPrice('Use the calculator to estimate — plans from $45 depend on size.')).toBeNull();
  });
  test('percent-encoded mailto header NAMES are decoded before the to/cc/bcc check', () => {
    const r = guardrails.evaluate({ body: 'Email [x](mailto:info@wavespestcontrol.com?b%63c=attacker@gmail.com).' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
});

describe('outbound-link gate: encoded mailto separators, IP/localhost hosts, semicolonless entities (Codex round 7)', () => {
  test('percent-encoded separators in the mailto address are decoded before allowlisting', () => {
    const spoof = guardrails.evaluate({ body: 'Email [x](mailto:attacker@gmail.com%2Cinfo@wavespestcontrol.com).' }, {});
    expect(spoof.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    const ok = guardrails.evaluate({ body: 'Email [us](mailto:info@wavespestcontrol.com%2Coffice@wavespestcontrol.com).' }, {});
    expect(ok.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('protocol-relative IP, IPv6, and localhost destinations are P0 (no alphabetic TLD required)', () => {
    for (const body of [
      'Click [x](//127.0.0.1/x) now.',
      'Load //192.168.1.1/x today.',
      '<a href="//localhost/x">x</a>',
      'Try [x](//[::1]/admin) now.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
    // prose slashes still don't trip
    const prose = guardrails.evaluate({ body: 'Rates vary and//or depend on size.' }, {});
    expect(prose.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
  test('semicolonless numeric entities decode like a browser (greedy digit consumption included)', () => {
    // decimal: 'a' is not a decimal digit, so &#58alert(1) is a live javascript: link
    const dec = guardrails.evaluate({ body: '<a href="javascript&#58alert(1)">x</a>' }, {});
    expect(dec.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    // hex: '/' stops consumption, so &#x3a//evil is a live javascript: link
    const hex = guardrails.evaluate({ body: '<a href="javascript&#x3a//evil.example">x</a>' }, {});
    expect(hex.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    // browser parity, not over-blocking: &#x3aalert greedily consumes "3aa"
    // (U+03AA) — a browser does NOT produce a javascript: link there, and
    // neither do we; plain prose references stay clean
    const prose = guardrails.evaluate({ body: 'Item &#10 on the list is fine prose.' }, {});
    expect(prose.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('MDX expression props, unquoted destinations, decoded mailto controls (Codex round 10)', () => {
  test('JSX string-expression link props are scheme-scanned (posts publish as MDX)', () => {
    // React renders href={"javascript:..."} as a real link destination — the
    // quote-anchored attribute regex alone never saw inside the braces.
    const dq = guardrails.evaluate({ body: '<a href={"javascript:alert(1)"}>x</a>' }, {});
    expect(dq.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    const sq = guardrails.evaluate({ body: "<a href={'data:text/html,hi'}>x</a>" }, {});
    expect(sq.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    // internal path in an expression prop is fine
    const ok = guardrails.evaluate({ body: '<a href={"/services/pest-control"}>x</a>' }, {});
    expect(ok.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });

  test('unquoted href/src values fail closed on embedded control characters', () => {
    // The HTML tokenizer appends character-reference results to an unquoted
    // value without terminating it, so href=java&#x09;script: really is a
    // tab-smuggled javascript: link that the contiguous scheme regex misses.
    const r = guardrails.evaluate({ body: '<a href=java&#x09;script:alert(1)>x</a>' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });

  test('mailto addresses and headers that DECODE to control characters are P0', () => {
    // %0A/%0D become separators/header breaks in mail clients: the split on
    // [,;] left "attacker@x\ninfo@waves…" as ONE string that happens to end
    // on the allowed domain.
    const addr = guardrails.evaluate({ body: 'Email [x](mailto:attacker@gmail.com%0Ainfo@wavespestcontrol.com).' }, {});
    expect(addr.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    const header = guardrails.evaluate({ body: 'Email [x](mailto:info@wavespestcontrol.com?cc=attacker@gmail.com%0Dinfo@wavespestcontrol.com).' }, {});
    expect(header.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    // clean single- and multi-recipient mailtos still pass
    const ok = guardrails.evaluate({ body: 'Email [us](mailto:info@wavespestcontrol.com?cc=office@wavespestcontrol.com).' }, {});
    expect(ok.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('template-literal / dynamic JSX props, LF-smuggled unquoted values (Codex round 11)', () => {
  test('template-literal link props are scheme-scanned like quoted ones', () => {
    const js = guardrails.evaluate({ body: '<a href={`javascript:alert(1)`}>x</a>' }, {});
    expect(js.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    const data = guardrails.evaluate({ body: '<img src={`data:text/html,hi`}>' }, {});
    expect(data.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    // a plain internal-path template literal is still fine
    const ok = guardrails.evaluate({ body: '<a href={`/services/pest-control`}>x</a>' }, {});
    expect(ok.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });

  test('NON-literal JSX expression destinations fail closed (interpolation, concatenation, identifiers)', () => {
    // A computed destination cannot be statically validated at all — the
    // scheme regexes only ever see contiguous literals, so anything dynamic
    // is P0 by policy rather than trusting what the pieces look like.
    for (const body of [
      '<a href={`java${"x"}script:alert(1)`}>x</a>',
      "<a href={'java'+'script:alert(1)'}>x</a>",
      '<a href={someVar}>x</a>',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });

  test('unquoted values fail closed on decoded LINE FEEDS too, without false-failing multi-line JSX', () => {
    // &#10; decodes to \n INSIDE an unquoted value (the tokenizer does not
    // terminate on a decoded reference), same smuggling class as tab/CR.
    const lf = guardrails.evaluate({ body: '<a href=java&#10;script:alert(1)>x</a>' }, {});
    expect(lf.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    // ...but a real newline BETWEEN props (formatted JSX, no colon in the
    // value) is formatting, not smuggling — the arm requires the scheme colon.
    const formatted = guardrails.evaluate({ body: '<a href=/services\n  target=_blank>book</a>' }, {});
    expect(formatted.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('case-insensitive control-character destination scan (Codex round 12)', () => {
  test('uppercase HREF/SRC hit the control-char arms like lowercase (browsers are case-insensitive)', () => {
    for (const body of [
      '<a HREF="java&#x09;script:alert(1)">x</a>',
      '<img SRC=java&#10;script:alert(1)>',
      '<a Href={`java&#x0d;script:alert(1)`}>x</a>',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
    // clean uppercase attribute is not a false positive
    const ok = guardrails.evaluate({ body: '<a HREF="/services/pest-control">x</a>' }, {});
    expect(ok.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('named control entities + literal-vs-entity unquoted controls (Codex round 13)', () => {
  test('&Tab;/&NewLine; named references decode like the numeric control forms', () => {
    for (const body of [
      '<a href="java&Tab;script:alert(1)">x</a>',
      '<a href=java&NewLine;script:alert(1)>x</a>',
      'Click [x](java&Tab;script:alert(1)) now.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });

  test('a LEADING entity control in an unquoted value fails closed too', () => {
    // The tokenizer keeps a char-reference control at the START of an
    // unquoted value; URL parsing then strips it, leaving javascript: live.
    const r = guardrails.evaluate({ body: '<a href=&#9;javascript:alert(1)>x</a>' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });

  test('literal newline between unquoted props never false-fails — even with a colon in a later prop', () => {
    // The sentinel design distinguishes what the round-11 colon heuristic
    // could not: a literal control TERMINATES an unquoted value (plain
    // formatting), only entity-decoded controls stay inside it.
    const r = guardrails.evaluate({ body: '<a href=/services\n aria-label="Pest: control">book</a>' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });

  test('entity-decoded control inside a mailto address is P0 (sentinel is a C0 control)', () => {
    const r = guardrails.evaluate({ body: 'Email [x](mailto:attacker@gmail.com&#10;info@wavespestcontrol.com).' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
});

describe('CRLF in non-recipient mailto headers (Codex round 14)', () => {
  test('decoded CR/LF in subject/body headers is P0 — header separators smuggle recipients', () => {
    // ?subject=Hi%0Abcc:attacker@… — the old order skipped non-recipient
    // keys BEFORE decoding, so the injected line break never got checked.
    const subj = guardrails.evaluate({ body: 'Email [x](mailto:info@wavespestcontrol.com?subject=Hi%0Abcc:attacker@gmail.com).' }, {});
    expect(subj.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    const bodyHdr = guardrails.evaluate({ body: 'Email [x](mailto:info@wavespestcontrol.com?body=Hello%0Dbcc:attacker@gmail.com).' }, {});
    expect(bodyHdr.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });
  test('control-clean non-recipient headers still pass', () => {
    const r = guardrails.evaluate({ body: 'Email [us](mailto:info@wavespestcontrol.com?subject=Service%20question).' }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});
