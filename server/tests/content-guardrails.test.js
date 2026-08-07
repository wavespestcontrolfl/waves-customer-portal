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
    // Lookalikes on OPEN TLDs stay blocked — anyone can register these.
    // (The former ".edu lookalike" case moved to the citation-grade-TLD
    // suite below: owner ruling 2026-08-01 admits .gov/.edu wholesale for
    // operator-directed drafts, and neither TLD is openly registrable —
    // .edu needs accreditation, .gov a verified US government entity.)
    expect(guardrails.evaluate({ body: 'See https://evil-ufl.com/x now.' }, { operatorCitations: true })
      .findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(true);
    expect(guardrails.evaluate({ body: 'See https://ufl.edu.example.net/x now.' }, { operatorCitations: true })
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

  test('model-tooling citation artifacts block (Codex round 7)', () => {
    for (const body of [
      'Drywood termites swarm in spring.citeturn0search0',
      'Chinch bugs peak in July.【12†source】',
      'Sod webworms feed at night.:contentReference[oaicite:0]{index=0}',
      'Fleas need humidity above 50%.<cite index=3>',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'CITATION_TOKEN_RESIDUE')).toBe(true);
    }
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

  test('city-service families match the REAL astro pages (ground truth 2026-07-22)', () => {
    // pest-control-services-{city}-fl and every specialty slug exist for all
    // 8 published cities in wavespestcontrol-astro src/content/services —
    // an earlier round wrongly restricted these.
    const fine = guardrails.evaluate({
      body: '[svc](/pest-control-services-bradenton-fl/) [palms](/palm-tree-injections-sarasota-fl/) [aeration](/lawn-aeration-lakewood-ranch-fl/) [bed bugs](/bed-bug-control-venice-fl/)',
    }, {});
    expect(fine.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
    const dead = guardrails.evaluate({ body: '[svc](/pest-control-services-oneco-fl/)' }, {});
    expect(dead.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
  });

  test('underscore component identifiers are caught (Codex round 3)', () => {
    const r = guardrails.evaluate({ body: 'Note: <Pro_Tip title="x" /> here.' }, {});
    expect(r.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(true);
  });

  test('brief-supplied dead city links are not honored as allowances (Codex round 8)', () => {
    const body = 'See our [Oneco page](/pest-control-oneco-fl/).';
    const r = guardrails.evaluate({ body }, { allowedInternalLinks: ['/pest-control-oneco-fl/'] });
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
  });

  test('since-year and founded-year company claims are P0; factual since-year passes (Codex round 8)', () => {
    for (const body of [
      'Serving Sarasota since 2012 with quarterly pest plans.',
      'Waves was founded in 2010 by a local family.',
      'Family-owned and operated since 1998.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'TENURE_CLAIM')).toBe(true);
    }
    const fine = guardrails.evaluate({ body: 'Since 2019, Florida has required annual termite disclosures on resale homes.' }, {});
    expect(fine.findings.some((f) => f.code === 'TENURE_CLAIM')).toBe(false);
  });

  test('tenure/experience claims are P0 (Codex round 7 — founded 2024)', () => {
    for (const body of [
      'Our technicians bring over a decade of Southwest Florida pest control experience.',
      'With 12 years of local pest control experience, we know sandy soil.',
      'Backed by decades of turf expertise.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'TENURE_CLAIM' && f.severity === 'P0')).toBe(true);
    }
    const spelled = guardrails.evaluate({ body: 'Our technicians bring three years of Southwest Florida pest control experience.' }, {});
    expect(spelled.findings.some((f) => f.code === 'TENURE_CLAIM')).toBe(true);
    const fine = guardrails.evaluate({ body: 'Chinch bug pressure has climbed for 10 years across SWFL, and 2 years of drought stress made it worse.' }, {});
    expect(fine.findings.some((f) => f.code === 'TENURE_CLAIM')).toBe(false);
  });

  test('service-keyword city framing flags; bare pest-word mentions pass (Codex round 7)', () => {
    for (const body of [
      'Need mosquito control in Cape Coral? Start with source reduction.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
    // Guide compounds are editorial throughout the gate — Codex round 32
    // (astro) superseded the earlier round-7 expectation that guide titles
    // flag ("Our Naples pest control guide explains local options" passes).
    for (const body of [
      'Your Naples pest control guide for new homeowners.',
      'Our team reviewed Miami termite research before writing this guide.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    }
  });

  test('nearby island/town claims are covered; spoke-host absolute URLs and specialty city routes are policed (Codex round 7)', () => {
    const sanibel = guardrails.evaluate({ body: 'We proudly serve Sanibel homeowners.' }, {});
    expect(sanibel.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const spoke = guardrails.evaluate({ body: '[fleas](https://bradentonflpestcontrol.com/pest-library/fleas/)' }, {});
    expect(spoke.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
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

  test('mixed-case schemes, dot segments, although-clauses (Codex round 10)', () => {
    const upper = guardrails.evaluate({ body: '[x](HTTPS://www.wavespestcontrol.com/pest-library/fleas/)' }, {});
    expect(upper.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    const dotted = guardrails.evaluate({ body: '[x](/images/../pest-library/fleas/)' }, {});
    expect(dotted.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    const although = guardrails.evaluate({ body: 'Naples is outside our service area, although Tampa homes are serviced by our team.' }, {});
    expect(although.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('non-blog snake_case metas are snippet-style by page type (Codex round 10)', () => {
    const { _internals } = require('../services/content/content-quality-gate');
    const check = _internals.checkMetaDescriptionComplete || null;
    if (check) {
      expect(check({ meta_description: 'New Sarasota lawn program with quarterly visits and free re-treatments between visits for members' }, { page_type: 'city-service' }).ok).toBe(true);
      expect(check({ meta_description: 'A cut-off blog meta that rambles toward one hundred fifteen characters and then stops before your' }, { page_type: 'supporting-blog' }).ok).toBe(false);
    }
  });

  test('astro round-10 parity: verbs, counties, availability, link destinations, keyword context', () => {
    const inspect = guardrails.evaluate({ body: 'In Naples, we inspect homes for termites before quoting.' }, {});
    expect(inspect.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const county = guardrails.evaluate({ body: 'We service Collier County homes.' }, {});
    expect(county.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const avail = guardrails.evaluate({ body: 'WaveGuard is available in Tampa.' }, {});
    expect(avail.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const linkDest = guardrails.evaluate({ body: 'We treat Sarasota homes using [UF guidance](https://example.com/miami-termite-treatment).' }, {});
    expect(linkDest.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    const research = guardrails.evaluate({ body: 'University of Florida termite treatment research in Miami shaped statewide guidance.' }, {});
    expect(research.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    const proud = guardrails.evaluate({ body: "We're proud to serve Naples homeowners." }, {});
    expect(proud.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('disclaimers exempt per city, and intro commas never sever claims (astro r11 parity)', () => {
    const splice = guardrails.evaluate({ body: 'Naples is outside our service area, Waves serves Tampa.' }, {});
    expect(splice.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const intro = guardrails.evaluate({ body: 'In Naples, we treat lawns on the same quarterly cadence.' }, {});
    expect(intro.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const plain = guardrails.evaluate({ body: 'Naples is outside our service area.' }, {});
    expect(plain.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
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

  // The drift guard above only proves the two lists AGREE. Both carried the
  // same four 404s for weeks and it stayed green — consistency is not
  // reachability. These routes were fetched against the live hub on
  // 2026-07-29: each returned 404 because only city-scoped versions exist
  // (CITY_SERVICE_LINK_RE covers those). Re-adding one re-opens the worst
  // failure mode this gate has: a dead route on the allowlist doesn't merely
  // pass the dead-link check, it makes the brief MANDATE the dead link and
  // then exempts it from review.
  const VERIFIED_DEAD_ROUTES = ['/lawn-care/', '/mosquito-control/', '/rodent-control/', '/tree-shrub-care/'];

  // The mirror-image bug: a REAL page missing from the allowlist gets P0'd as an
  // invented route, which is what stalled astro #409. Both were found by live
  // fetch on 2026-07-29 (200), not by reading the astro tree.
  const VERIFIED_LIVE_ROUTES = ['/quote/', '/termite-control/'];

  test('verified-live routes are allowlisted and pass the route gate', () => {
    for (const live of VERIFIED_LIVE_ROUTES) {
      expect(guardrails.ALLOWED_INTERNAL_LINKS).toContain(live);
      const r = guardrails.evaluate({ body: `More detail on our [service page](${live}) if you want it.` }, {});
      expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
    }
  });

  test('no verified-dead route is allowlisted or brief-mandated', () => {
    const { SERVICE_HUB_LINKS } = require('../services/content/content-brief-builder')._internals;
    const mandated = new Set(Object.values(SERVICE_HUB_LINKS).flat());
    for (const dead of VERIFIED_DEAD_ROUTES) {
      expect(guardrails.ALLOWED_INTERNAL_LINKS).not.toContain(dead);
      expect(mandated.has(dead)).toBe(false);
    }
  });

  // Seed-overlay links reach internal_links_to_add WITHOUT passing through
  // _internalLinksFor, so the two checks above cannot see them — and a mandated
  // route becomes a per-draft allowance that suppresses UNKNOWN_INTERNAL_ROUTE.
  // The manifest carried /lawn-care/ 24x, /tree-shrub-care/ 9x,
  // /mosquito-control/ 2x and /rodent-control/ 1x until 2026-07-29.
  test('the category-seed manifest mandates no verified-dead bare route', () => {
    const manifest = require('../data/category-seed-topics-v1.json');
    const links = [];
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'internal_links' && Array.isArray(v)) links.push(...v);
          else walk(v);
        }
      }
    }(manifest));
    expect(links.length).toBeGreaterThan(0); // guard against a silent no-op walk
    for (const dead of [...VERIFIED_DEAD_ROUTES, '/pest-control/plants-that-keep-mosquitoes-away/']) {
      expect(links).not.toContain(dead);
    }
  });

  test('a dead bare service route in a draft body is still a P0', () => {
    for (const dead of VERIFIED_DEAD_ROUTES) {
      const r = guardrails.evaluate({ body: `Ask about our [service](${dead}) options today.` }, {});
      expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE' && f.severity === 'P0')).toBe(true);
    }
  });

  // astro #409's actual trigger: Codex told the fixer to point a quote CTA at
  // /quote/ (a real 200 page — src/pages/quote.astro), the allowlist only had
  // /pest-control-quote/, so the correct fix was rejected as an invented route
  // and the remediation loop parked for two days.
  test('/quote/ is allowlisted — the real lead-form flow (astro #409)', () => {
    expect(guardrails.ALLOWED_INTERNAL_LINKS).toContain('/quote/');
    const r = guardrails.evaluate({ body: 'Ready when you are — [get a quote](/quote/) and we will send a price.' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });

  test('every city-scoped replacement for the removed bare routes still passes', () => {
    for (const live of ['/mosquito-control-sarasota-fl/', '/rodent-control-venice-fl/', '/pest-control-bradenton-fl/']) {
      const r = guardrails.evaluate({ body: `See our [local page](${live}) for details.` }, {});
      expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
    }
  });
});

describe('footprint gate — round-12 hardening (Codex findings + astro r12 parity)', () => {
  test('perfect-tense service claims are caught', () => {
    for (const body of [
      "We've treated homes from Sarasota to Naples.",
      'We have serviced Naples homes since the storms.',
      "We've been treating Naples lawns all season.",
      'Waves has served Naples neighborhoods before.',
      'Tampa homes have been covered by our technicians.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
  });

  test('adverb-led serving claims are caught', () => {
    for (const body of [
      'Now serving Tampa homeowners.',
      'Currently serving Naples lawns and landscapes.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
  });

  test('semicolon-separated city lists keep the claim verb across items', () => {
    const r = guardrails.evaluate({ body: 'We serve Sarasota; Venice; and Naples.' }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('a semicolon before a real second clause still splits (disclaimer stays scoped)', () => {
    const r = guardrails.evaluate({ body: 'Naples is outside our service area; we cover Venice instead.' }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('bulleted city lists inherit their claim intro', () => {
    const claim = guardrails.evaluate({ body: 'We serve these cities:\n\n- Bradenton\n- Naples\n- Venice' }, {});
    expect(claim.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const factual = guardrails.evaluate({ body: 'Cities where termites swarm earliest:\n\n- Naples\n- Miami' }, {});
    expect(factual.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('compound service keywords (tree and shrub, lawn & pest) are caught', () => {
    for (const body of [
      'Need tree and shrub care in Naples?',
      'Lawn & pest control services in Cape Coral',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
  });

  test('exclusion-verb and not-a-service-area disclaimers pass', () => {
    for (const body of [
      'Our service area excludes Naples and Fort Myers.',
      'Our service area stops short of Naples.',
      'Naples is not a service area for Waves.',
      'Fort Myers is not one of our service areas.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    }
  });

  test('disclaimer-first city lists pass, but a claim clause after still flags', () => {
    const list = guardrails.evaluate({ body: 'Outside our service area: Naples, Fort Myers, and Cape Coral.' }, {});
    expect(list.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    const smuggled = guardrails.evaluate({ body: 'Outside our service area: Naples, but our techs treat Tampa weekly.' }, {});
    expect(smuggled.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });
});

describe('refresh gates — round-12 hardening (Codex findings)', () => {
  test('grandfathering is by occurrence COUNT — preserving one legacy link does not license adding more', () => {
    const priorBody = 'Live page links to [legacy](/some-2019-era-page/) and embeds <WhyTrustUs />.';
    const preserved = guardrails.evaluate({
      body: 'Keeps [legacy](/some-2019-era-page/) and <WhyTrustUs /> as-is.',
    }, { isRefresh: true, priorBody });
    expect(preserved.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE' || f.code === 'UNCATALOGED_COMPONENT')).toBe(false);
    const addedDupLink = guardrails.evaluate({
      body: 'Keeps [legacy](/some-2019-era-page/) and adds [another](/some-2019-era-page/).',
    }, { isRefresh: true, priorBody });
    expect(addedDupLink.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(true);
    const addedDupComponent = guardrails.evaluate({
      body: 'Keeps <WhyTrustUs /> and adds <WhyTrustUs /> again.',
    }, { isRefresh: true, priorBody });
    expect(addedDupComponent.findings.some((f) => f.code === 'UNCATALOGED_COMPONENT')).toBe(true);
  });

  test('refresh drafts are not parked on hero-alt fields publishRefresh will not write', () => {
    for (const frontmatter of [
      { hero_image_alt: 'Serving Naples homes with quarterly pest control.' },
      { hero_image: { alt: 'Serving Naples homes with quarterly pest control.' } },
    ]) {
      const refresh = guardrails.evaluate({ body: 'Clean refreshed copy.', frontmatter }, { isRefresh: true, priorBody: 'Old live copy.' });
      expect(refresh.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
      const newPage = guardrails.evaluate({ body: 'Clean new copy.', frontmatter }, {});
      expect(newPage.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
  });

  test('refresh meta fields (title/meta) are still scanned in full', () => {
    const r = guardrails.evaluate({
      body: 'Clean refreshed copy.',
      frontmatter: { meta_description: 'Serving Bonita Springs homes with pest control you can trust.' },
    }, { isRefresh: true, priorBody: 'Old live copy.' });
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });
});

describe('footprint/tenure/citation — round-13 hardening (Codex findings)', () => {
  test('a claim CONTINUING after a disclaimer-first city still flags (P1)', () => {
    const r = guardrails.evaluate({ body: 'Outside our service area: Tampa homes are serviced by our team.' }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const pureList = guardrails.evaluate({ body: 'Outside our service area: Naples, Fort Myers, and Cape Coral.' }, {});
    expect(pureList.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('post-founding company-history years block; the truthful 2024 stays allowed', () => {
    for (const body of [
      'Waves was founded in 2025 by a local family.',
      'Family-owned and operated since 2026.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'TENURE_CLAIM')).toBe(true);
    }
    const truthful = guardrails.evaluate({ body: 'Waves is family-owned and operated, founded in 2024 right here in Bradenton.' }, {});
    expect(truthful.findings.some((f) => f.code === 'TENURE_CLAIM')).toBe(false);
  });

  test('OpenAI private-use citation glyphs are citation residue', () => {
    const withGlyphs = guardrails.evaluate({ body: 'Chinch bugs thrive in dry turf.citeturn0search0' }, {});
    expect(withGlyphs.findings.some((f) => f.code === 'CITATION_TOKEN_RESIDUE')).toBe(true);
    const bareGlyph = guardrails.evaluate({ body: 'Dry turf invites chinch bugs.' }, {});
    expect(bareGlyph.findings.some((f) => f.code === 'CITATION_TOKEN_RESIDUE')).toBe(true);
  });
});

describe('footprint gate — astro round-13 parity (long lists, idiom, semicolons, repeats, offer/provide)', () => {
  test('long pre-disclaimer city lists pass', () => {
    const r = guardrails.evaluate({ body: 'Naples, Fort Myers, Cape Coral, Bonita Springs, Estero, and Marco Island are outside our service area.' }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('serving-up idiom passes on brand and standalone arms', () => {
    for (const body of [
      'Waves is serving up a Naples-vs-Sarasota comparison.',
      'Now serving up fresh insights on Naples termite season.',
      'We are serving up a Tampa-vs-Bradenton pressure breakdown.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    }
  });

  test('a factual clause after a semicolon is not glued onto a claim list', () => {
    const factual = guardrails.evaluate({ body: 'We serve Sarasota; Tampa mosquito season starts earlier than ours.' }, {});
    expect(factual.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    const list = guardrails.evaluate({ body: 'We serve Sarasota; Venice; and Naples.' }, {});
    expect(list.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('a repeated city after its disclaimer is examined as its own claim', () => {
    const r = guardrails.evaluate({ body: 'Naples is outside our service area — our techs service Naples homes on request.' }, {});
    expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    const honest = guardrails.evaluate({ body: "We don't serve Naples, Tampa, or Miami." }, {});
    expect(honest.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });

  test('offer/provide claims with a service object flag; editorial objects pass', () => {
    for (const body of [
      'We offer pest control services in Naples.',
      'We provide service in Tampa year-round.',
      'Waves offers termite inspection plans for Cape Coral homes.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
    const editorial = guardrails.evaluate({ body: 'We provide this checklist so Naples homeowners can compare notes.' }, {});
    expect(editorial.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
  });
});

describe('footprint gate — parity pre-push hardening (mid-fragment conjunctions, object binding)', () => {
  test('semicolon fragments with mid-list conjunctions still rejoin and flag', () => {
    for (const body of [
      'We serve Sarasota; Naples and Tampa.',
      'We serve Sarasota; Venice, Naples, and Tampa.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
  });

  test('offer/provide/deliver require a service-shaped object, not mere proximity', () => {
    const editorial = guardrails.evaluate({ body: 'We deliver pest research to help Naples homeowners compare options.' }, {});
    expect(editorial.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    const claim = guardrails.evaluate({ body: 'We deliver reliable pest control in Naples.' }, {});
    expect(claim.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
  });

  test('portal r36 + astro r10: HTML wrappers, punctuated titles, CTA-pivot negation stops, needed pivots, county provide claims, wh-operation claims, gov CTAs, data demand', () => {
    for (const body of [
      '<strong>Naples pest control services</strong> now available',
      '<h2>Naples pest control services</h2>',
      '## Naples pest control services.',
      'We do not serve Sarasota (but call us for Naples pest control).',
      'No need for an inspection: book pest control in Naples today.',
      'Do you serve Naples? No, but we visit if needed.',
      '| Do you serve Naples? | Do you serve Sarasota? |\n| --- | --- |\n| No, but we visit if needed | Yes |',
      '| Do you serve Naples? |\n| --- |\n| No, but we visit as needed |',
      'We provide pest control in Lee County when county-run mosquito control cannot help.',
      'Pest control in Naples is where we operate.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(true);
    }
    for (const body of [
      'Calls from Naples in Google Trends data are common for our team to review.',
      'Call the county for mosquito control in Naples.',
      'Text the city for mosquito control in Naples.',
      'Competitors offer pest control services in Naples.',
      '## Naples pest control research.',
      '| Do you serve Naples? |\n| --- |\n| No |',
      'Lee County runs county-run mosquito control districts.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'OFF_FOOTPRINT_CITY_CLAIM')).toBe(false);
    }
  });
});

describe('protected metaTitle rewrite gate (owner rule 2026-07-16)', () => {
  const LIVE = 'Pest Control Near Me in Sarasota, FL | Pest Control in Sarasota, FL | Exterminator Near Me in Sarasota, FL';
  const base = { body: 'Refreshed Sarasota body content.', frontmatter: {} };

  test('refresh draft with a different metaTitle P0s', () => {
    const r = guardrails.evaluate(
      { ...base, frontmatter: { metaTitle: 'Pest Control in Sarasota, FL | Waves' } },
      { isRefresh: true, priorBody: 'old body', liveMetaTitle: LIVE },
    );
    const f = r.findings.find((x) => x.code === 'PROTECTED_META_TITLE_REWRITE');
    expect(f).toBeTruthy();
    expect(f.severity).toBe('P0');
    expect(r.pass).toBe(false);
  });

  test('identical metaTitle passes', () => {
    const r = guardrails.evaluate(
      { ...base, frontmatter: { metaTitle: LIVE } },
      { isRefresh: true, priorBody: 'old body', liveMetaTitle: LIVE },
    );
    expect(r.findings.some((x) => x.code === 'PROTECTED_META_TITLE_REWRITE')).toBe(false);
  });

  test('absent or blank draft metaTitle passes (publisher keeps the live value)', () => {
    for (const fmv of [{}, { metaTitle: '' }, { metaTitle: '   ' }]) {
      const r = guardrails.evaluate(
        { ...base, frontmatter: fmv },
        { isRefresh: true, priorBody: 'old body', liveMetaTitle: LIVE },
      );
      expect(r.findings.some((x) => x.code === 'PROTECTED_META_TITLE_REWRITE')).toBe(false);
    }
  });

  test('inert without isRefresh or without a live value to compare', () => {
    const rewritten = { ...base, frontmatter: { metaTitle: 'Something else' } };
    for (const opts of [
      { isRefresh: false, liveMetaTitle: LIVE },
      { isRefresh: true, priorBody: 'old body', liveMetaTitle: null },
      { isRefresh: true, priorBody: 'old body', liveMetaTitle: '  ' },
    ]) {
      const r = guardrails.evaluate(rewritten, opts);
      expect(r.findings.some((x) => x.code === 'PROTECTED_META_TITLE_REWRITE')).toBe(false);
    }
  });
});

describe('meta description contract on refresh (owner rule 2026-07-29)', () => {
  const LIVE_META = 'Lawn care nearby in Sarasota, FL — {{brandShort}} targets chinch bugs. Call ☎️ {{cityPhone}} for a FREE lawn care estimate.';
  const base = { body: 'Refreshed body.', frontmatter: {} };
  const opts = (fmv, extra = {}) => ({ isRefresh: true, priorBody: 'old body', liveMetaDescription: LIVE_META, ...extra });

  test('changed meta without the {{cityPhone}} token P1s', () => {
    const r = guardrails.evaluate(
      { ...base, frontmatter: { metaDescription: 'Fresh Sarasota lawn care from local techs. Free estimates in about sixty seconds, chinch bug and sod webworm coverage included today.' } },
      opts(),
    );
    expect(r.findings.some((f) => f.code === 'META_MISSING_PHONE_TOKEN' && f.severity === 'P1')).toBe(true);
  });

  test('typed-out phone number in a changed meta P1s', () => {
    const r = guardrails.evaluate(
      { ...base, frontmatter: { metaDescription: 'Sarasota lawn care with chinch bug coverage — call (941) 297-2606 and {{cityPhone}} for a free estimate from our local team today.' } },
      opts(),
    );
    expect(r.findings.some((f) => f.code === 'LITERAL_PHONE_IN_META')).toBe(true);
  });

  test('changed meta over 160 rendered characters P1s', () => {
    const long = `Sarasota lawn care built for chinch bugs, sod webworms, and the county fertilizer blackout. Call ☎️ {{cityPhone}} for a FREE estimate from techs on local routes daily.`;
    const r = guardrails.evaluate({ ...base, frontmatter: { metaDescription: long } }, opts());
    expect(r.findings.some((f) => f.code === 'META_OVER_160_RENDERED')).toBe(true);
  });

  test('unchanged carried-over meta is grandfathered; absent meta passes', () => {
    for (const fmv of [{ metaDescription: LIVE_META }, {}]) {
      const r = guardrails.evaluate({ ...base, frontmatter: fmv }, opts());
      expect(r.findings.some((f) => String(f.code).startsWith('META_'))).toBe(false);
    }
  });

  test('inert outside refresh', () => {
    const r = guardrails.evaluate(
      { ...base, frontmatter: { metaDescription: 'No phone here at all but this is a NEW page draft, not a refresh — different lane, different contract, no meta finding expected.' } },
      { isRefresh: false },
    );
    expect(r.findings.some((f) => String(f.code).startsWith('META_'))).toBe(false);
  });
});

describe('blog meta contract on refresh (owner rule 2026-07-29 refinement)', () => {
  const base = { body: 'Refreshed blog body.', frontmatter: {} };
  const opts = { isRefresh: true, priorBody: 'old body', liveMetaDescription: 'Old blog meta.', targetIsBlog: true };

  test('blog changed meta with a phone token P1s', () => {
    const r = guardrails.evaluate(
      { ...base, frontmatter: { meta_description: 'What chinch bug damage looks like in SWFL turf and what recovery takes. Call ☎️ {{cityPhone}} to read more on the Waves blog today, neighbors.' } },
      opts,
    );
    expect(r.findings.some((f) => f.code === 'BLOG_META_CARRIES_PHONE')).toBe(true);
  });

  test('blog changed meta with a salesy CTA P1s', () => {
    const r = guardrails.evaluate(
      { ...base, frontmatter: { meta_description: 'What chinch bug damage looks like in SWFL turf and what a recovery takes — book today for your free estimate from our local lawn techs.' } },
      opts,
    );
    expect(r.findings.some((f) => f.code === 'BLOG_META_SALESY')).toBe(true);
  });

  test('informational blog meta with a soft CTA passes', () => {
    const r = guardrails.evaluate(
      { ...base, frontmatter: { meta_description: 'How to tell chinch bug damage from drought stress in a SWFL lawn, and what recovery actually takes. Learn more on the Waves blog.' } },
      opts,
    );
    expect(r.findings.some((f) => String(f.code).startsWith('META_') || String(f.code).startsWith('BLOG_META'))).toBe(false);
  });
});

describe('blog meta soft-CTA on refresh (owner ruling 2026-07-30: nudge, never a blocker)', () => {
  test('blog changed meta without a soft CTA gets a P2 nudge and still PASSES', () => {
    const r = guardrails.evaluate(
      { body: 'Refreshed blog body.', frontmatter: { meta_description: 'How to tell chinch bug damage from drought stress in a Southwest Florida lawn, and what a full turf recovery actually takes this season.' } },
      { isRefresh: true, priorBody: 'old body', liveMetaDescription: 'Old blog meta.', targetIsBlog: true },
    );
    const cta = r.findings.find((f) => f.code === 'BLOG_META_MISSING_SOFT_CTA');
    expect(cta).toBeDefined();
    expect(cta.severity).toBe('P2');
    expect(r.pass).toBe(true);
  });

  test('oversized rendered meta without a CTA gets the blocking P1, not just the P2 nudge (Codex r2 P1)', () => {
    // Literal 159 chars but {{brandName}} renders +5 → over 160; also no CTA.
    const over = '{{brandName}} chinch bug guide. '.padEnd(159, 'y');
    const r = guardrails.evaluate(
      { body: 'Refreshed blog body.', frontmatter: { meta_description: over } },
      { isRefresh: true, priorBody: 'old body', liveMetaDescription: 'Old blog meta.', targetIsBlog: true },
    );
    expect(r.findings.some((f) => f.code === 'META_OVER_160_RENDERED' && f.severity === 'P1')).toBe(true);
    expect(r.pass).toBe(false);
  });

  test('bare 10-digit phone in a changed blog meta still P1s (Codex r4)', () => {
    const r = guardrails.evaluate(
      { body: 'Refreshed blog body.', frontmatter: { meta_description: 'What chinch bug damage looks like in a Southwest Florida lawn this season. Call 9412972606 for treatment details today please.' } },
      { isRefresh: true, priorBody: 'old body', liveMetaDescription: 'Old blog meta.', targetIsBlog: true },
    );
    expect(r.findings.some((f) => f.code === 'BLOG_META_CARRIES_PHONE' && f.severity === 'P1')).toBe(true);
    expect(r.pass).toBe(false);
  });

  test('sales terms in the final sentence still P1 (Codex P1: SALESY_META_RE alone misses the gerund)', () => {
    const r = guardrails.evaluate(
      { body: 'Refreshed blog body.', frontmatter: { meta_description: 'How to tell chinch bug damage from drought stress in a Southwest Florida lawn this season. Learn more about saving big with Waves.' } },
      { isRefresh: true, priorBody: 'old body', liveMetaDescription: 'Old blog meta.', targetIsBlog: true },
    );
    const salesy = r.findings.find((f) => f.code === 'BLOG_META_SALESY');
    expect(salesy).toBeDefined();
    expect(salesy.severity).toBe('P1');
    expect(r.pass).toBe(false);
  });
});

describe('literal phone in draft titles (round-3 hardening)', () => {
  test('any lane: typed-out phone in a draft title P1s', () => {
    const r = guardrails.evaluate(
      { body: 'Body copy.', frontmatter: { title: 'Pest Control Sarasota — 941-297-2606' } },
      {},
    );
    expect(r.findings.some((f) => f.code === 'LITERAL_PHONE_IN_TITLE')).toBe(true);
  });
});

describe('blog meta contract applies to NON-refresh blog publishes (legacy lane)', () => {
  test('a new (non-refresh) blog draft with a salesy meta P1s when targetIsBlog', () => {
    const r = guardrails.evaluate(
      { body: 'Body.', frontmatter: { meta_description: 'Bradenton pest options compared for homeowners weighing plans this season — call now for a free estimate from the local Waves team.' } },
      { targetIsBlog: true },
    );
    expect(r.findings.some((f) => f.code === 'BLOG_META_SALESY')).toBe(true);
  });

  test('non-blog non-refresh drafts remain outside this finding', () => {
    const r = guardrails.evaluate(
      { body: 'Body.', frontmatter: { meta_description: 'No phone here and no CTA either — a plain page description that is long enough to be a realistic meta for a service page today.' } },
      {},
    );
    expect(r.findings.some((f) => String(f.code).startsWith('META_') || String(f.code).startsWith('BLOG_META'))).toBe(false);
  });
});

describe('third-party price citations + citation-grade TLDs (owner ruling 2026-08-01)', () => {
  const { findHardcodedPrice } = guardrails;
  // Operator provenance unlocks the exemption — the same boundary as the
  // .gov/.edu citation allowance (Codex P1: mined drafts keep the full hard
  // block, or an injected attribution publishes arbitrary prices).
  // A competitor-price draft is ALWAYS an operator draft, so the citation
  // allowlist is in scope — the source URL must be one the gate accepts.
  const OP = { thirdPartyCitations: true, operatorCitations: true };
  // The exemption now requires the amount's paragraph to carry BOTH a
  // citation link and an "as of <date>" — the manifest's global sourcing
  // rule. Fixtures that expect an exemption must therefore be sourced.
  const SRC = 'Per ConsumerAffairs (https://www.consumeraffairs.com/x), as of June 2026, ';

  test('mined drafts get NO third-party exemption — the P0 price guard holds (Codex P1)', () => {
    for (const body of [
      'Orkin charges a $199 cancellation fee when you break the agreement early.',
      'Other companies charge $25 per month more for the same coverage.',
      'The industry average is $9,999 per year.',
      'Aptive charges a $199 early-cancel fee per ConsumerAffairs.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
      expect(findHardcodedPrice(body, {})).not.toBeNull();
    }
  });

  // Codex r2 regressions.
  test('sourced price RANGES are one attribution (r2: "from $49 to $99", "between $49 and $99")', () => {
    for (const body of [
      'Aptive charges from $49 to $99 per month for comparable plans.',
      'Aptive charges between $49 and $99 for the same coverage.',
    ]) {
      expect(findHardcodedPrice(SRC + body, OP)).toBeNull();
      expect(findHardcodedPrice(body)).not.toBeNull(); // mined: still blocked
    }
  });

  test('case-sensitive aliasesCS attribute; lowercase phrase does not (r2)', () => {
    expect(findHardcodedPrice(SRC + 'Rodent Solutions charges a $199 fee.', OP)).toBeNull();
    expect(findHardcodedPrice('rodent solutions charges a $199 fee.', OP)).not.toBeNull();
  });

  test('"US" the country is not "us" the pronoun (r2)', () => {
    expect(findHardcodedPrice(SRC + 'In the US, Aptive charges a $199 cancellation fee.', OP)).toBeNull();
    expect(findHardcodedPrice(SRC + 'Aptive charges a $199 cancellation fee in the US.', OP)).toBeNull();
    expect(findHardcodedPrice('The plan costs us $89 per visit here in Bradenton today.', OP)).not.toBeNull();
  });

  test('an unanchored conjunction is a new clause, not a range (pre-push P0)', () => {
    expect(findHardcodedPrice('Orkin charges $199 and $89 is the local quarterly rate.', OP)).not.toBeNull();
  });

  test('TABLES FAIL CLOSED — the exemption is PROSE ONLY (owner ruling 2026-08-01)', () => {
    // A table-cell exemption was built and removed: deciding ownership inside
    // Markdown/JSX tables meant re-implementing a renderer, and every review
    // round found another construct that could launder a first-party price
    // through it. A price in a table now parks exactly as it does on main —
    // and a named-competitor post routes to human review anyway while
    // GATE_NAMED_COMPETITOR_COMPARISON is off, so little is lost.
    for (const body of [
      '| Fee | Aptive |\n|---|---|\n| Early cancel | $199 |',
      '| Aptive | $199 |',
      'Fee | Aptive\n--- | ---\nEarly cancellation | $199',
      '<ComparisonTable columns={["Fee","Aptive"]} rows={[{ label: "Early cancel", values: ["$199"] }]} />',
      '<ComparisonTable rows={[{ values: ["Aptive", "$199"] }]} />',
      '| [Aptive](https://www.consumeraffairs.com/x) | $199 |',
      // A QUALIFYING PREDICATE inside a cell is still a table row — the
      // prose scanner would otherwise read the cell boundaries as spacing.
      '| Aptive charges a | $199 |',
      '| Orkin | charges a $199 cancellation fee |',
      // HTML/JSX tables carry no pipes but are still tables.
      '<table><tr><td>Orkin charges a $199 cancellation fee.</td></tr></table>',
      '<td>Orkin charges a $199 cancellation fee.</td>',
      // A comment full of closing tags is not a set of real closures.
      '<table><tr><td><!-- </td></tr></table> -->Other companies charge $89 per visit</td></tr></table>',
    ]) {
      expect(findHardcodedPrice(body, OP)).not.toBeNull();
    }
  });

  test('a brief-level BAN outranks every exemption (r12)', () => {
    // B2/D1 say "NO TruGreen dollar amounts ANYWHERE in the post", while the
    // seeder tells writers to add "though pricing varies by contract" — which
    // landed on the generic framing exemption and made the ban a no-op.
    const BAN = { thirdPartyCitations: true, forbidAllPrices: true };
    expect(findHardcodedPrice('TruGreen charges $89 per visit, though pricing varies by contract', BAN)).not.toBeNull();
    expect(findHardcodedPrice(`${SRC}Orkin charges a $199 cancellation fee.`, BAN)).not.toBeNull();
    expect(findHardcodedPrice('Use the calculator for a $99 estimate.', BAN)).not.toBeNull();
    // Without a ban the framing exemption is unchanged.
    expect(findHardcodedPrice('Use the calculator for a $99 estimate.', {})).toBeNull();
  });

  test('brief-named sources allow the EXACT URL, not the host (r12 P0)', () => {
    // Allowing the host would let a named citation domain also serve
    // "<script src=…/evil.js>" — the executable-MDX hole again.
    const NAMED = { operatorCitations: true, requiredSourceUrls: ['https://legalclarity.org/how-to-cancel-trugreen/'] };
    expect(guardrails._internals.externalLinkFinding('See https://legalclarity.org/how-to-cancel-trugreen/ for the steps.', NAMED)).toBeNull();
    for (const body of [
      'See https://legalclarity.org/evil.js for the steps.',
      '<script src="https://legalclarity.org/evil.js"></script>',
    ]) {
      expect(guardrails._internals.externalLinkFinding(body, NAMED)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    }
  });

  test('a Markdown citation LINK satisfies the source requirement (r12)', () => {
    // Rendered text blanks link destinations, so the ordinary citation shape
    // must be read from text that keeps them.
    expect(findHardcodedPrice('Per [ConsumerAffairs](https://www.consumeraffairs.com/x), as of June 2026, Orkin charges a $199 fee.', OP)).toBeNull();
  });

  test('executable markup is banned outright in generated posts (r12 P0)', () => {
    // This is what ends the "is this URL in an executable position?"
    // question — there is no executable position to be in.
    const N = { operatorCitations: true, requiredSourceUrls: ['https://legalclarity.org/x'] };
    for (const body of [
      '<script src="https://legalclarity.org/x"></script>',
      '<iframe src="https://legalclarity.org/x"></iframe>',
      '<object data="https://legalclarity.org/x"></object>',
      '<embed src="https://legalclarity.org/x">',
    ]) {
      expect(guardrails._internals.externalLinkFinding(body, N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    }
    // The same URL as a plain citation is fine.
    expect(guardrails._internals.externalLinkFinding('See https://legalclarity.org/x for steps.', N)).toBeNull();
  });

  test('exact-source matching respects URL path and PORT (r12 P0)', () => {
    const P = { operatorCitations: true, requiredSourceUrls: ['https://x.example.com:8443/a'] };
    expect(guardrails._internals.externalLinkFinding('See https://x.example.com:8443/a today.', P)).toBeNull();
    expect(guardrails._internals.externalLinkFinding('See https://x.example.com:9999/a today.', P)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
  });

  test('exact-source matching respects URL path case (r12 P0)', () => {
    const N = { operatorCitations: true, requiredSourceUrls: ['https://legalclarity.org/Report'] };
    expect(guardrails._internals.externalLinkFinding('See https://legalclarity.org/Report today.', N)).toBeNull();
    // A different file on the same host is a different resource — including
    // one that differs only by an extension.
    expect(guardrails._internals.externalLinkFinding('See https://legalclarity.org/report today.', N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    expect(guardrails._internals.externalLinkFinding('See https://legalclarity.org/Report.js today.', N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
  });

  test('the source and date must be RENDERED, not hidden (r12)', () => {
    expect(findHardcodedPrice('{/* as of June 2026 https://x.com/y */} Orkin charges a $199 fee.', OP)).not.toBeNull();
    expect(findHardcodedPrice('<!-- as of June 2026 https://x.com/y --> Orkin charges a $199 fee.', OP)).not.toBeNull();
    expect(findHardcodedPrice('Per (https://x.com/y) {/* as of June 2026 */} Orkin charges a $199 fee.', OP)).not.toBeNull();
  });

  test('the citation must be an ALLOWED source, not just any URL (r12 P0)', () => {
    expect(findHardcodedPrice('Per https://random-blog.example.com/x, as of June 2026, Orkin charges a $199 fee.', OP)).not.toBeNull();
    // A curated host, or a source this brief named, both qualify.
    expect(findHardcodedPrice('Per https://www.consumeraffairs.com/x, as of June 2026, Orkin charges a $199 fee.', OP)).toBeNull();
    expect(findHardcodedPrice('Per https://legalclarity.org/a, as of June 2026, Orkin charges a $199 fee.',
      { ...OP, requiredSourceUrls: ['https://legalclarity.org/a'] })).toBeNull();
  });

  test('generic framing cannot excuse an unsourced intercept price (r13 P0)', () => {
    // "though pricing varies by contract" is exactly the phrasing the seeder
    // tells writers to add, and it walked straight past the source rule.
    expect(findHardcodedPrice('Aptive charges $199, though pricing varies by contract.', OP)).not.toBeNull();
    expect(findHardcodedPrice('Aptive charges $199 — get a quote for your home.', OP)).not.toBeNull();
    // Non-intercept drafts keep the long-standing framing exemption.
    expect(findHardcodedPrice('Use the calculator for a $99 estimate.', {})).toBeNull();
  });

  test('reference definitions are found DOC-WIDE, not just in the paragraph (r13)', () => {
    // Definitions are conventionally collected at the end of the document.
    expect(findHardcodedPrice('Per [CA][1], as of June 2026, Orkin charges a $199 fee.\n\nMore prose.\n\n[1]: https://www.consumeraffairs.com/x', OP)).toBeNull();
  });

  test('raw HTML is a CLOSED allowlist, not a blacklist (r14 P0)', () => {
    // A blacklist kept missing actives — script/iframe, then meta/base/link/
    // style — and each was executable in MDX.
    const OPC = { operatorCitations: true, requiredSourceUrls: [] };
    for (const body of [
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<base href="https://evil.example/">',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<style>body{display:none}</style>',
      '<script>x()</script>',
      '<form action="https://evil.example"></form>',
    ]) {
      expect(guardrails._internals.externalLinkFinding(body, OPC)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    }
    // A passive ELEMENT can still carry an active ATTRIBUTE.
    for (const body of ['<p onclick="fetch(1)">x</p>', '<img src="/images/a.webp" onerror="x()">', '<div onload="x()">y</div>']) {
      expect(guardrails._internals.externalLinkFinding(body, OPC)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    }
    // MDX ESM is module code that no tag or expression scan sees.
    for (const body of [
      'import x from "https://evil.example/p.js";\n\nprose',
      'export const x = 1;\n\nprose',
      'import{x}from"https://evil.example/p.js"\n\nprose',
      '   import * as x from "y"\n\nprose',
      '> import x from "y"\n\nprose',
      '{/* x */}import y from "z"\n\nprose',
    ]) {
      expect(guardrails._internals.externalLinkFinding(body, OPC)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    }
    // Prose words that merely start with the keyword are unaffected.
    for (const body of ['It is important to note the fee.', 'The company exports data.']) {
      expect(guardrails._internals.externalLinkFinding(body, OPC)).toBeNull();
    }
    // Passive formatting and MDX components are unaffected.
    for (const body of ['<p>Orkin charges a fee.</p>', '<table><tr><td>x</td></tr></table>', '<ComparisonTable columns={["a"]} />']) {
      expect(guardrails._internals.externalLinkFinding(body, OPC)).toBeNull();
    }
  });

  test('the citation must be in the amount\'s OWN SENTENCE (r14 P0)', () => {
    // An unrelated citation elsewhere in the paragraph is not evidence for
    // this price; the briefs' mandated shape puts the source in-sentence.
    expect(findHardcodedPrice('Per [UF](https://ufl.edu/chinch), chinch bugs peak in July. Orkin charges a $199 fee as of June 2026.', OP)).not.toBeNull();
    expect(findHardcodedPrice('Aptive charges a $199 cancellation fee as of July 2026 ([source](https://www.consumeraffairs.com/x)).', OP)).toBeNull();
  });

  test('a URL inside an MDX expression is never a citation (r14 P0)', () => {
    // Expressions execute at render and are not tags, so the raw-HTML
    // allowlist never saw them — a brief-named URL could ride into code.
    const N = { operatorCitations: true, requiredSourceUrls: ['https://legalclarity.org/a'] };
    expect(guardrails._internals.externalLinkFinding('{fetch("https://legalclarity.org/a")}', N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    expect(guardrails._internals.externalLinkFinding('{x = "https://evil.example/p.js"}', N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    // A component PROP expression is just as live as a top-level one.
    expect(guardrails._internals.externalLinkFinding('<Comp onClick={fetch("https://legalclarity.org/a")} />', N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    expect(guardrails._internals.externalLinkFinding('<Comp src={"https://legalclarity.org/a"} />', N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    // An executable expression needs no literal URL to reach the network.
    expect(guardrails._internals.externalLinkFinding('{fetch(atob("aHR0cHM6"))}', N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    expect(guardrails._internals.externalLinkFinding('{() => 1}', N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    // Decided by TOKENIZING, so other executable shapes are caught too.
    for (const body of ['<Comp x={globalThis.foo} />', '<Comp x={a.b} />', '<Comp x={someVar} />', '{tag`x`}', '<a href={`/x/${y}`}>x</a>']) {
      expect(guardrails._internals.externalLinkFinding(body, N)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    }
    // Literal props of every shape still work, including a plain template path.
    for (const body of ['<ComparisonTable highlight={1} />', '<Comp a={true} b={null} />', '<a href={`/services/pest-control`}>x</a>']) {
      expect(guardrails._internals.externalLinkFinding(body, N)).toBeNull();
    }
    // Component props and comments are unaffected.
    expect(guardrails._internals.externalLinkFinding('<ComparisonTable columns={["Fee","Aptive"]} />', N)).toBeNull();
    expect(guardrails._internals.externalLinkFinding('{/* a note */} Orkin charges a fee.', N)).toBeNull();
  });

  test('the date must be GOVERNED by "as of" (r14)', () => {
    expect(findHardcodedPrice('Per [CA](https://www.consumeraffairs.com/x), Orkin charges a $199 fee. June 2026 was rainy.', OP)).not.toBeNull();
    expect(findHardcodedPrice('Per [CA](https://www.consumeraffairs.com/x), as of June 2026, Orkin charges a $199 fee.', OP)).toBeNull();
  });

  test('a code span or escaped bracket is not a citation (r15)', () => {
    // Both render literal text — nothing a reader can click.
    expect(findHardcodedPrice('Other companies charge a $199 fee as of July 2026 `[source](https://www.consumeraffairs.com/x)`.', OP)).not.toBeNull();
    expect(findHardcodedPrice('Other companies charge a $199 fee as of July 2026 \\[source](https://www.consumeraffairs.com/x).', OP)).not.toBeNull();
  });

  test('HTML deletion elements are not attribution either (r15)', () => {
    // Same as "~~": the reader sees the owner struck out and the price live.
    expect(findHardcodedPrice('<del>Other companies charge</del> $89 per visit for local quarterly service.', OP)).not.toBeNull();
    expect(findHardcodedPrice('<s>Other companies charge</s> $89 per visit for local quarterly service.', OP)).not.toBeNull();
  });

  test('shortcut and collapsed reference citations qualify (r14)', () => {
    // The label lives in the FIRST bracket for these two forms.
    expect(findHardcodedPrice('Aptive charges a $199 cancellation fee as of July 2026 [source].\n\n[source]: https://www.consumeraffairs.com/x', OP)).toBeNull();
    expect(findHardcodedPrice('Aptive charges a $199 fee as of July 2026 [source][].\n\n[source]: https://www.consumeraffairs.com/x', OP)).toBeNull();
  });

  test('OUR OWN links cannot source a competitor price (r14)', () => {
    // Hub and spoke domains are navigation, not third-party evidence.
    expect(findHardcodedPrice('Other companies charge a $199 cancellation fee as of July 2026 ([source](https://www.wavespestcontrol.com/pest-control-calculator/)).', OP)).not.toBeNull();
    // A genuine third-party source still qualifies.
    expect(findHardcodedPrice('Per [CA](https://www.consumeraffairs.com/x), as of June 2026, Orkin charges a $199 fee.', OP)).toBeNull();
  });

  test('the citation must be reader-VISIBLE, not an image or dangling ref (r13 P0)', () => {
    // Image destinations and unused reference definitions are stripped from
    // the rendered page, so neither is a citation a reader can follow.
    expect(findHardcodedPrice('As of June 2026, Orkin charges a $199 fee.\n[unused]: https://www.consumeraffairs.com/x', OP)).not.toBeNull();
    expect(findHardcodedPrice('![img](https://www.consumeraffairs.com/x) As of June 2026, Orkin charges a $199 fee.', OP)).not.toBeNull();
    // A USED reference link resolves and does qualify.
    expect(findHardcodedPrice('Per [CA][1], as of June 2026, Orkin charges a $199 fee.\n[1]: https://www.consumeraffairs.com/x', OP)).toBeNull();
  });

  test('a cited price must actually BE cited — source AND date (r12)', () => {
    // Grammar alone let an invented figure through: the manifest requires
    // every dollar figure sourced and dated in-post.
    expect(findHardcodedPrice('Other companies charge a $199 cancellation fee.', OP)).not.toBeNull();
    expect(findHardcodedPrice('Per ConsumerAffairs (https://www.consumeraffairs.com/x), Orkin charges a $199 fee.', OP)).not.toBeNull();
    expect(findHardcodedPrice('As of June 2026, Orkin charges a $199 cancellation fee.', OP)).not.toBeNull();
    // Both present → exempt.
    expect(findHardcodedPrice(`${SRC}Orkin charges a $199 cancellation fee.`, OP)).toBeNull();
  });

  test('PROSE attribution still works — this is what the exemption is for', () => {
    expect(findHardcodedPrice(SRC + 'Orkin charges a $199 cancellation fee.', OP)).toBeNull();
    expect(findHardcodedPrice(SRC + 'Aptive charges from $49 to $99 per month for comparable plans.', OP)).toBeNull();
    expect(findHardcodedPrice(SRC + "Orkin's cancellation fee is $199.", OP)).toBeNull();
    // Prose AFTER a table has closed is still prose.
    expect(findHardcodedPrice('<table><tr><td>x</td></tr></table>\n\n' + SRC + 'Orkin charges a $199 cancellation fee.', OP)).toBeNull();
    // …and every first-party guard on the prose path is untouched.
    expect(findHardcodedPrice('Our quarterly service is $89 per application.', OP)).not.toBeNull();
    expect(findHardcodedPrice('O**ur** service differs; Orkin charges $89 per visit.', OP)).not.toBeNull();
    expect(findHardcodedPrice('<span hidden>Orkin charges a</span> $89 per visit', OP)).not.toBeNull();
    expect(findHardcodedPrice('[Local plan](https://example.com/Orkin) charges $89 per application.', OP)).not.toBeNull();
    // Reference/shortcut links render as their label, so a marker split by
    // one is still a marker.
    expect(findHardcodedPrice('O[ur][brand] service differs; Orkin charges $89 per application.\n\n[brand]: /about/', OP)).not.toBeNull();
    expect(findHardcodedPrice('O[ur] service differs; Orkin charges $89 per application.', OP)).not.toBeNull();
    // Hidden descendants and MDX expressions render nothing, so they cannot
    // split the marker either.
    expect(findHardcodedPrice('Orkin charges $89—the amount is O<span hidden>x</span>ur local quarterly rate per visit.', OP)).not.toBeNull();
    expect(findHardcodedPrice('Orkin charges $89—the amount is O{null}ur local quarterly rate per visit.', OP)).not.toBeNull();
    // …but STYLED first-party copy must NOT be erased from the veto. The
    // "any styling is unprovable" rule is right for attribution (excluding
    // costs an exemption) and backwards here (erasing would GRANT one).
    expect(findHardcodedPrice('<span class="lead">Our</span> service differs; Orkin charges $89 per visit.', OP)).not.toBeNull();
    expect(findHardcodedPrice('O<span style="color:red">u</span>r service differs; Orkin charges $89 per visit.', OP)).not.toBeNull();
    // An expression that RENDERS keeps its value; only provably-empty ones
    // are dropped, and anything unreadable keeps its inner text.
    expect(findHardcodedPrice('O{"ur"} service differs; Orkin charges $89 per visit.', OP)).not.toBeNull();
    expect(findHardcodedPrice('O{x || "ur"} service differs; Orkin charges $89 per visit.', OP)).not.toBeNull();
    // Mined drafts get no exemption at all.
    expect(findHardcodedPrice('Orkin charges a $199 cancellation fee.', {})).not.toBeNull();
  });

  test('pseudo values: prose is not a table cell (pre-push P0)', () => {
    expect(findHardcodedPrice('These values: [Aptive] show that local quarterly service is $89 per application.', OP)).not.toBeNull();
  });

  test('singular first-person markers disqualify even beside a competitor (pre-push P0)', () => {
    for (const body of [
      '| Aptive | I charge | $89 |',
      '| Aptive | my quarterly service | $89 |',
      'Unlike Aptive, I charge $89 for quarterly service in Bradenton.',
      'Aptive is pricier than my $99 quarterly plan for local homes.',
    ]) {
      expect(findHardcodedPrice(body, OP)).not.toBeNull();
    }
  });






  test('a range endpoint followed by a new predicate is not a range (pre-push P0, r6)', () => {
    // "from … and" is not range grammar, and "$89 is …" is a second claim.
    expect(findHardcodedPrice('Aptive charges from $49 and $89 is the local quarterly rate.', OP)).not.toBeNull();
    expect(findHardcodedPrice('Aptive charges between $49 and $89 is the local quarterly rate.', OP)).not.toBeNull();
    // The canonical pairings still read as ONE attributed range.
    expect(findHardcodedPrice(SRC + 'Aptive charges from $49 to $99 per month for comparable plans.', OP)).toBeNull();
    expect(findHardcodedPrice(SRC + 'Aptive charges between $49 and $99 for the same coverage.', OP)).toBeNull();
  });





  test('tag attributes are not reader-visible attribution (r7)', () => {
    expect(findHardcodedPrice('<span class="other companies charge"> $89 per visit for local quarterly service</span>', OP)).not.toBeNull();
    expect(findHardcodedPrice('<div data-note="Orkin charges"> $89 per visit locally.</div>', OP)).not.toBeNull();
    // Visible prose inside a tag still attributes normally.
    // The citation must sit in the SAME sentence, and a block tag is a
    // sentence boundary — so it goes inside the <p>, not before it.
    expect(findHardcodedPrice(`<p>${SRC}Orkin charges a $199 cancellation fee.</p>`, OP)).toBeNull();
  });

  test('a > inside an attribute does not end the tag (pre-push P0, r7)', () => {
    expect(findHardcodedPrice('<span title="x > Orkin charges a"> $89 per visit for local quarterly service</span>', OP)).not.toBeNull();
    // Markdown cells are prose — an invisible attribute cannot attribute them.
    expect(findHardcodedPrice('| <span title="Aptive">Local service</span> | $89 |', OP)).not.toBeNull();
  });


  // PRE-EXISTING on main, documented here because it was found while fixing
  // the attribute case and it is STRICTLY WIDER than this PR: a price glued
  // to a tag ("<span>$89") is never DETECTED, on any lane, because
  // PRICE_RE_SRC requires whitespace/quote/paren before the "$". Widening the
  // detector is a separate change with a real false-positive blast radius —
  // this test pins the current behaviour so the gap cannot be mistaken for
  // something this PR introduced or fixed.
  test('KNOWN GAP (pre-existing, not this PR): a price glued to a tag is not detected', () => {
    expect(findHardcodedPrice('<span>$89 per visit</span>', {})).toBeNull();
    expect(findHardcodedPrice('<span> $89 per visit</span>', {})).toBe('$89');
  });


  test('attribution cannot cross a rendered block boundary (r8)', () => {
    // The reader sees a bare price in its own paragraph.
    expect(findHardcodedPrice('<p>Other companies charge</p><p> $89 per visit for local quarterly service.</p>', OP)).not.toBeNull();
    expect(findHardcodedPrice('<td>Other companies charge</td><td> $89 per visit locally.</td>', OP)).not.toBeNull();
    // An INLINE tag is not a boundary — real attribution still works.
    expect(findHardcodedPrice(SRC + '<p>Orkin charges a <strong>$199</strong> cancellation fee.</p>', OP)).toBeNull();
  });


  test('entity-encoded first-party markers veto in PROSE too (r9 P0)', () => {
    expect(findHardcodedPrice('O&#117;r service is different; Orkin charges $89 per visit.', OP)).not.toBeNull();
    expect(findHardcodedPrice('&#87;aves charges less than Orkin&rsquo;s $199 fee.', OP)).not.toBeNull();
    // A genuine competitor attribution with no first-party marker still passes.
    expect(findHardcodedPrice(SRC + 'Orkin charges a $199 cancellation fee.', OP)).toBeNull();
  });





  test('non-rendered attribution never exempts (r9 P0)', () => {
    for (const body of [
      '<span hidden>Orkin charges a</span> $89 per visit',
      '<span aria-hidden="true">Orkin charges a</span> $89 per visit',
      '<template>Orkin charges a</template> $89 per visit',
      // Natively hidden containers need no hidden/style/class attribute.
      '<dialog>Other companies charge</dialog> $89 per visit for local quarterly service.',
      '<datalist>Other companies charge</datalist> $89 per visit for local quarterly service.',
      // <details> is collapsed unless `open`.
      '<details>Other companies charge</details> $89 per visit for local quarterly service.',
      // Deleted text is not an affirmative attribution.
      '~~Other companies charge~~ $89 per visit for local quarterly service.',
      '{show && "Orkin charges a"} $89 per visit',
      '<span hidden><span>x</span>Orkin charges a</span> $89 per visit',
      '<span style="display:none">Orkin charges a</span> $89 per visit',
      '<span style="visibility:hidden">Orkin charges a</span> $89 per visit',
      '<span hidden>Orkin charges a $89 per visit',
      '<span title={"x" > "Orkin charges a"}> $89 per visit</span>',
      '<span style={{ display: "none" }}>Orkin charges a</span> $89 per visit',
      '<span style={{ visibility: "hidden" }}>Orkin charges a</span> $89 per visit',
      '<span aria-hidden={1 === 1}>Orkin charges a</span> $89 per visit',
      '<span style={{display: "no" + "ne"}}>Orkin charges a</span> $89 per visit',
      '<span style="opacity:0">Orkin charges a</span> $89 per visit',
      '<span style="font-size:0">Orkin charges a</span> $89 per visit',
      '<span class="hidden">Orkin charges a</span> $89 per visit',
      '<span className="sr-only">Orkin charges a</span> $89 per visit',
    ]) {
      expect(findHardcodedPrice(body, OP)).not.toBeNull();
    }
    // Visible attribution is untouched, including an explicit aria-hidden=false.
    expect(findHardcodedPrice(SRC + '<span>Orkin charges a</span> $199 cancellation fee.', OP)).toBeNull();
    // Explicitly-visible markup no longer earns the exemption either: the
    // contract is PLAIN PROSE, and any attribute makes visibility a
    // judgement call. Parking is the safe answer.
    expect(findHardcodedPrice('<span aria-hidden="false">Orkin charges a</span> $199 cancellation fee.', OP)).not.toBeNull();
    expect(findHardcodedPrice('<dialog open>Orkin charges a</dialog> $199 cancellation fee.', OP)).not.toBeNull();
  });

  test('a link DESTINATION never supplies attribution (r9 P0)', () => {
    // Readers see "Local plan charges $89" — the competitor name is in a URL.
    expect(findHardcodedPrice('[Local plan](https://example.com/Orkin) charges $89 per application.', OP)).not.toBeNull();
    // Balanced parens and nested brackets are valid Markdown — a partial
    // match would leave the tail of the URL behind as attributable text.
    expect(findHardcodedPrice('[Local plan](https://www.consumeraffairs.com/foo(x)/Orkin) charges $89 per application.', OP)).not.toBeNull();
    expect(findHardcodedPrice('[Local [x] plan](https://example.com/Orkin) charges $89 per application.', OP)).not.toBeNull();
    // Malformed links blank whole, so no fragment can attribute.
    expect(findHardcodedPrice('[Local plan](https://example.com/Orkin charges $89 per application.', OP)).not.toBeNull();
    // REFERENCE links render only their label — the definition is invisible.
    expect(findHardcodedPrice('[Local plan][1] charges $89 per application.\n\n[1]: https://example.com/Orkin', OP)).not.toBeNull();
    // A visible anchor still attributes normally.
    expect(findHardcodedPrice(SRC + '[Orkin](https://orkin.com) charges a $199 cancellation fee.', OP)).toBeNull();
  });


  test('inline emphasis or HTML cannot hide a first-party marker (r10)', () => {
    expect(findHardcodedPrice('| O**ur** quarterly service | $89 per visit |', OP)).not.toBeNull();
    expect(findHardcodedPrice('| _Our_ quarterly service | $89 per visit |', OP)).not.toBeNull();
    // Inline tags and comments render away with no word boundary.
    expect(findHardcodedPrice('| Fee | Aptive |\n|---|---|\n| O<span>u</span>r quarterly service | $89 per application |', OP)).not.toBeNull();
    expect(findHardcodedPrice('| O<!--x-->ur quarterly service | $89 per visit |', OP)).not.toBeNull();
    expect(findHardcodedPrice('| O{/*x*/}ur quarterly service | $89 per visit |', OP)).not.toBeNull();
  });

  test('an abbreviation cannot split away the first-party veto (r10)', () => {
    expect(findHardcodedPrice('Our U.S. service differs; Orkin charges $89', OP)).not.toBeNull();
    expect(findHardcodedPrice('Our team (e.g. techs) differs. Orkin charges $89 per visit.', OP)).not.toBeNull();
    // A separate PARAGRAPH is still its own scope.
    expect(findHardcodedPrice('Our service differs.\n\n' + SRC + 'Orkin charges a $199 cancellation fee.', OP)).toBeNull();
  });



  test('inline markup cannot hide the first-party marker in PROSE (r10)', () => {
    for (const body of [
      'O**ur** service differs; Orkin charges $89 per visit.',
      'O<span>u</span>r service differs; Orkin charges $89 per visit.',
      'O_u_r service differs; Orkin charges $89 per visit.',
      'O<!--x-->ur service differs; Orkin charges $89 per visit.',
      'O{/*x*/}ur service differs; Orkin charges $89 per visit.',
    ]) {
      expect(findHardcodedPrice(body, OP)).not.toBeNull();
    }
  });




  test('noscript content is not visible attribution (r9 P0)', () => {
    expect(findHardcodedPrice('<noscript>Other companies charge</noscript> $89 per application', OP)).not.toBeNull();
  });





  test('MDX/HTML comments cannot attribute a price (r6)', () => {
    // The reader sees only "$89 per visit" — the attribution never renders.
    expect(findHardcodedPrice('{/* other companies charge */} $89 per visit for local quarterly service.', OP)).not.toBeNull();
    expect(findHardcodedPrice('<!-- Orkin charges --> $89 per visit for local quarterly service.', OP)).not.toBeNull();
    // A comment ANYWHERE in the paragraph disqualifies it — same rule.
    expect(findHardcodedPrice('{/* sourced 2026 */}\nOrkin charges a $199 cancellation fee.', OP)).not.toBeNull();
    // …but a comment in a DIFFERENT paragraph leaves prose exempt.
    expect(findHardcodedPrice('{/* sourced 2026 */}\n\n' + SRC + 'Orkin charges a $199 cancellation fee.', OP)).toBeNull();
  });

  test('a newline consumed by the price match is still a boundary (r4)', () => {
    expect(findHardcodedPrice('## Other companies charge\n$89 per visit for local quarterly service', OP)).not.toBeNull();
  });

  test('quote-trailing sentence boundaries still split (pre-push P0)', () => {
    expect(findHardcodedPrice('Orkin charges $199.” $89 per application locally.', OP)).not.toBeNull();
  });


  test('citation provenance does NOT unlock prices — only competitorPriceCitations does (pre-push P0: seed lanes)', () => {
    const body = `${SRC}Orkin charges a $199 cancellation fee when you break the agreement early.`;
    // operatorCitations alone (category/spoke seeds) keeps the price P0.
    const seedish = guardrails.evaluate({ body }, { operatorCitations: true });
    expect(seedish.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(true);
    // True intercepts pass via the dedicated flag.
    const intercept = guardrails.evaluate({ body }, { operatorCitations: true, competitorPriceCitations: true });
    expect(intercept.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(false);
  });




  test('detection-only brands attribute prices for operator drafts (Codex P1: Aptive/Hawx)', () => {
    for (const body of [
      'Aptive charges a $199 early-cancel fee per ConsumerAffairs.',
      'Hawx charges a $149 early-termination fee in most markets.',
    ]) {
      expect(findHardcodedPrice(SRC + body, OP)).toBeNull();
    }
  });

  test('a competitor-attributed price is reporting, not a Waves price claim', () => {
    for (const body of [
      'Orkin charges a $199 cancellation fee when you break the agreement early.',
      // Canonical attribution shape — "Terminix customers report a $150…"
      // puts a second subject before the verb and is deliberately NOT
      // exempt (see the rigid-template note in content-guardrails).
      'Terminix charges a $150 early-termination fee on annual plans.',
      'Other companies typically charge $25 per month more for the same coverage.',
      'Your previous provider may bill a $99 fee for ending service early.',
    ]) {
      expect(findHardcodedPrice(SRC + body, OP)).toBeNull();
    }
  });

  test('first-person price framing is still HARD-blocked, even beside a competitor name', () => {
    for (const body of [
      'Unlike Orkin, we charge $89 for the same quarterly service in Bradenton.',
      'Orkin is expensive, but our price is $129 per treatment for local homes.',
      'Waves charges $99 for the first visit and Terminix charges more.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  test('a bare price with no attribution stays blocked (unchanged policy)', () => {
    expect(findHardcodedPrice('Quarterly pest control runs $129 for most homes.')).not.toBeNull();
  });

  // Pre-push Codex P0: a 200-char WINDOW let a competitor named in a
  // NEIGHBOURING sentence launder a Waves price. Exemption is sentence-scoped
  // and requires the third party to precede the amount.
  test('a competitor in a neighbouring sentence never launders our price', () => {
    for (const body of [
      'Orkin is expensive. Quarterly pest control is $129 per application.',
      'Terminix locks you into a year. The standard rate is $89 per visit here.',
      'Homeowners compare Massey Services often. A single treatment costs $150.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  test('first-party framing wins even in the same sentence as a competitor', () => {
    for (const body of [
      'Our quarterly service is $89, unlike Orkin.',
      'We bill $129 per visit while Terminix bills more.',
      'Waves offers $99 first treatments compared with Orkin.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  // Pre-push Codex P0 round 2.
  test('brand template tokens count as first-party (spoke-shared copy)', () => {
    for (const body of [
      'Unlike Orkin, {{brandName}} charges $89 per application.',
      'Orkin is pricier than {{ brandName }}, which bills $99 per visit.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  test('a competitor in a DIFFERENT clause does not own the amount', () => {
    for (const body of [
      'Orkin charges too much, but quarterly pest control is $129 per application.',
      'Terminix locks you in; the standard rate is $89 per visit.',
      'Massey Services advertises heavily while the going rate is $150 a visit.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  test('attribution must PRECEDE the amount (subject position)', () => {
    expect(findHardcodedPrice('The fee is $199 according to nothing in particular.')).not.toBeNull();
    expect(findHardcodedPrice(SRC + 'Orkin lists a $199 fee.', OP)).toBeNull();
  });

  // Pre-push Codex P0 round 3: naming a party is not owning the price.
  test('a named competitor without a pricing construction does NOT exempt', () => {
    for (const body of [
      'Avoid Orkin by choosing quarterly pest control for $129.',
      'Orkin is expensive and quarterly pest control is $129 per application.',
      'Homeowners leaving Terminix still pay $89 for the same coverage.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  test('vague market nouns are not third-party owners', () => {
    for (const body of [
      'The industry-leading quarterly plan costs $129 for most homes.',
      'A typical charge is $129 for quarterly service.',
      // "current service" could be OURS — only provider/company/contractor
      // /exterminator qualify as external owners (pre-push Codex P0).
      'Current service charges $99 per application.',
      'Existing service costs $129 for quarterly coverage.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  // Pre-push Codex P0 round 4: a coordinating conjunction starts a new
  // subject — the competitor's predicate must not reach across it.
  test('a new subject after and/or/plus is not covered by the competitor predicate', () => {
    for (const body of [
      'Orkin charges too much and quarterly pest control costs $129 per application.',
      'Orkin charges $199 and quarterly pest control costs $129 per application.',
      'Terminix bills annually or the standard plan costs $89 per visit.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  test('coordination still allows a genuinely attributed amount', () => {
    expect(findHardcodedPrice(SRC + 'Orkin and Terminix both charge $199 to cancel early.', OP)).toBeNull();
  });

  // Pre-push Codex P0 round 5: an intervening predicate must not be crossed.
  test('an intervening subordinate clause breaks attribution', () => {
    for (const body of [
      'Orkin charges too much because the standard rate is $129.',
      'Terminix bills annually since the going rate is $89 per visit.',
      'Orkin charges more when the quarterly plan costs $129 per application.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  // Pre-push Codex P0 round 7: a second predicate after the attribution verb,
  // and arbitrary text inside the possessive, both laundered a Waves price.
  test('a second predicate after the attribution verb breaks attribution', () => {
    for (const body of [
      'Orkin reports the quarterly plan costs $129 per application.',
      "Orkin's website notes the local plan price is $129 per application.",
      'Terminix lists what the standard plan costs $89 for.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  // Pre-push Codex P0 round 8: an unpunctuated Markdown heading merged with
  // the block below it, so the heading's competitor "owned" the next price.
  test('markdown block boundaries break attribution', () => {
    for (const body of [
      '## Orkin\nQuarterly plan costs $129 per application.',
      'Orkin\n\nThe standard rate is $89 per visit.',
    ]) {
      expect(findHardcodedPrice(body)).not.toBeNull();
    }
  });

  test('possessive price constructions are attributed', () => {
    expect(findHardcodedPrice(SRC + "Orkin's cancellation fee is $199 in most contracts.", OP)).toBeNull();
    expect(findHardcodedPrice(SRC + 'The industry average is $145 per quarterly visit.', OP)).toBeNull();
  });

  test('operator citations are the BRIEF\'S NAMED SOURCES, not a TLD class', () => {
    // The broad .gov/.edu allowance is gone (owner ruling 2026-08-01): a
    // host-wide rule had to be defended at every position a URL can appear,
    // and each one was a bypass into executable .mdx. A named source is
    // allowed WHEREVER it appears; an unnamed host never is.
    const named = { operatorCitations: true, requiredSourceUrls: ['https://research.example.edu/paper'] };
    const none = { operatorCitations: true, requiredSourceUrls: [] };
    expect(guardrails._internals.externalLinkFinding('Per https://research.example.edu/paper, chinch bugs peak.', named)).toBeNull();
    expect(guardrails._internals.externalLinkFinding('![x](https://research.example.edu/p.svg)', { operatorCitations: true, requiredSourceUrls: ['https://research.example.edu/p.svg'] })).toBeNull();
    // Unnamed hosts block regardless of TLD or position.
    expect(guardrails._internals.externalLinkFinding('Per https://research.example.edu/paper, chinch bugs peak.', none)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    expect(guardrails._internals.externalLinkFinding('<script src="https://student.example.edu/p.js"></script>', none)?.code).toBe('DISALLOWED_EXTERNAL_LINK');
    // The CURATED host list still stands on its own.
    expect(guardrails._internals.externalLinkFinding('See https://www.epa.gov/pesticides for details.', none)).toBeNull();
    // Mined drafts get nothing.
    expect(guardrails._internals.externalLinkFinding('Per https://research.example.edu/paper.', {})?.code).toBe('DISALLOWED_EXTERNAL_LINK');
  });

  test('citation-grade TLDs do NOT leak to mined drafts (injection boundary holds)', () => {
    const r = guardrails.evaluate(
      { body: 'See [the statute](https://www.flsenate.gov/Laws/Statutes/2024/501.017).' },
      {},
    );
    expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK' && f.severity === 'P0')).toBe(true);
  });


  test('only the exact .gov/.edu suffix qualifies — lookalikes still block', () => {
    for (const body of [
      'See [this page](https://gov.example.com/statutes) for the rule.',
      'See [this page](https://flsenate.gov.example.net/statutes) for the rule.',
      'See [this page](https://ufl.edu.co/creatures) for the guide.',
    ]) {
      const r = guardrails.evaluate({ body }, { operatorCitations: true });
      expect(r.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(true);
    }
  });
});

// ── W2: compliance language + banned service topics ────────────────────────

describe('re-entry/safety compliance guard (P0 REENTRY_SAFETY_CLAIM)', () => {
  test('"safe to re-enter" blocks at P0', () => {
    const r = guardrails.evaluate({ body: 'The lawn is safe to re-enter about an hour after treatment.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM' && f.severity === 'P0')).toBe(true);
  });

  test('"safe for kids and pets" blocks', () => {
    const r = guardrails.evaluate({ body: 'Our granular application is safe for kids and pets once watered in.' }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('pet-safe / child-safe compounds block', () => {
    const r = guardrails.evaluate({ body: 'We only use pet-safe products in the backyard.' }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('"EPA-approved" blocks; "EPA-registered"/"EPA-exempt" is the REQUIRED wording and stays legal (AGENTS.md)', () => {
    const approved = guardrails.evaluate({ body: 'Every product we apply is EPA-approved for residential use.' }, {});
    expect(approved.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const registered = guardrails.evaluate({ body: 'Every product we apply is EPA-registered, and our mosquito repellent options are EPA-exempt.' }, {});
    expect(registered.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('EPA approval claims block in every word order — passive, active, noun (Codex PR r1)', () => {
    for (const body of [
      'These products are approved by the EPA.',
      'The EPA has approved this pesticide for lawns.',
      'This pesticide carries EPA approval.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    }
  });

  test('"between X and Y" duration ranges block (Codex PR r1)', () => {
    const wait = guardrails.evaluate({ body: 'Wait between 30 and 60 minutes before re-entering the treated room.' }, {});
    expect(wait.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const keepOut = guardrails.evaluate({ body: 'Keep pets out of the yard for between 30 and 60 minutes.' }, {});
    expect(keepOut.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('ANY spelled duration is a figure — "six hours", "twelve minutes" (Codex PR r2)', () => {
    const six = guardrails.evaluate({ body: 'You can re-enter after six hours.' }, {});
    expect(six.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const twelve = guardrails.evaluate({ body: 'Keep children inside for twelve minutes after treatment.' }, {});
    expect(twelve.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('harmless / risk-free are the same unconditional claim (Codex PR r3)', () => {
    const harmless = guardrails.evaluate({ body: 'This pesticide is harmless to pets.' }, {});
    expect(harmless.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const riskFree = guardrails.evaluate({ body: 'The treatment is risk-free around children.' }, {});
    expect(riskFree.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('the conditional idiom exempts ONLY safe/safely phrasing — harmless/risk-free block even with both parts (Codex PR r5 audit)', () => {
    const riskFree = guardrails.evaluate({ body: 'The treatment is risk-free once dry, and your technician confirms re-entry timing.' }, {});
    expect(riskFree.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const harmless = guardrails.evaluate({ body: 'The spray is harmless once dry, and your technician confirms the timing.' }, {});
    expect(harmless.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('object-first and for-led drying durations block (Codex PR r3)', () => {
    const allowDry = guardrails.evaluate({ body: 'Allow the spray to dry for 30 minutes before re-entry.' }, {});
    expect(allowDry.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const waitFor = guardrails.evaluate({ body: 'Wait for thirty minutes before entering the treated room.' }, {});
    expect(waitFor.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('drying durations require a TREATMENT noun; plain-enter with treated context blocks (Codex PR r4)', () => {
    // Home-maintenance drying advice stays legal.
    const caulk = guardrails.evaluate({ body: 'Allow the caulk to dry for 30 minutes before inspecting the gap.' }, {});
    expect(caulk.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    const plainEnter = guardrails.evaluate({ body: 'You can enter the treated room after 30 minutes.' }, {});
    expect(plainEnter.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('compound spelled range endpoints are figures too (Codex PR r5)', () => {
    for (const body of [
      'You can re-enter after twenty-one to twenty-four hours.',
      'Wait twenty-one to twenty-four hours before re-entering.',
      'Keep pets off the lawn for thirty-one to forty-five minutes.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    }
  });

  test('bare drying durations WITHOUT treatment context stay legal (Codex PR r5 false positive)', () => {
    for (const body of [
      'Paint drying takes 30 minutes before the second coat.',
      'The caulk needs 30 minutes to dry before inspection.',
      'The primer dries in 30 minutes on a warm day.',
      'Give the wood filler a 30-minute drying period.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    }
    // The same shapes WITH treatment context still block.
    const anchored = guardrails.evaluate({ body: 'The spray needs 30 minutes to dry.' }, {});
    expect(anchored.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('pronoun safety claims with a treatment antecedent block (Codex PR r5)', () => {
    for (const body of [
      'The pesticide dries quickly. Then it is safe for pets.',
      'We apply a granular treatment. It is safe once dry.',
      'The application is watered in. After that, it is harmless to children.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    }
    // Non-treatment antecedents stay legal.
    const screen = guardrails.evaluate({ body: 'The repaired screen keeps insects out. It is safe for pets.' }, {});
    expect(screen.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    // With BOTH idiom parts the pronoun claim is the approved idiom.
    const idiom = guardrails.evaluate({ body: 'We apply a granular treatment. It is safe once dry, and your technician confirms the timing.' }, {});
    expect(idiom.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    // "safe to say" is an idiom, not a safety claim.
    const saying = guardrails.evaluate({ body: 'After any treatment, it is safe to say prevention matters most.' }, {});
    expect(saying.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('pest-control service/program subjects are safety claims too (Codex PR r5 audit)', () => {
    for (const body of [
      'Our pest control is safe for pets.',
      'Our pest-control program is safe for kids.',
      'We offer safe pest control for your family.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    }
  });

  test('generic service subjects and safe-from phrasing stay legal (Codex PR r6 false positives)', () => {
    for (const body of [
      'Your service plan is safe from unexpected price increases.',
      'The service is safe from cancellation.',
      'The home is safe from termite damage after repairs.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    }
    // Direct treatment subjects still block.
    const direct = guardrails.evaluate({ body: 'Our pest-control program is safe.' }, {});
    expect(direct.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('treatment context on either side of an entry duration blocks (Codex PR r6)', () => {
    for (const body of [
      'You may enter the room after 30 minutes following treatment.',
      'You can enter after 30 minutes once treatment is complete.',
      'The room can be entered 30 minutes after treatment.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    }
    // No treatment context anywhere in the sentence → not a re-entry figure.
    const waitingRoom = guardrails.evaluate({ body: 'You may enter the room after 30 minutes.' }, {});
    expect(waitingRoom.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('qualified EPA approval wording blocks (Codex PR r6)', () => {
    for (const body of [
      'This pesticide is approved for use by the EPA.',
      'These products were approved for residential use by EPA.',
      'EPA granted approval for this treatment.',
      'This product received approval from the EPA.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    }
    const required = guardrails.evaluate({ body: 'Every product we use is EPA-registered or EPA-exempt.' }, {});
    expect(required.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('denied EPA approval is accurate negated copy, not an approval claim (Codex PR r7)', () => {
    const denied = guardrails.evaluate({ body: "The product's approval was denied by the EPA." }, {});
    expect(denied.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('POSTPOSITIVE denials of EPA approval stay legal (Codex PR r8)', () => {
    for (const body of [
      'EPA approval was not granted for this treatment.',
      'EPA approval is not required for minimum-risk products.',
      'The EPA approval was later revoked.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    }
  });

  test('affirmative go-inside instructions with treatment context block (Codex PR r8)', () => {
    const mayGo = guardrails.evaluate({ body: 'You may go inside after 30 minutes once treatment is complete.' }, {});
    expect(mayGo.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const goInto = guardrails.evaluate({ body: 'You can go into the treated room after 30 minutes.' }, {});
    expect(goInto.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    // Without treatment context it is not a re-entry figure.
    const bare = guardrails.evaluate({ body: 'You may go inside after 30 minutes.' }, {});
    expect(bare.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('adverbs between the drying verb and preposition still carry the figure (Codex PR r8)', () => {
    const r = guardrails.evaluate({ body: 'The application dries completely within 45 minutes.' }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('modal/copular predicates are the same safety claim (Codex PR r8 audit)', () => {
    for (const body of [
      'The product will be safe once dry.',
      'The pesticide becomes safe after drying.',
      'The spray should be safe around pets.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    }
  });

  test('seconds and days are fixed figures too (Codex PR r8 audit)', () => {
    const seconds = guardrails.evaluate({ body: 'Do not re-enter the treated room for 90 seconds.' }, {});
    expect(seconds.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const day = guardrails.evaluate({ body: 'Keep pets off the treated lawn for one day.' }, {});
    expect(day.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('go-inside/go-into re-entry instructions carry the figure too (Codex PR r7)', () => {
    const inside = guardrails.evaluate({ body: 'Do not go inside the treated home for 30 minutes.' }, {});
    expect(inside.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const into = guardrails.evaluate({ body: 'Do not go into the treated room for 30 minutes.' }, {});
    expect(into.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('treatment-separated drying figures block (Codex PR r6)', () => {
    for (const body of [
      'Drying the treatment takes 30 minutes.',
      'Drying after the application takes 30 minutes.',
      'The treatment has a drying time of 30 minutes.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    }
  });

  test('the pronoun antecedent is the GOVERNING sentence, not any earlier treatment word (Codex PR r6 false positive)', () => {
    const screen = guardrails.evaluate({ body: 'The pesticide is applied outdoors. The repaired screen prevents entry. It is safe for pets.' }, {});
    expect(screen.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('"confirms the appointment time" is not the idiom second part (Codex PR r6)', () => {
    const apptTime = guardrails.evaluate({ body: 'The treatment is safe once dry. Your technician confirms the appointment time.' }, {});
    expect(apptTime.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    // A when-clause that itself concerns re-entry still completes the idiom.
    const whenSafe = guardrails.evaluate({ body: 'The treatment is safe once dry, and your technician confirms when it is safe to re-enter.' }, {});
    expect(whenSafe.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('treated-surface subjects reach the idiom check — incomplete idiom blocks (Codex PR r4)', () => {
    const surfaces = guardrails.evaluate({ body: 'Treated surfaces are safe once dry.' }, {});
    expect(surfaces.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const rooms = guardrails.evaluate({ body: 'Treated rooms are safe once dry, and your technician confirms the timing.' }, {});
    expect(rooms.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('safe-for claims about NON-pesticide objects stay legal (Codex PR r2 false positive)', () => {
    for (const body of [
      'The repaired screen is safe for pets.',
      'Choose plants that are safe for pollinators.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    }
    // Treatment-context claims still block.
    const treatment = guardrails.evaluate({ body: 'This spray is safe for pets and pollinators.' }, {});
    expect(treatment.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('wait/return timing advice WITHOUT re-entry context stays legal (Codex PR r1 false positive)', () => {
    const r = guardrails.evaluate({ body: 'Wait 30 minutes before returning to check whether ants took the bait.' }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    // With treated-area context the same shape still blocks.
    const treated = guardrails.evaluate({ body: 'Wait 30 minutes before returning to the treated lawn.' }, {});
    expect(treated.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('the approved CONDITIONAL idiom stays legal — dry condition + technician-confirms, condition before or after the claim', () => {
    const r = guardrails.evaluate({
      body: 'The lawn is safe once dry, and your technician confirms timing. Once the application dries, it is safe for kids and pets to return.',
    }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('the dry condition ALONE is not the full idiom — without technician-confirms it blocks (both parts required)', () => {
    const r = guardrails.evaluate({ body: 'The lawn is safe once dry.' }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    // The confirmation must concern TIMING — an unrelated technician
    // confirmation (appointment address) is not the idiom's second part.
    const unrelated = guardrails.evaluate({
      body: 'The treatment is safe for pets once dry. Your technician confirms the appointment address.',
    }, {});
    expect(unrelated.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('attributive "safe pesticides" / "safe treatment options" blocks', () => {
    const r = guardrails.evaluate({ body: 'We use safe pesticides around your home.' }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const r2 = guardrails.evaluate({ body: 'Ask about our safe treatment options for lawns.' }, {});
    expect(r2.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('a FIXED re-entry/drying figure blocks even with a dry condition nearby — including ranges and spelled numbers', () => {
    const r = guardrails.evaluate({ body: 'You can re-enter after 30 minutes once everything is dry.' }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const r2 = guardrails.evaluate({ body: 'The application dries within 20 minutes.' }, {});
    expect(r2.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const range = guardrails.evaluate({ body: 'Plan to re-enter after 30–60 minutes.' }, {});
    expect(range.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const spelled = guardrails.evaluate({ body: 'You can go back inside after thirty minutes.' }, {});
    expect(spelled.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('duration-before-action and keep-off word orders block too', () => {
    const wait = guardrails.evaluate({ body: 'Wait 30 minutes before re-entering the treated area.' }, {});
    expect(wait.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const keepOff = guardrails.evaluate({ body: 'Keep pets off the lawn for 30 minutes.' }, {});
    expect(keepOff.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const allow = guardrails.evaluate({ body: 'Allow 30 minutes of drying time before returning to the treated lawn.' }, {});
    expect(allow.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const stayOff = guardrails.evaluate({ body: 'Stay off the lawn for 30 minutes.' }, {});
    expect(stayOff.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const doNot = guardrails.evaluate({ body: 'Do not re-enter for 30 minutes.' }, {});
    expect(doNot.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const needsToDry = guardrails.evaluate({ body: 'The treatment needs 30 minutes to dry.' }, {});
    expect(needsToDry.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const dryingTakes = guardrails.evaluate({ body: 'After a liquid application, drying takes 30 minutes in Florida sun.' }, {});
    expect(dryingTakes.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const dryingTimeIs = guardrails.evaluate({ body: 'The drying time is 30 minutes for granular applications.' }, {});
    expect(dryingTimeIs.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const hyphenated = guardrails.evaluate({ body: 'Expect a 30-minute drying period after each treatment.' }, {});
    expect(hyphenated.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const fractional = guardrails.evaluate({ body: 'Wait half an hour before re-entering.' }, {});
    expect(fractional.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const requires = guardrails.evaluate({ body: 'Applications require 30 minutes before people can re-enter.' }, {});
    expect(requires.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const until = guardrails.evaluate({ body: 'Keep children away until 30 minutes after application.' }, {});
    expect(until.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const unhyphenated = guardrails.evaluate({ body: 'Plan for a 30 minute re-entry interval.' }, {});
    expect(unhyphenated.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    // Duration figures are banned in EVERY polarity — negation is not a
    // disclaimer here, it IS the prohibited instruction.
    const negatedUntil = guardrails.evaluate({ body: 'Do not re-enter until 30 minutes have passed.' }, {});
    expect(negatedUntil.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const negatedAfter = guardrails.evaluate({ body: 'Do not re-enter after 30 minutes.' }, {});
    expect(negatedAfter.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    // Worded ranges are figures too.
    const wordRange = guardrails.evaluate({ body: 'You can re-enter after 30 to 60 minutes.' }, {});
    expect(wordRange.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const spelledRange = guardrails.evaluate({ body: 'Wait one to two hours before re-entering.' }, {});
    expect(spelledRange.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const approx = guardrails.evaluate({ body: 'The application dries in about 30 minutes.' }, {});
    expect(approx.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const decimal = guardrails.evaluate({ body: 'You can return in 1.5 hours.' }, {});
    expect(decimal.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const compound = guardrails.evaluate({ body: 'Keep pets off the lawn for two and a half hours.' }, {});
    expect(compound.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const avoidArea = guardrails.evaluate({ body: 'Avoid the treated area for 30 minutes.' }, {});
    expect(avoidArea.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const qualifier = guardrails.evaluate({ body: 'Our pesticide is environmentally safe.' }, {});
    expect(qualifier.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    // Negated predicate stays a disclaimer despite the generic qualifier gap.
    const negated = guardrails.evaluate({ body: 'No pesticide is truly safe while wet, which is why the label interval matters.' }, {});
    expect(negated.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    // Adverbial "safely" without BOTH idiom parts blocks; with dry-condition
    // AND technician confirmation it is the approved idiom.
    const adverbBare = guardrails.evaluate({ body: 'You can safely re-enter once dry.' }, {});
    expect(adverbBare.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    const adverbFull = guardrails.evaluate({ body: 'You can safely re-enter once dry — your technician confirms the timing.' }, {});
    expect(adverbFull.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
    const directClaim = guardrails.evaluate({ body: 'Our pesticides are completely safe.' }, {});
    expect(directClaim.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
    // No figure, label-directed — legal.
    const legal = guardrails.evaluate({ body: 'Keep pets off the lawn until it is dry per the label, and your technician confirms timing.' }, {});
    expect(legal.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });

  test('"safe … when wet or dry" is a claim of safety in EVERY state, never the conditional idiom', () => {
    const r = guardrails.evaluate({
      body: 'The granules are safe for pets when wet or dry, and your technician confirms timing.',
    }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('a violation in the meta description blocks too (publishable text covers meta)', () => {
    const r = guardrails.evaluate({
      body: 'Follow the label re-entry directions after any application.',
      frontmatter: { meta_description: 'Pet-safe lawn treatments for Sarasota homes.' },
    }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(true);
  });

  test('label-directed phrasing and negated disclaimers stay legal', () => {
    const r = guardrails.evaluate({
      body: [
        'Follow the label re-entry directions and keep pets off the lawn until the application is dry.',
        'No product is completely safe for pets in the wet window, which is why the label interval matters.',
      ].join(' '),
    }, {});
    expect(r.findings.some((f) => f.code === 'REENTRY_SAFETY_CLAIM')).toBe(false);
  });
});

describe('banned service topics guard (P0 BANNED_TOPIC)', () => {
  test('"we offer fumigation" blocks at P0', () => {
    const r = guardrails.evaluate({ body: 'For severe drywood termites, we offer whole-structure fumigation.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC' && f.severity === 'P0')).toBe(true);
  });

  test('"our wildlife trapping service" blocks', () => {
    const r = guardrails.evaluate({ body: 'Ask about our wildlife trapping service for raccoons in the attic.' }, {});
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('ownership phrasings block — "Our services include …", "We can help with …"', () => {
    const r = guardrails.evaluate({ body: 'Our services include structural fumigation for severe drywood cases.' }, {});
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const r2 = guardrails.evaluate({ body: 'We can help with wildlife removal when raccoons move into the attic.' }, {});
    expect(r2.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('direct banned-service verbs block — "We fumigate homes", "Our technicians tent homes"', () => {
    const fumigate = guardrails.evaluate({ body: 'We fumigate homes for drywood termites.' }, {});
    expect(fumigate.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const tent = guardrails.evaluate({ body: 'Our technicians tent homes across Sarasota.' }, {});
    expect(tent.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    // The negated disclaimer form stays legal.
    const disclaimer = guardrails.evaluate({ body: 'We do not fumigate homes — tenting is a referral to a licensed structural fumigator.' }, {});
    expect(disclaimer.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('topic-specific ownership verbs block — install/trap/remove', () => {
    const install = guardrails.evaluate({ body: 'We install attic insulation as part of rodent-proofing.' }, {});
    expect(install.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const trap = guardrails.evaluate({ body: 'Our technicians trap wildlife humanely.' }, {});
    expect(trap.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const remove = guardrails.evaluate({ body: 'We remove raccoons from attics across Sarasota.' }, {});
    expect(remove.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    // Informational: a wildlife specialist doing these stays legal.
    const info = guardrails.evaluate({ body: 'A licensed wildlife specialist traps raccoons and relocates them per FWC rules.' }, {});
    expect(info.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('"call Waves for insulation" blocks — and contact/ask variants', () => {
    const r = guardrails.evaluate({ body: 'Call Waves for attic insulation quotes while we are on site.' }, {});
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const contact = guardrails.evaluate({ body: 'Contact Waves for wildlife trapping in Manatee County.' }, {});
    expect(contact.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const ask = guardrails.evaluate({ body: 'Ask us about attic insulation during your next visit.' }, {});
    expect(ask.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('informational mention stays legal — no first-person service anchor', () => {
    const r = guardrails.evaluate({
      body: [
        'Severe drywood termite infestations may call for structural fumigation, which is handled by tenting specialists.',
        'Light infestations do not call for fumigation at all.',
        'Wildlife trapping is regulated separately in Florida.',
      ].join(' '),
    }, {});
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('the wanted referral disclaimer stays legal', () => {
    const r = guardrails.evaluate({ body: 'We do not offer fumigation — for tenting we refer you to a licensed structural fumigator.' }, {});
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('a bare schedule/book CTA blocks without "with us" — on our pages it presents the topic as our service', () => {
    const r = guardrails.evaluate({ body: 'Schedule your structural fumigation today and we will handle the rest.' }, {});
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('a schedule CTA directing to a THIRD PARTY stays legal', () => {
    const r = guardrails.evaluate({ body: 'For severe drywood cases, schedule tenting with a licensed structural fumigator.' }, {});
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('bare possessive ownership blocks — "our fumigation treatment", "our wildlife removal" (Codex PR r1)', () => {
    for (const body of [
      'Our fumigation treatment eliminates drywood termites.',
      'Our insulation work keeps pests out.',
      'Our wildlife removal keeps your attic quiet.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    }
    const referral = guardrails.evaluate({ body: 'Our fumigation referral partner handles the tenting itself.' }, {});
    expect(referral.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('get-out phrasing is wildlife removal; referral framing BEFORE the topic stays legal (Codex PR r3)', () => {
    const getOut = guardrails.evaluate({ body: 'Our team gets raccoons out of attics across Sarasota.' }, {});
    expect(getOut.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const weGet = guardrails.evaluate({ body: 'We get squirrels out of your attic humanely.' }, {});
    expect(weGet.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const referralBefore = guardrails.evaluate({ body: 'Our referral for wildlife removal goes to licensed partners.' }, {});
    expect(referralBefore.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('modified possessives block too — "our professional wildlife removal", "our humane raccoon removal" (Codex PR r2)', () => {
    for (const body of [
      'Ask about our professional wildlife removal for attic pests.',
      'Our humane raccoon removal service starts with an inspection.',
      'Our attic insulation service seals rodent entry points.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    }
  });

  test('generic wildlife relocation/exclusion offerings block (Codex PR r5)', () => {
    const relocation = guardrails.evaluate({ body: 'Our wildlife relocation service protects your attic.' }, {});
    expect(relocation.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const exclusion = guardrails.evaluate({ body: 'We offer wildlife exclusion for Sarasota attics.' }, {});
    expect(exclusion.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    // The county agency in referral copy stays legal.
    const agency = guardrails.evaluate({ body: 'For an injured raccoon, contact animal control or an FWC-licensed rehabilitator.' }, {});
    expect(agency.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
    // Exclusion as an ACTION verb is the same offering (Codex PR r5 audit).
    const excludeRaccoons = guardrails.evaluate({ body: 'We exclude raccoons from Sarasota attics.' }, {});
    expect(excludeRaccoons.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const excludeWildlife = guardrails.evaluate({ body: 'Our technicians exclude wildlife from your attic.' }, {});
    expect(excludeWildlife.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('informational possessives stay legal — guides/articles/advice introduce the topic, not a service (Codex PR r5)', () => {
    for (const body of [
      'Our guide to wildlife removal explains when to call a licensed specialist.',
      'Our article on structural fumigation explains when tenting may be necessary.',
      'Our advice about wildlife trapping is to contact an FWC-licensed specialist.',
      'Our wildlife removal guide covers what licensed trappers actually do.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
    }
  });

  test('Waves possessives are ownership claims (Codex PR r5)', () => {
    const waves = guardrails.evaluate({ body: "Waves' fumigation service handles drywood termites." }, {});
    expect(waves.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const wavesPC = guardrails.evaluate({ body: "Waves Pest Control's wildlife trapping service protects attics." }, {});
    expect(wavesPC.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('third-party wildlife attribution stays legal (Codex PR r6 false positive)', () => {
    for (const body of [
      'We help specialists remove wildlife.',
      'We let partners remove wildlife.',
      'We have partners trap wildlife.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
    }
  });

  test('exclude-as-omit stays legal — only physical exclusion is the service (Codex PR r6)', () => {
    const examples = guardrails.evaluate({ body: 'We exclude wildlife examples from this comparison.' }, {});
    expect(examples.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
    const discussion = guardrails.evaluate({ body: 'We exclude animals from this discussion.' }, {});
    expect(discussion.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('insulation work/project offerings block; inspection artifacts stay legal (Codex PR r6)', () => {
    for (const body of [
      'We perform attic insulation work.',
      'We do attic insulation work.',
      'Our team completes attic insulation projects.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    }
    const photos = guardrails.evaluate({ body: 'We can provide photos of attic insulation during the inspection.' }, {});
    expect(photos.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
    // Insulation as a LOCATION for installed objects is not an offering
    // (Codex PR r7).
    const traps = guardrails.evaluate({ body: 'Our technicians install traps above attic insulation.' }, {});
    expect(traps.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });

  test('info nouns extend to information/reports/glossaries (Codex PR r6)', () => {
    for (const body of [
      'Our information about wildlife removal explains when to call a specialist.',
      'Our report on wildlife removal summarizes state guidance.',
      'Our wildlife removal glossary defines common terms.',
      // Checklist/handbook labels are the same informational framing
      // (Codex PR r8).
      'Our checklist for wildlife removal explains when to call a licensed specialist.',
      'Our wildlife removal checklist explains referrals.',
      'Our handbook on structural fumigation covers when tenting is needed.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
    }
  });

  test('handling EXISTING insulation during inspection stays legal (Codex PR r1 false positive)', () => {
    for (const body of [
      'Our technicians handle attic insulation carefully while checking for rodent entry points.',
      'We handle homes with attic insulation without disturbing the material.',
    ]) {
      const r = guardrails.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
    }
    // Service-unambiguous insulation verbs still block.
    const sells = guardrails.evaluate({ body: 'We provide attic insulation for older Sarasota homes.' }, {});
    expect(sells.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('sales framings block — request-from / get-from / choose-for', () => {
    const request = guardrails.evaluate({ body: 'Request a structural fumigation quote from Waves.' }, {});
    expect(request.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const getFrom = guardrails.evaluate({ body: 'Get attic insulation from Waves Pest Control.' }, {});
    expect(getFrom.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const choose = guardrails.evaluate({ body: 'Choose Waves for wildlife trapping in Bradenton.' }, {});
    expect(choose.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('species-specific CONTROL offerings block — "our bat control service", "we offer raccoon control" (Codex PR r4)', () => {
    const bat = guardrails.evaluate({ body: 'Our bat control service protects your attic year-round.' }, {});
    expect(bat.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const raccoon = guardrails.evaluate({ body: 'We offer raccoon control throughout Sarasota.' }, {});
    expect(raccoon.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
  });

  test('species-specific removal CTAs block — "Book raccoon removal today"', () => {
    const r = guardrails.evaluate({ body: 'Book raccoon removal today and sleep better tonight.' }, {});
    expect(r.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(true);
    const referral = guardrails.evaluate({ body: 'Book raccoon removal with a licensed wildlife operator.' }, {});
    expect(referral.findings.some((f) => f.code === 'BANNED_TOPIC')).toBe(false);
  });
});
