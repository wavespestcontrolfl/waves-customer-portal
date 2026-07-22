// The SERVICE_HUB_LINKS drift guard below loads content-brief-builder, which
// pulls in db/logger at module scope — mock both so this stays a pure unit
// suite (nothing else here touches them).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

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

describe('JSX spread attributes fail closed (Codex round 16)', () => {
  test('spread-delivered href has no literal href= token — any "{..." is P0', () => {
    for (const body of [
      '<a {...{href:"javascript:alert(1)"}}>x</a>',
      '<a { ...linkProps }>book now</a>',
      '<img {...imgProps} alt="lawn" />',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
    }
  });
  test('spread-free drafts with normal links, braces, and prose ellipses still pass', () => {
    const r = guardrails.evaluate({
      body: 'Chinch bugs damage lawns fast... and quietly. See our [treatment plans](/services/lawn-care) or <a href="/contact">contact us</a> today.',
    }, {});
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('product-claim guard (P1 PRODUCT_CLAIM)', () => {
  test('professional product brand blocks', () => {
    const r = guardrails.evaluate({ body: 'The gel pros reach for is Advion — place pea-sized dabs along the trail.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM' && f.severity === 'P1')).toBe(true);
  });

  test('active ingredient blocks', () => {
    const r = guardrails.evaluate({ body: 'Look for a bait whose active ingredient is indoxacarb for slow knockdown.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });

  test('tech inventory claim blocks', () => {
    const r = guardrails.evaluate({ body: 'A sweet gel — which is what our techs carry on every ant call.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });

  test('product claim hiding in meta description blocks', () => {
    const r = guardrails.evaluate({ body: 'Generic bait guidance.', frontmatter: { meta_description: 'Why Termidor is the pro choice for SWFL ants.' } }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });

  test('consumer-brand cautionary mention and generic class language pass', () => {
    const r = guardrails.evaluate({ body: 'Do not blast the trail with Raid or Ortho Home Defense. Use a slow-acting, sugar-based bait gel labeled for indoor use instead, and homemade borax bait is risky to dose.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
  });

  test('professional product as an informational TOPIC passes (no recommendation context)', () => {
    const r = guardrails.evaluate({
      body: 'Bait stations target the colony itself.',
      frontmatter: { title: 'Sentricon in Southwest Florida', meta_description: 'How termite bait stations work in Southwest Florida sandy soil, and what a monitored bait program actually covers for SWFL homeowners.' },
    }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
  });
});

describe('prevention-promise guard (P1 PREVENTION_PROMISE)', () => {
  test('"keeps them from coming back" blocks', () => {
    const r = guardrails.evaluate({ body: 'Sealing the slab gap keeps the ants from coming back next month.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE' && f.severity === 'P1')).toBe(true);
  });

  test('"prevents next month\'s trail" blocks', () => {
    const r = guardrails.evaluate({ body: 'A quarterly program prevents next month’s trail entirely.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('guaranteed elimination blocks', () => {
    const r = guardrails.evaluate({ body: 'Our approach is guaranteed elimination of roaches in one visit.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('"gets rid of ants for good" blocks', () => {
    const r = guardrails.evaluate({ body: 'This plan gets rid of the ants for good.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('reduced-recurrence + callback phrasing passes', () => {
    const r = guardrails.evaluate({ body: 'No honest company will promise you will never see another ant. A quarterly program reduces recurrence, and if ants flare up between visits the re-treatment is free. Prevention tips: fix moisture, trim landscaping. Whenever storms hit, expect scouts.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
  });

  test('non-pest "prevents X from" phrasing passes', () => {
    const r = guardrails.evaluate({ body: 'A door sweep prevents rainwater from pooling at the threshold, and mulch spacing prevents moisture buildup along the slab.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
  });
});

describe('product-claim guard — round-2 hardening (Codex findings)', () => {
  test('passive usage claim blocks ("Advion is applied…")', () => {
    const r = guardrails.evaluate({ body: 'Advion is applied in pea-sized dabs along ant trails.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });

  test('inventory "rely on" phrasing blocks', () => {
    const r = guardrails.evaluate({ body: 'Our technicians rely on Advion for sweet-feeding ants.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });

  test('efficacy claims after the brand block', () => {
    for (const body of ['Advion works best for ants in Florida kitchens.', 'Advion kills ants quickly and quietly.']) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
    }
  });

  test('ambiguous brand words in ordinary prose pass', () => {
    const r = guardrails.evaluate({ body: 'Use these prevention steps in tandem, and use labeled bait to target phantom ants on the premises.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
  });

  test('ambiguous brand word next to a product noun blocks', () => {
    const r = guardrails.evaluate({ body: 'A can of Phantom aerosol handles the voids.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });
});

describe('prevention-promise guard — round-2 hardening (Codex findings)', () => {
  test('a later promise is caught even after an exempt disclaimer of the same shape', () => {
    const r = guardrails.evaluate({ body: 'No honest company will promise you will never see another ant. Our service means you will never see another ant.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('future-period promise requires a pest object', () => {
    const ok = guardrails.evaluate({ body: 'Autopay prevents next month’s water bill surprise.' }, {});
    expect(ok.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
    const bad = guardrails.evaluate({ body: 'One treatment prevents next month’s ant trail.' }, {});
    expect(bad.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('bare service-subject promises block', () => {
    for (const body of [
      'This quarterly treatment prevents infestations.',
      'Our treatment eliminates ants in your home.',
      'A professional application eradicates cockroaches.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
    }
  });

  test('qualifier promises block (comparison-table row shape)', () => {
    const r = guardrails.evaluate({ body: '<ComparisonTable rows={[{"label":"Prevents future infestations","values":["No","Yes"]}]} />' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('question framing and homeowner how-to phrasing stay legal', () => {
    const r = guardrails.evaluate({ body: 'How do I get rid of sugar ants? This guide walks you through the bait-first plan that reduces recurrence, and these steps make it harder for the next scout.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
  });
});

describe('prevention-promise guard — round-3 hardening (Codex findings)', () => {
  test('a disclaimer cannot shield a promise in the NEXT sentence', () => {
    const r = guardrails.evaluate({ body: 'No honest company can promise permanent prevention. Our treatment eliminates ants.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('same-sentence disclaimer still exempts', () => {
    const r = guardrails.evaluate({ body: 'No honest company will promise you will never see another ant, and we will not either.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
  });

  test('past-tense passive product usage blocks', () => {
    const r = guardrails.evaluate({ body: 'Advion was applied in pea-sized dabs along ant trails.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });
});

describe('prevention/product guards — round-4 hardening (Codex findings)', () => {
  test('a disclaimer cannot shield a coordinated promise in the SAME sentence', () => {
    const r = guardrails.evaluate({ body: 'No honest company will promise you will never see another ant, but our service eliminates ants.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('the claim directly governed by the negated promise stays exempt', () => {
    const r = guardrails.evaluate({ body: 'No honest company will promise you will never see another ant — Florida does not work that way.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
  });

  test('non-product tool/inventory statements pass', () => {
    const r = guardrails.evaluate({ body: 'Our team uses inspection notes to tailor each visit, and our technicians use moisture meters to find leaks.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
  });

  test('product-context inventory statements still block', () => {
    const r = guardrails.evaluate({ body: 'Our techs carry more than one bait on every ant call.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });
});

describe('guards — round-5 polish (Codex findings)', () => {
  test('product noun must be the OBJECT of the inventory verb', () => {
    const ok = guardrails.evaluate({ body: 'Our team uses inspection notes to decide where bait should go.' }, {});
    expect(ok.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
    const bad = guardrails.evaluate({ body: 'Our techs carry more than one bait on every ant call.' }, {});
    expect(bad.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });

  test('"we don\'t promise" disclaimers are exempt', () => {
    const r = guardrails.evaluate({ body: 'We don’t promise you will never see another ant.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
  });

  test('"ants will never come back" blocks', () => {
    const r = guardrails.evaluate({ body: 'Our treatment means the ants will never come back.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });
});

// Round 8 (Codex P1): DIRECTLY negated claims are the honest disclaimers the
// gate exists to encourage — they must be exempt, while every affirmative
// shape from rounds 1-5 keeps flagging.
describe('prevention-promise guard — round-8 hardening (directly negated claims)', () => {
  test('"does not eliminate" disclaimers are exempt (the flagged case)', () => {
    const r = guardrails.evaluate({ body: 'This treatment does not eliminate ants.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
  });

  test('"won\'t eliminate" disclaimers are exempt — curly AND straight apostrophes', () => {
    for (const body of ['This treatment won’t eliminate ants.', "This treatment won't eliminate ants."]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
    }
  });

  test('two-word auxiliary negation in the subject gap is exempt ("will not eliminate")', () => {
    const r = guardrails.evaluate({ body: 'The treatment will not eliminate ants overnight.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
  });

  test('other negated auxiliaries in the subject gap are exempt (cannot / doesn\'t)', () => {
    for (const body of [
      'This treatment cannot eliminate the ants on its own.',
      'Our service doesn’t eliminate the ants overnight.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
    }
  });

  test('direct negation before a VERB-anchored pattern is exempt too', () => {
    for (const body of [
      // pattern: "prevents <pest> from returning" — negated
      'A single visit will not prevent ants from returning.',
      // pattern: "prevents all/every <pest>" — negated
      'Even a professional treatment cannot prevent all ants.',
      // pattern: "guaranteed elimination" — negated determiner
      'There is no guaranteed elimination in Florida pest work.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
    }
  });

  test('the bare affirmative promise still flags P1 (no round-1..5 regression)', () => {
    for (const body of [
      'This treatment prevents ants.',
      'This quarterly treatment prevents infestations.',
      'Our treatment eliminates ants in your home.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE' && f.severity === 'P1')).toBe(true);
    }
  });

  test('"not only prevents" is an AFFIRMATIVE claim and still flags', () => {
    const r = guardrails.evaluate({ body: 'This treatment not only prevents ants, it starves the colony.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('a disclaimer still cannot shield a coordinated promise (round-4 shape intact)', () => {
    const r = guardrails.evaluate({ body: 'No honest company will promise you will never see another ant, but our service eliminates ants.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });

  test('"Nothing stops ants…" hype is NOT treated as negation and still flags', () => {
    const r = guardrails.evaluate({ body: 'Nothing stops ants from coming back like our quarterly program.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });
});

// Round 9 (Codex P2 x3): label-reading compliance copy, choice-verb product
// recommendations, and subject-negated disclaimers.
describe('product/prevention guards — round-9 hardening (Codex findings)', () => {
  test('label-following compliance copy is NOT an inventory claim', () => {
    for (const body of [
      'Our technicians use the product label to choose safe placement.',
      'Our techs use the bait label to set re-entry expectations.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
    }
  });

  test('real inventory claims still flag after the label carve-out', () => {
    for (const body of [
      'Our techs carry more than one bait on every ant call.',
      'Our technicians use a professional gel in wall voids.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
    }
  });

  test('ambiguous-brand adjacency keeps "label" ("the Premise label" still flags)', () => {
    const r = guardrails.evaluate({ body: 'Always read the Premise label before treating.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(true);
  });

  test('choice-verb recommendations of professional products flag', () => {
    for (const body of [
      'Choose Advion for ants.',
      'For sugar ants, select Termidor along the slab.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM' && f.severity === 'P1')).toBe(true);
    }
  });

  test('choice verbs without a professional product stay legal', () => {
    const r = guardrails.evaluate({ body: 'Choose a licensed professional instead of DIY sprays, and select a service cadence that fits your home.' }, {});
    expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
  });

  test('subject-negated prevention disclaimers are exempt', () => {
    for (const body of [
      'No service prevents all ants.',
      'No treatment eliminates ants forever.',
      'No single quarterly plan prevents every infestation.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
    }
  });

  test('subject negation does NOT leak past punctuation or "no matter"', () => {
    for (const body of [
      'With no contract, our treatment eliminates ants for good.',
      'No matter what, our treatment gets rid of the ants for good.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
    }
  });

  test('promotional inversions still flag after the subject-negation carve-out (round-8 pin)', () => {
    const r = guardrails.evaluate({ body: 'Nothing stops ants from coming back like our quarterly program.' }, {});
    expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
  });
});

// Round 10 (Codex P2 x2): product-as-topic "how <product> works" copy and
// educational question/how-to prevention titles are the writer's bread and
// butter — they must pass, while efficacy claims and affirmative promises
// keep flagging exactly as every prior round pinned them.
describe('product/prevention guards — round-10 hardening (Codex findings)', () => {
  test('"How Sentricon works" product-as-topic copy passes (title AND body)', () => {
    const viaTitle = guardrails.evaluate({
      body: 'Bait stations target the colony itself.',
      frontmatter: { title: 'How Sentricon works in Southwest Florida', meta_description: 'What a monitored termite bait program actually does in SWFL sandy soil, and how a colony-level approach differs from liquid treatments for area homeowners.' },
    }, {});
    expect(viaTitle.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
    const viaBody = guardrails.evaluate({ body: 'Sentricon works by intercepting foraging termites before they reach the slab.' }, {});
    expect(viaBody.findings.some((f) => f.code === 'PRODUCT_CLAIM')).toBe(false);
  });

  test('efficacy "works" claims still flag after the topic carve-out', () => {
    for (const body of [
      'Termidor works better than anything else on the market.',
      'Sentricon works guaranteed.',
      'Advion works best for ants in Florida kitchens.',
      'Advion really works on sweet-feeding ants.',
      'Termidor works every time along the slab.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PRODUCT_CLAIM' && f.severity === 'P1')).toBe(true);
    }
  });

  test('educational how-to prevention titles pass', () => {
    for (const body of [
      'How to prevent ants from coming back',
      'Steps to keep ants from coming back after treatment.',
      'To prevent ants from getting in, seal the weep holes and fix the moisture first.',
      'How to keep your kitchen pest-free between visits.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
    }
  });

  test('prevention QUESTIONS pass (fronted-auxiliary inversion)', () => {
    for (const body of [
      'Can pest control prevent ants from coming back?',
      'Will a quarterly treatment stop ants from returning?',
      'How do exterminators keep roaches from coming back?',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(false);
    }
  });

  test('affirmative promises still flag after the question/how-to carve-out', () => {
    for (const body of [
      'Our service prevents ants from coming back.',
      'We prevent ants from coming back.',
      'Our treatment is designed to prevent ants from coming back.',
      'This program is guaranteed to keep ants from coming back.',
      // question WRAPPER around an inflected embedded promise is still a promise
      'Did you know our treatment prevents ants from coming back?',
      'This is how our treatment prevents ants from coming back.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE' && f.severity === 'P1')).toBe(true);
    }
  });

  test('every prior round\'s pinned bypass shape still flags', () => {
    for (const body of [
      'Sealing the slab gap keeps the ants from coming back next month.', // round 1
      'No honest company will promise you will never see another ant, but our service eliminates ants.', // round 4
      'This treatment not only prevents ants, it starves the colony.', // round 8
      'Nothing stops ants from coming back like our quarterly program.', // rounds 8+9
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'PREVENTION_PROMISE')).toBe(true);
    }
  });
});

// ── writer-hardening gates (uncataloged components, citation residue,
//    off-footprint service claims, invented internal routes) ─────────────

describe('MDX component allowlist (UNCATALOGED_COMPONENT)', () => {
  test('SAFE_MDX_COMPONENTS mirrors the reconciled astro catalog∩renderer set', () => {
    // wavespestcontrol-astro PR #342 reconciled packages/blog-schema/schema.ts
    // COMPONENT_NAMES with BlogPostLayout.astro mdxComponents to exactly this
    // set — a portal drift from it re-opens the parked-PR defect class.
    expect([...guardrails.SAFE_MDX_COMPONENTS].sort()).toEqual([
      'AppPhone', 'BottomLineBox', 'ComparisonTable', 'HomeZoneMap',
      'HonestRejection', 'PestEvidenceGrid', 'SeasonalPressureChart',
    ]);
  });

  test('all safe components pass, including the writer favorites', () => {
    const body = [
      '<SeasonalPressureChart />',
      '<HomeZoneMap title="Where we treat" zones={[{ label: "Eaves", note: "wasp nests" }]} />',
      '<PestEvidenceGrid />',
      '<ComparisonTable columns={["What you get","DIY","Pro"]} rows={[{ label: "Speed", values: ["Slow","Fast"] }]} />',
      '<BottomLineBox verdict="Treat now" recommendation="Book an inspection" />',
      '<HonestRejection audience="One-off wasp nest" reason="A can of spray fixes it" />',
    ].join('\n\n');
    const r = guardrails.evaluate({ body }, {});
    expect(r.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(false);
  });

  test('a component outside the safe set is P0 and fails the gate', () => {
    const r = guardrails.evaluate({ body: 'Compare tiers below.\n\n<WaveGuardLadder tier="Gold" />' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT' && f.severity === 'P0')).toBe(true);
  });

  test('phantom-catalog names removed by the reconciliation are blocked too', () => {
    for (const name of ['WhyTrustUs', 'TLDR', 'DataCallout', 'ProTip', 'FAQBlock']) {
      const r = guardrails.evaluate({ body: `<${name} />` }, {});
      expect(r.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(true);
    }
  });

  test('lowercase HTML tags and comparison prose are not components', () => {
    const r = guardrails.evaluate({ body: 'Ants march <br /> onward. Colonies of <a href="/pest-control-quote/">1,000s</a> form fast.' }, {});
    expect(r.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(false);
  });

  test('refresh drafts skip the component gate (legacy live bodies)', () => {
    const r = guardrails.evaluate({ body: '<AppLegacyWidget /> refreshed copy.' }, { isRefresh: true });
    expect(r.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(false);
  });
});

describe('citation-token residue (CITATION_TOKEN_RESIDUE)', () => {
  test('<cite index="N"> markup is P0', () => {
    const r = guardrails.evaluate({ body: 'Drywood termites swarm in spring <cite index="7">UF/IFAS</cite>.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'CITATION_TOKEN_RESIDUE' && f.severity === 'P0')).toBe(true);
  });

  test('bare index="N" token residue is P0', () => {
    const r = guardrails.evaluate({ body: 'Swarm season peaks in April index="12" across Sarasota.' }, {});
    expect(r.findings.some((f) => f.code === 'CITATION_TOKEN_RESIDUE')).toBe(true);
  });

  test('citation residue hiding in editable meta is caught too', () => {
    const r = guardrails.evaluate({
      body: 'Clean body copy.',
      frontmatter: { meta_description: 'Termite guide <cite index="1"> for Sarasota homeowners.' },
    }, {});
    expect(r.findings.some((f) => f.code === 'CITATION_TOKEN_RESIDUE')).toBe(true);
  });

  test('prose attribution and component props pass clean', () => {
    const r = guardrails.evaluate({
      body: 'Per UF/IFAS, chinch bugs peak in July. <ComparisonTable columns={["A","B"]} rows={[{ label: "x", values: ["1","2"] }]} highlight={1} />',
    }, {});
    expect(r.findings.some((f) => f.code === 'CITATION_TOKEN_RESIDUE')).toBe(false);
  });

  test('markdown footnote apparatus blocks (marker and definition)', () => {
    for (const body of [
      'Drywood termites swarm in spring.[^1]',
      '[^1]: UF/IFAS entomology circular 122.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'CITATION_TOKEN_RESIDUE')).toBe(true);
    }
  });
});

describe('off-footprint service claims (OFF_FOOTPRINT_CITY_CLAIM)', () => {
  test('service claim naming an out-of-area city is P0', () => {
    const r = guardrails.evaluate({
      body: 'Our technicians proudly serve Fort Myers homeowners with same-day treatments.',
    }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM' && f.severity === 'P0')).toBe(true);
  });

  test('CTA framing near an out-of-area city blocks (schedule/book/call)', () => {
    for (const body of [
      'Schedule your Naples home inspection today.',
      'Book a visit for your Cape Coral lawn this week.',
      'Call now — Tampa homeowners love our approach to your yard.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
  });

  test('bare educational mentions pass (both directions of the fix)', () => {
    const r = guardrails.evaluate({
      body: 'Tegu lizards spread north from Fort Myers over the past decade, and Naples researchers have tracked cane toads since 2015. None of that changes what Bradenton yards deal with.',
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('service claims naming footprint cities pass', () => {
    const r = guardrails.evaluate({
      body: 'We serve Bradenton, Sarasota, Venice, and Punta Gorda — schedule your home treatment today.',
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('a service claim hiding in editable meta is caught', () => {
    const r = guardrails.evaluate({
      body: 'Clean educational body.',
      frontmatter: { meta_description: 'Serving Bonita Springs homes with pest control you can trust.' },
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('honest out-of-area disclaimers pass (Codex round 1)', () => {
    for (const body of [
      'Fort Myers is outside our service area — if you are in Bradenton, schedule a visit instead.',
      'Our service area doesn’t include Tampa, so check with a licensed local company there.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    }
  });

  test('a disclaimer clause does not shield an affirmative claim in the next clause', () => {
    const r = guardrails.evaluate({
      body: 'Naples is outside our service area, but we treat Tampa yards every week.',
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('abbreviated city spellings are caught (Ft. Myers)', () => {
    const r = guardrails.evaluate({
      body: 'Our techs treat Ft. Myers homes on the same schedule.',
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('bare team mentions without an operation verb pass (factual references)', () => {
    const r = guardrails.evaluate({
      body: 'Our team reviewed Miami termite research before writing this guide.',
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('an unpunctuated heading never merges with the next block', () => {
    const r = guardrails.evaluate({
      body: '## Miami termite records\n\nOur techs treat Sarasota homes on quarterly visits.',
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('bare-conjunction clauses do not let a disclaimer shield a claim', () => {
    for (const body of [
      'Naples is outside our service area but we treat Tampa yards weekly.',
      'Naples is outside our service area and we treat Tampa yards weekly.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
  });

  test('a negation about some other service does not shield a city claim', () => {
    const r = guardrails.evaluate({
      body: "Waves Pest Control serves Naples with quarterly pest plans that don't include termite coverage.",
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('city-scoped negation passes ("does not include Tampa")', () => {
    const r = guardrails.evaluate({ body: 'Our service area doesn’t include Tampa.' }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('a soft-wrapped paragraph is scanned as one rendered sentence', () => {
    const r = guardrails.evaluate({
      body: 'From Sarasota to Cape Coral,\nwe treat the same trouble spots.',
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('third-person "now serving" brand claim is caught; footprint version passes', () => {
    const blocked = guardrails.evaluate({ body: 'Waves Pest Control is now serving customers in Naples.' }, {});
    expect(blocked.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const fine = guardrails.evaluate({ body: 'Waves Pest Control is now serving customers in Sarasota and Bradenton.' }, {});
    expect(fine.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('a service claim hiding in hero alt is caught', () => {
    const r = guardrails.evaluate({
      body: 'Clean educational body.',
      frontmatter: { hero_image: { alt: 'Waves technician serving a Cape Coral home with your lawn treatment' } },
    }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('outOfAreaCities derives against CITY_TO_LOCATION (footprint cities never blocklisted)', () => {
    const { CITY_TO_LOCATION } = require('../config/locations');
    const list = guardrails.outOfAreaCities();
    expect(list).toContain('Fort Myers');
    for (const city of list) {
      expect(CITY_TO_LOCATION[city.toLowerCase()]).toBeUndefined();
    }
  });
});

describe('internal-route allowlist (UNKNOWN_INTERNAL_ROUTE)', () => {
  test('an invented internal route is P0 (the /pest-library/fleas/ defect)', () => {
    const r = guardrails.evaluate({ body: 'Read our [flea guide](/pest-library/fleas/) for details.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE' && f.severity === 'P0')).toBe(true);
  });

  test('allowlisted routes, city-service patterns, images, and anchors pass', () => {
    const body = [
      'Get a [quote](/pest-control-quote/) or [book online](/book/).',
      'Numbers live in the [calculator](/pest-control-calculator/).',
      'See [WaveGuard](/waveguard-memberships/) and the [pest library](/pest-library/).',
      'City pages: [Bradenton](/pest-control-bradenton-fl/) and [Sarasota quotes](/pest-control-quote-sarasota-fl/).',
      '![Chinch bug damage](/images/blog/chinch-bugs/damage.webp)',
      'Jump to the [FAQ](#faq).',
    ].join('\n');
    const r = guardrails.evaluate({ body }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('query strings, fragments, and missing trailing slashes normalize before matching', () => {
    const r = guardrails.evaluate({
      body: '[quote](/pest-control-quote?utm_source=blog) and [book](/book#today) and [hub](/termite-inspection)',
    }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('href attribute destinations are policed too', () => {
    const r = guardrails.evaluate({ body: 'Visit <a href="/totally-invented-page/">this page</a> now.' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
  });

  test('brief-mandated links are allowed via allowedInternalLinks', () => {
    const body = 'Curated: [hub](/pest-control-sarasota-fl/) plus [special](/lawn-care/fall-armyworm-outbreak/).';
    const blocked = guardrails.evaluate({ body }, {});
    expect(blocked.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    const allowed = guardrails.evaluate({ body }, { allowedInternalLinks: ['/lawn-care/fall-armyworm-outbreak/'] });
    expect(allowed.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('member-expression components are rejected (Codex round 2)', () => {
    const r = guardrails.evaluate({ body: 'See <ComparisonTable.Row label="x" /> for details.' }, {});
    expect(r.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(true);
  });

  test('expanded FL metros are blocked; St. Augustine (the grass) never is', () => {
    const blocked = guardrails.evaluate({ body: 'We treat Orlando homes on the same quarterly schedule.' }, {});
    expect(blocked.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const grass = guardrails.evaluate({ body: 'We treat your St. Augustine lawn for chinch bugs every quarter.' }, {});
    expect(grass.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('hub-host absolute URLs are policed as internal routes (Codex round 2)', () => {
    const dead = guardrails.evaluate({ body: '[flea guide](https://www.wavespestcontrol.com/pest-library/fleas/)' }, {});
    expect(dead.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    const fine = guardrails.evaluate({ body: '[quote](https://www.wavespestcontrol.com/pest-control-quote/) and [external](https://ipm.ufl.edu/some/page/)' }, { requiredSourceUrls: ['https://ipm.ufl.edu/some/page/'] });
    expect(fine.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('checked_existing_routes on the draft are allowed link targets (Codex round 2)', () => {
    const body = 'We covered this in our [ghost ant guide](/pest-control/ghost-ants/).';
    const blocked = guardrails.evaluate({ body }, {});
    expect(blocked.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    const allowed = guardrails.evaluate({ body, checked_existing_routes: ['/pest-control/ghost-ants/'] }, {});
    expect(allowed.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('reference-style definitions are policed too (Codex round 1)', () => {
    const r = guardrails.evaluate({ body: 'See the [flea guide][flea].\n\n[flea]: /pest-library/fleas/\n' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
  });

  test('/contact/ is allowlisted (lawn and tree-shrub CTA target)', () => {
    const r = guardrails.evaluate({ body: 'Reach us on the [contact page](/contact/).' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('city-service links to out-of-footprint cities block; footprint cities pass', () => {
    const blocked = guardrails.evaluate({ body: '[Fort Myers pest control](/pest-control-fort-myers-fl/)' }, {});
    expect(blocked.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    const allowed = guardrails.evaluate({ body: '[Lakewood Ranch pest control](/pest-control-lakewood-ranch-fl/) and [North Port quotes](/pest-control-quote-north-port-fl/)' }, {});
    expect(allowed.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('refresh without a prior body fails CLOSED with a P1 park (Codex round 5)', () => {
    const r = guardrails.evaluate({ body: 'Old page links to [legacy](/some-2019-era-page/).' }, { isRefresh: true });
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
    expect(r.findings.some((f) => f.code === 'REFRESH_PRIOR_BODY_UNAVAILABLE' && f.severity === 'P1')).toBe(true);
    expect(r.pass).toBe(false);
  });

  test('refresh grandfathers prior-body links/components but gates writer additions (Codex round 3)', () => {
    const priorBody = 'Live page links to [legacy](/some-2019-era-page/) and embeds <WhyTrustUs />.';
    const preserved = guardrails.evaluate({
      body: 'Refreshed copy keeps [legacy](/some-2019-era-page/) and <WhyTrustUs /> intact.',
    }, { isRefresh: true, priorBody });
    expect(preserved.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE' || f.code === 'UNCATALOGED_COMPONENT')).toBe(false);
    const addedLink = guardrails.evaluate({
      body: 'Refreshed copy keeps [legacy](/some-2019-era-page/) but adds [fleas](/pest-library/fleas/).',
    }, { isRefresh: true, priorBody });
    expect(addedLink.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    const addedComponent = guardrails.evaluate({
      body: 'Refreshed copy adds <DataCallout stat="7" />.',
    }, { isRefresh: true, priorBody });
    expect(addedComponent.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(true);
  });

  test('autolinks and bare hub URLs are policed (Codex round 3)', () => {
    for (const body of [
      'See <https://www.wavespestcontrol.com/pest-library/fleas/> for details.',
      'More at https://www.wavespestcontrol.com/pest-library/fleas/ today.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    }
  });

  test('angle-bracketed reference destinations normalize cleanly (Codex round 3)', () => {
    const r = guardrails.evaluate({ body: 'Get a [quote][q].\n\n[q]: </pest-control-quote/>\n' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('city-service links restrict to published page cities, not the dispatch footprint (Codex round 3)', () => {
    const blocked = guardrails.evaluate({ body: '[Oneco pest control](/pest-control-oneco-fl/)' }, {});
    expect(blocked.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
  });

  test('hub-slug city variants are dead routes (Codex round 6)', () => {
    const r = guardrails.evaluate({ body: '[services](/pest-control-services-bradenton-fl/)' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
  });

  test('underscore component identifiers are caught (Codex round 3)', () => {
    const r = guardrails.evaluate({ body: 'Note: <Pro_Tip title="x" /> here.' }, {});
    expect(r.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(true);
  });

  test('absolute-hub brief links are honored as allowances (Codex round 5)', () => {
    const body = 'Curated: [special](/lawn-care/fall-armyworm-outbreak/).';
    const allowed = guardrails.evaluate({ body }, { allowedInternalLinks: ['https://www.wavespestcontrol.com/lawn-care/fall-armyworm-outbreak/'] });
    expect(allowed.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('unquoted href attributes are policed (Codex round 5)', () => {
    const r = guardrails.evaluate({ body: 'Visit <a href=/pest-library/fleas/>the flea page</a>.' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
  });

  test('modal auxiliaries, St. Pete alias, Tampa Bay service claims (astro r8 parity)', () => {
    const can = guardrails.evaluate({ body: 'We can service Naples on request.' }, {});
    expect(can.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const pete = guardrails.evaluate({ body: 'We treat St. Pete lawns on the same schedule.' }, {});
    expect(pete.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const bayClaim = guardrails.evaluate({ body: 'We treat Tampa Bay properties year-round.' }, {});
    expect(bayClaim.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const bayFact = guardrails.evaluate({ body: 'Runoff drains to Tampa Bay after summer storms.' }, {});
    expect(bayFact.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('attributive "call" is not claim context; CTA call is (Codex round 4)', () => {
    const attributive = guardrails.evaluate({ body: 'Researchers call Fort Myers one of the early tegu hotspots.' }, {});
    expect(attributive.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    const cta = guardrails.evaluate({ body: 'Call us today about your Naples home.' }, {});
    expect(cta.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('Oxford-comma service lists flag their tail city; negated city lists fully exempt (astro r7 parity)', () => {
    const list = guardrails.evaluate({ body: 'We serve Sarasota, Venice, and Naples.' }, {});
    expect(list.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const negated = guardrails.evaluate({ body: "We don't serve Naples, Tampa, or Miami." }, {});
    expect(negated.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('bare hub URLs with trailing punctuation normalize cleanly (Codex round 4)', () => {
    const r = guardrails.evaluate({ body: 'Reach us at https://www.wavespestcontrol.com/contact/, then book online.' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('future-tense claims, Tampa Bay geography, contracted disclaimers, wrapped blockquotes (astro r6 parity)', () => {
    const future = guardrails.evaluate({ body: "In Tampa, we'll treat the infestation at the source." }, {});
    expect(future.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    // r8 note: claim verbs near "Tampa Bay" now FLAG (region is out of
    // footprint) — only claim-free factual mentions pass.
    const bay = guardrails.evaluate({ body: 'Around Tampa Bay, salt pressure runs heavier on ornamentals.' }, {});
    expect(bay.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    const contracted = guardrails.evaluate({ body: "Naples isn't in our service area." }, {});
    expect(contracted.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    const quote = guardrails.evaluate({ body: '> From Sarasota to Naples,\n> we treat the same trouble spots.' }, {});
    expect(quote.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('passive off-footprint claims are caught (Codex round 3)', () => {
    for (const body of [
      'Tampa homes are covered by our technicians every quarter.',
      'Naples homes are serviced by our team.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
  });

  test('drift guard: every content-brief-builder SERVICE_HUB_LINKS target is allowlisted', () => {
    const { SERVICE_HUB_LINKS } = require('../services/content/content-brief-builder')._internals;
    const allowed = new Set(guardrails.ALLOWED_INTERNAL_LINKS);
    for (const links of Object.values(SERVICE_HUB_LINKS)) {
      for (const link of links) {
        expect(allowed.has(link)).toBe(true);
      }
    }
  });
});
