/**
 * Owner ruling 2026-09-28: "I do not want to link to a competitor's website,
 * whatsoever." One competitor-host matcher, a deterministic unlinker (the
 * wording stays, only the link goes), and the P1 guard for anything left.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const {
  competitorHosts, isCompetitorHost, competitorLinkUrls, unlinkCompetitorLinks, unlinkCompetitorLinksDeep,
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
      expect(fresh.unlinkCompetitorLinks('Per [Aptive](https://aptivepestcontrol.com/terms) and [the old site](https://www.goaptive.com/x).').text)
        .toBe('Per Aptive and the old site.');
      expect(fresh.unlinkCompetitorLinks('[Aptive Intelligence](https://aptive.com/)').unlinked).toEqual([]);
    });
  });
});

describe('unlinkCompetitorLinks', () => {
  const un = (t) => unlinkCompetitorLinks(t);

  test('Markdown inline links keep their anchor text (titles and nested brackets too)', () => {
    const r = un('Per [Orkin\'s published terms](https://www.orkin.com/terms "Terms") as of June 2026, see [the **plan** page](<https://www.terminix.com/plans>).');
    expect(r.text).toBe('Per Orkin\'s published terms as of June 2026, see the **plan** page.');
    expect(r.unlinked.map((u) => u.url)).toEqual(['https://www.orkin.com/terms', 'https://www.terminix.com/plans']);
  });

  test('bare URLs and www autolinks become the plain, non-linking domain', () => {
    expect(un('Details at https://www.orkin.com/pricing, and www.turnerpest.com. Or <https://pestdefense.com/a>.').text)
      .toBe('Details at orkin.com, and turnerpest.com. Or pestdefense.com.');
  });

  test('reference-style links (full, collapsed, shortcut) keep their text and lose the definition', () => {
    const r = un('Their [plan page][tg], the [TruGreen][] plan, and [TruGreen].\n\n[tg]: https://www.trugreen.com/plans "TruGreen"\n[TruGreen]: <https://trugreen.com>\n');
    expect(r.text).toBe('Their plan page, the TruGreen plan, and TruGreen.\n\n');
    expect(r.unlinked.every((u) => /trugreen\.com/.test(u.url))).toBe(true);
    expect(competitorLinkUrls(r.text)).toEqual([]);
  });

  test('HTML anchors keep their inner text; a competitor CTA becomes its label, never the component minus its link', () => {
    // InlineCTA without ctaHref renders the Waves quote link, so dropping only
    // the prop would re-point a competitor-labeled CTA at Waves.
    const r = un('<a href="https://www.masseyservices.com/x" rel="nofollow">Massey\'s site</a> and <InlineCTA headline="Compare" ctaHref="https://www.orkin.com/quote" ctaLabel="Visit Orkin" />');
    expect(r.text).toBe('Massey\'s site and Visit Orkin');
  });

  test('raw HTML: an image becomes its alt text; markup it cannot rewrite is left intact for the survivor check (Codex r2 on #5191)', () => {
    expect(un('<img src="https://orkin.com/logo.png" alt="Orkin logo">').text).toBe('Orkin logo');
    expect(un('<img alt="" src=\'https://www.terminix.com/x.png\' />').text).toBe('');
    // Never a broken relative URL: no rewrite inside any other tag…
    for (const raw of ['<iframe src="https://www.orkin.com/video"></iframe>', '<Card href="https://orkin.com/x">Orkin</Card>']) {
      expect(un(raw).text).toBe(raw);
      // …so the publisher's survivor check sees it and refuses the commit.
      expect(competitorLinkUrls(raw)).toHaveLength(1);
    }
    // Prose around tags still unlinks.
    expect(un('See https://www.orkin.com/pricing<br/>now').text).toBe('See orkin.com<br/>now');
  });

  test('entity-encoded hrefs, next-line reference destinations and protocol-relative links are caught (pre-push audit)', () => {
    expect(un('<a href="https://orkin&#46;com/">Orkin</a>').text).toBe('Orkin');
    expect(un('See [their terms][t].\n\n[t]:\n  //orkin.com/terms\n').text).toBe('See their terms.\n\n');
    expect(un('[plans](//www.orkin.com/a) and <a href="//terminix.com">Terminix</a>').text).toBe('plans and Terminix');
    expect(un('<Cta ctaHref="https://orkin&#46;com/q" caption="Source: orkin.com" />').text).toBe('orkin.com');
    // Detection reads decoded text, so an encoded survivor is still caught.
    expect(competitorLinkUrls('raw https://orkin&#46;com/x')).toEqual(['https://orkin.com/x']);
    expect(competitorLinkUrls('[x](//orkin.com/a)')).toEqual(['//orkin.com/a']);
    expect(competitorLinkUrls('a//b and see https://edis.ifas.ufl.edu//x')).toEqual([]);
  });

  test('balanced destinations and browser URL rules (Codex r4 on #5191)', () => {
    // Nested parentheses: the whole link goes, never a broken relative remnant.
    expect(un('[plans](https://orkin.com/foo(bar(baz)))').text).toBe('plans');
    expect(un('[ok](https://edis.ifas.ufl.edu/x(1))').text).toBe('[ok](https://edis.ifas.ufl.edu/x(1))');
    // Backslash separators reach the competitor host in a browser.
    expect(un('[x](https:\\\\orkin.com\\\\plans) and <a href="https:\\\\www.terminix.com">T</a>').text).toBe('x and T');
    expect(un('See https:\\\\orkin.com\\\\x now').text).toBe('See orkin.com now');
    expect(competitorLinkUrls('<a href="https:\\\\orkin.com">o</a>')).toHaveLength(1);
    // Angle-bracket destination with a title; an image inside a link label.
    expect(un('[t](<https://orkin.com/a b> "title")').text).toBe('t');
    expect(un('[![logo](https://orkin.com/l.png)](https://terminix.com/)').text).toBe('logo');
  });

  test('a URL-valued frontmatter field is left as written for the survivor check, never made a broken destination (Codex r4)', () => {
    const { value } = unlinkCompetitorLinksDeep({
      next_steps: [{ label: 'See plans', href: 'https://orkin.com/plans' }],
      meta_description: 'Compare https://orkin.com/x here',
    });
    expect(value.next_steps[0].href).toBe('https://orkin.com/plans');
    expect(value.meta_description).toBe('Compare orkin.com here');
    expect(competitorLinkUrls(JSON.stringify(value))).toEqual(['https://orkin.com/plans']);
  });

  test('a competitor-hosted image becomes its alt text (no request to their site)', () => {
    expect(un('![Orkin logo](https://www.orkin.com/logo.png)').text).toBe('Orkin logo');
  });

  test('CommonMark backslash-escaped link destinations are decoded before host matching (Codex r1 P1)', () => {
    // [Orkin](https://orkin\.com/plans) renders as a link to orkin.com — the
    // backslash never reaches the browser and must not defeat matching.
    const r = un('Per [Orkin](https://orkin\\.com/plans) as of June 2026.');
    expect(r.text).toBe('Per Orkin as of June 2026.');
    expect(r.unlinked).toHaveLength(1);
    // The leftover scan (competitorLinkUrls) must catch a surviving
    // escaped destination the same way, or the publisher's post-unlink
    // survivor check would miss it.
    expect(competitorLinkUrls('raw https://orkin\\.com/x')).toEqual(['https://orkin\\.com/x']);
  });

  test('a bare protocol-relative URL in prose is reduced to the plain domain (Codex r1 P2)', () => {
    expect(un('See //orkin.com/plans for details.').text).toBe('See orkin.com for details.');
    expect(un('a path like //not-a-host is untouched').text).toBe('a path like //not-a-host is untouched');
  });

  test('MDX string-expression link props ({"…"} / {\'…\'}) are recognized structurally (Codex r1 P2)', () => {
    const r = un('<a href={"https://www.orkin.com/x"}>Orkin</a> and <InlineCTA ctaHref={\'https://orkin.com/y\'} ctaLabel="Compare plans" />');
    expect(r.text).toBe('Orkin and Compare plans');
    expect(r.unlinked.map((u) => u.url)).toEqual(['https://www.orkin.com/x', 'https://orkin.com/y']);
  });

  test('a duplicate reference label resolves to its FIRST definition, per CommonMark (Codex r1 P2)', () => {
    // The rendered link legitimately targets EPA (the first definition) —
    // the later competitor redefinition must not steal resolution, though
    // its own raw URL is still stripped so it never survives as text.
    const text = '[study][src] backs this up.\n\n[src]: https://edis.ifas.ufl.edu/study\n[src]: https://www.orkin.com/study\n';
    const r = un(text);
    expect(r.text).toContain('[study][src] backs this up.');
    expect(r.text).toContain('[src]: https://edis.ifas.ufl.edu/study');
    expect(r.text).not.toMatch(/orkin\.com/);
    expect(competitorLinkUrls(r.text)).toEqual([]);

    // The reverse: an earlier competitor definition stays authoritative —
    // a later non-competitor "override" never resolves the reference.
    const reversed = '[study][src] backs this up.\n\n[src]: https://www.orkin.com/study\n[src]: https://edis.ifas.ufl.edu/study\n';
    const r2 = un(reversed);
    expect(r2.text).toContain('backs this up.');
    expect(r2.text).not.toMatch(/\[study\]\[src\]/);
    expect(r2.text).not.toMatch(/orkin\.com/);
  });

  test('links to non-competitor sites are untouched (UF/IFAS, BBB, EPA, ConsumerAffairs, archives, our own pages)', () => {
    const text = [
      'Per [UF/IFAS](https://edis.ifas.ufl.edu/IG098) and [BBB](https://www.bbb.org/us/fl/x).',
      'See <a href="https://www.epa.gov/pesticides">EPA</a>, https://www.consumeraffairs.com/x and',
      '[an archived copy](https://web.archive.org/web/2026/https://www.orkin.com/terms/).',
      'Our [termite page](/termite/termite-bond/) and [calculator](https://www.wavespestcontrol.com/pest-control-calculator/).',
      '[ifas]: https://edis.ifas.ufl.edu/x',
    ].join('\n');
    const r = un(text);
    expect(r.text).toBe(text);
    expect(r.unlinked).toEqual([]);
  });

  test('frontmatter strings are unlinked at any depth; other values untouched', () => {
    const { value, unlinked } = unlinkCompetitorLinksDeep({
      title: 'Orkin vs Waves',
      meta_description: 'Compare with https://www.orkin.com plans.',
      hero_image: { src: '/img/x.webp', alt: 'A [Terminix](https://terminix.com) truck' },
      tags: ['orkin', 'https://www.trugreen.com/x'],
      reading_time_min: 6,
    });
    expect(value).toEqual({
      title: 'Orkin vs Waves',
      meta_description: 'Compare with orkin.com plans.',
      hero_image: { src: '/img/x.webp', alt: 'A Terminix truck' },
      tags: ['orkin', 'trugreen.com'],
      reading_time_min: 6,
    });
    expect(unlinked).toHaveLength(3);
  });
});

describe('publisher commit helper', () => {
  const { competitorFreeMarkdown, withCompetitorUnlinkNote } = require('../services/content-astro/astro-publisher')._internals;
  test('the PR note is bounded: one line per distinct URL, at most 25, then a count (Codex r4)', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ url: `https://www.orkin.com/p${i % 40}`, text: `page ${i}` }));
    const note = withCompetitorUnlinkNote('Body', many);
    expect((note.match(/^- `/gm) || [])).toHaveLength(25);
    expect(note).toContain('…and 15 more');
    expect(withCompetitorUnlinkNote('Body', [{ url: `https://www.orkin.com/${'x'.repeat(500)}`, text: 'y'.repeat(500) }]).length).toBeLessThan(600);
  });
  test('re-validates frontmatter the unlinking changed (pre-push audit), and refuses a surviving competitor URL', () => {
    const validate = jest.fn(() => { throw new Error('meta_description too short'); });
    expect(() => competitorFreeMarkdown({ meta_description: 'Plans at https://www.orkin.com/plans compared.' }, 'Body.', { validate }))
      .toThrow('meta_description too short');
    // Untouched frontmatter is not re-validated (the lane already did).
    const untouched = jest.fn();
    const r = competitorFreeMarkdown({ title: 'Ants' }, 'Per [Orkin](https://www.orkin.com/x).', { validate: untouched });
    expect(untouched).not.toHaveBeenCalled();
    expect(r.markdown).toContain('Per Orkin.');
    expect(r.unlinked).toHaveLength(1);
  });
});

describe('guardrail: COMPETITOR_LINK (P1)', () => {
  const guardrails = require('../services/content/content-guardrails');
  test('blocks a competitor link that somehow remains; nothing else changes', () => {
    const r = guardrails.evaluate({ body: 'Per [Orkin terms](https://www.orkin.com/terms) as of June 2026.' }, { operatorCitations: true });
    expect(r.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COMPETITOR_LINK', severity: 'P1' })]));
    expect(r.pass).toBe(false);
    const clean = guardrails.evaluate({ body: 'Per Orkin terms as of June 2026. See [UF/IFAS](https://edis.ifas.ufl.edu/x).' }, { operatorCitations: true });
    expect(clean.findings.some((f) => f.code === 'COMPETITOR_LINK')).toBe(false);
  });

  test('a competitor URL in any frontmatter field is flagged in-loop, next_steps included (Codex r4)', () => {
    const r = guardrails.evaluate({ body: 'Plain body about ants.', frontmatter: { next_steps: [{ label: 'See plans', href: 'https://orkin.com/plans' }] } }, { operatorCitations: true });
    expect(r.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COMPETITOR_LINK', severity: 'P1' })]));
  });
});
