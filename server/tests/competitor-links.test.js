/**
 * Owner rulings 2026-09-28: "I do not want to link to a competitor's website,
 * whatsoever" — and refuse, don't rewrite. One competitor-host matcher, one
 * detector for every URL form a browser follows, the P1 guard that sends a
 * draft back to the writer, and the publisher's refusal at commit.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const {
  competitorHosts, isCompetitorHost, competitorLinkUrls, competitorLinkUrlsIn,
} = require('../services/content/competitor-links');

describe('competitor host matcher', () => {
  test('unions every competitor list the portal maintains (imported, not re-typed)', () => {
    const hosts = competitorHosts();
    // competitor-facts curated records (their sourced official hosts)
    for (const h of ['orkin.com', 'terminix.com', 'trugreen.com', 'masseyservices.com', 'pestdefense.com', 'prodigypest.com']) expect(hosts.has(h)).toBe(true);
    // competitor-discovery NATIONAL_CHAINS
    for (const h of ['mosquitojoe.com', 'lawndoctor.com', 'pestie.com']) expect(hosts.has(h)).toBe(true);
    // competitor-gap-miner tracked locals + the classifier's extra competitors
    for (const h of ['turnerpest.com', 'westfallspestcontrol.com', 'flapest.com', 'hometeampestdefense.com']) expect(hosts.has(h)).toBe(true);
    // never our own hub or spokes, never a reference/listing site
    for (const h of ['wavespestcontrol.com', 'ufl.edu', 'edis.ifas.ufl.edu', 'bbb.org', 'epa.gov', 'consumeraffairs.com', 'web.archive.org']) {
      expect(isCompetitorHost(h, hosts)).toBe(false);
    }
  });

  test('every competitor domain the SEO tools track is a competitor host (Codex r2 on #5191)', () => {
    // Read from the tools' own source, so a domain added there without
    // reaching this matcher fails here.
    const fs = require('fs');
    const path = require('path');
    const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const tracked = /TRACKED_COMPETITORS = \[([^\]]*)\]/.exec(src('services/seo/rank-tracker.js'))[1].match(/'([^']+)'/g).map((q) => q.slice(1, -1));
    const seeded = [...src('routes/admin-seo-v2.js').matchAll(/domain: '([^']+)', market_area/g)].map((m) => m[1]);
    expect(tracked.length).toBeGreaterThan(3);
    expect(seeded.length).toBeGreaterThan(3);
    const hosts = competitorHosts();
    for (const d of [...tracked, ...seeded]) expect([d, isCompetitorHost(d, hosts)]).toEqual([d, true]);
  });

  test('matches www / m / subdomains of a competitor host, never lookalikes', () => {
    const hosts = competitorHosts();
    for (const h of ['www.orkin.com', 'm.orkin.com', 'careers.orkin.com', 'ORKIN.COM']) expect(isCompetitorHost(h, hosts)).toBe(true);
    for (const h of ['notorkin.com', 'orkin.com.example.net']) expect(isCompetitorHost(h, hosts)).toBe(false);
  });

  test('a new curated competitor record flows in automatically — its sourced and declared hosts only (Aptive, #5146)', () => {
    // aptive.com is an unrelated software company: never a competitor host.
    expect(isCompetitorHost('aptive.com')).toBe(false);
    jest.isolateModules(() => {
      const actual = jest.requireActual('../services/content/competitor-facts');
      jest.doMock('../services/content/competitor-facts', () => ({
        ...actual,
        COMPETITORS: [...actual.COMPETITORS, {
          id: 'aptive', name: 'Aptive Environmental', aliases: ['aptive pest control'],
          hosts: ['goaptive.com'],
          attributes: { reach: { value: 'Multi-state', source: 'https://aptivepestcontrol.com/', asOf: '2026-09-28' } },
        }],
      }));
      const fresh = require('../services/content/competitor-links');
      const hosts = fresh.competitorHosts();
      expect(hosts.has('aptivepestcontrol.com')).toBe(true);
      expect(hosts.has('goaptive.com')).toBe(true);
      expect(hosts.has('aptive.com')).toBe(false);
      expect(fresh.competitorLinkUrls('Per [Aptive](https://aptivepestcontrol.com/terms) and [the old site](https://www.goaptive.com/x).'))
        .toEqual(['https://aptivepestcontrol.com/terms', 'https://www.goaptive.com/x']);
      expect(fresh.competitorLinkUrls('[Aptive Intelligence](https://aptive.com/)')).toEqual([]);
    });
  });
});

describe('competitorLinkUrls: every form a browser follows', () => {
  const found = (t) => competitorLinkUrls(t).length > 0;

  test('Markdown inline, reference, autolink and bare forms', () => {
    for (const t of [
      'Per [Orkin\'s published terms](https://www.orkin.com/terms "Terms").',
      'See [the plan page](<https://www.terminix.com/plans>).',
      'Their [plan page][tg].\n\n[tg]: https://www.trugreen.com/plans "TruGreen"\n',
      'See [their terms][t].\n\n[t]:\n  //orkin.com/terms\n',
      'Details at https://www.orkin.com/pricing, and www.turnerpest.com.',
      'Or <https://pestdefense.com/a>.',
      '![Orkin logo](https://www.orkin.com/logo.png)',
      '[![logo](https://orkin.com/l.png)](https://terminix.com/)',
      '[plans](https://orkin.com/foo(bar(baz)))',
    ]) expect([t, found(t)]).toEqual([t, true]);
  });

  test('HTML and MDX: anchors, images, iframes, component props, string expressions', () => {
    for (const t of [
      '<a href="https://www.masseyservices.com/x" rel="nofollow">Massey\'s site</a>',
      '<img alt="" src=\'https://www.terminix.com/x.png\' />',
      '<iframe src="https://www.orkin.com/video"></iframe>',
      '<InlineCTA headline="Compare" ctaHref="https://www.orkin.com/quote" ctaLabel="Visit Orkin" />',
      '<a href={"https://www.orkin.com/x"}>Orkin</a>',
      '<InlineCTA ctaHref={\'https://orkin.com/y\'} ctaLabel="Compare plans" />',
    ]) expect([t, found(t)]).toEqual([t, true]);
  });

  test('encoded and escaped destinations are read as a browser reads them (Codex r1, r4 on #5191)', () => {
    expect(competitorLinkUrls('<a href="https://orkin&#46;com/">Orkin</a>')).toEqual(['https://orkin.com/']);
    expect(competitorLinkUrls('Per [Orkin](https://orkin\\.com/plans).')).toEqual(['https://orkin\\.com/plans']);
    expect(competitorLinkUrls('[x](//orkin.com/a)')).toEqual(['//orkin.com/a']);
    // Backslash separators reach the competitor host in a browser.
    expect(found('[x](https:\\\\orkin.com\\\\plans)')).toBe(true);
    expect(found('<a href="https:\\\\www.terminix.com">T</a>')).toBe(true);
    expect(found('See https:orkin.com/x now')).toBe(true);
  });

  test('userinfo before the host does not hide it: the browser goes to the host (Codex r7 on #5191)', () => {
    for (const t of [
      '[source](//user@orkin.com/path)',
      'https:user@orkin.com/x',
      '<a href="//a@b@orkin.com">x</a>',
      '[x](<//us(er@orkin.com>)',
      '<a href="https://waves.com@orkin.com/">x</a>',
    ]) expect([t, found(t)]).toEqual([t, true]);
    // The reverse goes to waves.com, not the competitor.
    expect(found('<a href="https://orkin.com@wavespestcontrol.com/">x</a>')).toBe(false);
  });

  test('Markdown escapes, quotes in userinfo, U+FEFF and a start glued to a link do not hide it (Codex r8 on #5191)', () => {
    for (const t of [
      '[Orkin](https\\://orkin.com/plans)',
      '[x](https\\:\\/\\/orkin.com)',
      '[x](//user\\@orkin.com/a)',
      'See https://ork\uFEFFin.com/x',
      '<a href=\'//us"er@orkin.com/x\'>x</a>',
      '<a href="//us\'er@orkin.com/x">x</a>',
      '[a](https://www.wavespestcontrol.com/x)(https://orkin.com)',
    ]) expect([t, found(t)]).toEqual([t, true]);
    // One URL per link, however many readings found it.
    expect(competitorLinkUrls('Per [Orkin](https://orkin\\.com/plans).')).toHaveLength(1);
  });

  test('a tab or newline inside a URL does not hide it: browsers remove them (Codex r6 on #5191)', () => {
    expect(competitorLinkUrls('[plans](https://or\tkin.com/plans)')).toEqual(['https://orkin.com/plans']);
    expect(competitorLinkUrls('<a href="https://www.ork\nin.com/x">Orkin</a>')).toEqual(['https://www.orkin.com/x']);
    expect(competitorLinkUrls('<a href="https://ork&#9;in.com/">Orkin</a>')).toEqual(['https://orkin.com/']);
    expect(competitorLinkUrls('<a href="https://orkin&NewLine;.com/">Orkin</a>')).toEqual(['https://orkin.com/']);
  });

  test('a competitor URL in code is refused too: nothing is rewritten, so nothing is corrupted (Codex r6 on #5191)', () => {
    expect(found('Run `curl https://www.orkin.com/api`')).toBe(true);
    expect(found('```\n[Orkin](https://orkin.com)\n```')).toBe(true);
  });

  test('an archived copy links archive.org, not the competitor\'s site (operator briefs may cite one)', () => {
    expect(found('[an archived copy](https://web.archive.org/web/2026/https://www.orkin.com/terms/)')).toBe(false);
  });

  test('plain-text names and domains, and links to anyone else, are not links to a competitor', () => {
    const text = [
      'Orkin and Terminix both sell plans; see orkin.com for theirs.',
      'Per [UF/IFAS](https://edis.ifas.ufl.edu/IG098) and [BBB](https://www.bbb.org/us/fl/x).',
      'See <a href="https://www.epa.gov/pesticides">EPA</a>, https://www.consumeraffairs.com/x and',
      '[ok](https://edis.ifas.ufl.edu/x(1)), a//b, https://edis.ifas.ufl.edu//x, a path like //not-a-host.',
      'Our [termite page](/termite/termite-bond/) and [calculator](https://www.wavespestcontrol.com/pest-control-calculator/).',
      '[ifas]: https://edis.ifas.ufl.edu/x',
    ].join('\n');
    expect(competitorLinkUrls(text)).toEqual([]);
  });
});

describe('competitorLinkUrlsIn: body plus every frontmatter string', () => {
  test('every string at any depth, URL-valued fields included; other values ignored (Codex r4 on #5191)', () => {
    const urls = competitorLinkUrlsIn({
      title: 'Orkin vs Waves',
      meta_description: 'Compare with https://www.orkin.com plans.',
      hero_image: { src: '/img/x.webp', alt: 'A [Terminix](https://terminix.com) truck' },
      next_steps: [{ label: 'See plans', href: 'https://www.trugreen.com/plans' }],
      reading_time_min: 6,
      published: new Date('2026-09-28'),
    }, 'Body about ants.');
    expect(urls.sort()).toEqual(['https://terminix.com', 'https://www.orkin.com', 'https://www.trugreen.com/plans']);
  });

  test('reads the parsed value, not its YAML: a tab in a URL-valued field is caught (Codex r6 on #5191)', () => {
    expect(competitorLinkUrlsIn({ next_steps: [{ href: 'https://or\tkin.com/plans' }] }, '')).toEqual(['https://orkin.com/plans']);
  });

  test('a clean document has none', () => {
    expect(competitorLinkUrlsIn({ title: 'Ants', tags: ['orkin'] }, 'Per Orkin\'s published terms.')).toEqual([]);
  });
});

describe('publisher: competitorFreeMarkdown refuses, never rewrites', () => {
  const { competitorFreeMarkdown } = require('../services/content-astro/astro-publisher')._internals;
  test('a competitor link in the body or any frontmatter field refuses the commit', () => {
    for (const [frontmatter, body] of [
      [{ title: 'Ants' }, 'Per [Orkin](https://www.orkin.com/x).'],
      [{ meta_description: 'Plans at https://www.orkin.com/plans compared.' }, 'Body.'],
      [{ next_steps: [{ label: 'See plans', href: 'https://or\tkin.com/plans' }] }, 'Body.'],
    ]) {
      expect(() => competitorFreeMarkdown(frontmatter, body)).toThrow(expect.objectContaining({ code: 'COMPETITOR_LINK' }));
    }
  });
  test('a clean document is stringified unchanged', () => {
    const fm = require('../services/content-astro/frontmatter');
    expect(competitorFreeMarkdown({ title: 'Ants' }, 'Per Orkin\'s published terms.\n'))
      .toBe(fm.stringify({ title: 'Ants' }, 'Per Orkin\'s published terms.\n'));
  });
});

describe('guardrail: COMPETITOR_LINK (P1)', () => {
  const guardrails = require('../services/content/content-guardrails');
  test('blocks a competitor link, so the self-lint sends the draft back; a plain mention passes', () => {
    const r = guardrails.evaluate({ body: 'Per [Orkin terms](https://www.orkin.com/terms) as of June 2026.' }, { operatorCitations: true });
    expect(r.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COMPETITOR_LINK', severity: 'P1' })]));
    expect(r.pass).toBe(false);
    const clean = guardrails.evaluate({ body: 'Per Orkin terms as of June 2026. See [UF/IFAS](https://edis.ifas.ufl.edu/x).' }, { operatorCitations: true });
    expect(clean.findings.some((f) => f.code === 'COMPETITOR_LINK')).toBe(false);
  });

  test('a competitor URL in any frontmatter field is flagged in-loop, next_steps included (Codex r4, r6)', () => {
    for (const href of ['https://orkin.com/plans', 'https://or\tkin.com/plans']) {
      const r = guardrails.evaluate({ body: 'Plain body about ants.', frontmatter: { next_steps: [{ label: 'See plans', href }] } }, { operatorCitations: true });
      expect(r.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COMPETITOR_LINK', severity: 'P1' })]));
    }
  });
});
