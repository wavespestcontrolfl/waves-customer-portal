// Pest Insider renderer: reviewed copy only, escaping, absolute links, dark-mode hooks.
const {
  renderIssue, withToolBlock, wrapIssueHtml, speciesEmoji, POST_LINK_TEXT, VERDICTS, SIGNOFF_TEXT, CATEGORY_EMOJI, SPECIES_EMOJI,
} = require('../services/pest-insider/render');
const { SPECIES } = require('../services/pest-insider/plan');
const { cardFor } = require('../services/pest-insider/cards');
const { POSTS, POST_URLS, postUrl } = require('../services/pest-insider/posts');
const { heroFor } = require('../services/pest-insider/heroes');
const { factById } = require('../services/pest-insider/facts');
const { toolById, toolLinkText, AMAZON_DISCLOSURE } = require('../services/pest-insider/tools');
const { bodyIsDarkAware } = require('../services/email-template');
const { validateNewsletterDraft } = require('../services/newsletter-validator');

// A reviewed post URL (posts.js): the only kind of blog link the body carries.
const [POST] = [...POST_URLS];
const BASE = {
  subject: '🦟 Mosquito eggs wait 8 months dry',
  preview: 'Dry does not mean gone.',
  lead: { headline: 'Dry eggs, wet future', sentences: [{ text: 'The CDC says eggs survive 8 months.' }, { text: 'They stick to container walls.' }], postUrl: POST },
  idItem: { text: 'It raises a generation in about a week.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
};
const DIVIDER = 'https://d2riygw2ap9mi.cloudfront.net/social-media/waves-divider-2026-v2.gif';
const imgSrcs = (html) => [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
// A lead for a real fact: its own post and its reviewed lines.
const leadFor = (factId) => ({ ...BASE.lead, postUrl: postUrl(factId), factId });
// The same, under the fact's own title as the headline, as buildIssue sends it.
const titledLead = (factId) => ({ ...leadFor(factId), headline: factById(factId).title });

describe('renderIssue', () => {
  test('lead and identifier blocks render with absolute site links', () => {
    const r = renderIssue(BASE);
    expect(r.subject).toBe(BASE.subject);
    expect(r.preview).toBe(BASE.preview);
    expect(r.html_body).toContain('Today I learned');
    expect(r.html_body).toContain('Dry eggs, wet future');
    // each reviewed sentence prints whole: only a whole sentence is styled
    expect(r.html_body).toContain('>The CDC says eggs survive 8 months.</p>');
    expect(r.html_body).toContain('>They stick to container walls.</p>');
    expect(r.html_body).toContain('href="https://www.wavespestcontrol.com/pest-identifier/aedes-mosquito/"');
    expect(r.html_body).toContain('href="https://www.wavespestcontrol.com/pest-identifier/"');
    expect(r.text_body).toContain('https://www.wavespestcontrol.com/pest-identifier/aedes-mosquito/');
    // the lead links its reviewed post, after the lead sentences
    expect(r.html_body).toContain(`>${POST_LINK_TEXT}</a>`);
    expect(r.text_body).toContain(`container walls.\n\n${POST_LINK_TEXT}: ${POST}\n`);
    // A forwarded copy would carry the subscriber's own unsubscribe link (pre-push round 11).
    for (const part of [r.html_body, r.text_body]) expect(part).not.toMatch(/forward/i);
    // Links: the post (its text link) and the identifier pages, nothing else.
    const hrefs = [...r.html_body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.filter((h) => h === POST)).toHaveLength(1);
    hrefs.filter((h) => h !== POST).forEach((h) => expect(h).toMatch(/^https:\/\/www\.wavespestcontrol\.com\/pest-identifier\//));
    // Pictures: with no lead fact, only the Waves badge (no top picture, no card).
    expect(imgSrcs(r.html_body)).toEqual([DIVIDER]);
    // With the lead fact: its top picture, linked to the post too, then its card.
    const t03 = renderIssue({ ...BASE, lead: titledLead('T03') });
    expect(imgSrcs(t03.html_body)).toEqual([heroFor('T03').url, cardFor('T03').url, DIVIDER]);
    expect([...t03.html_body.matchAll(/href="([^"]+)"/g)].filter((m) => m[1] === postUrl('T03'))).toHaveLength(2);
  });

  test("the top picture is the lead fact's own: its title as alt text, linked to the post, before the greeting, and every Outlook shows it", () => {
    const hero = heroFor('T03');
    const r = renderIssue({ ...BASE, lead: titledLead('T03') });
    expect(hero.url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/pest-insider\/heroes\/t03-[0-9a-f]{10}\.jpg$/);
    expect(r.html_body).toContain(`<a href="${postUrl('T03')}" style="text-decoration:none;"><img src="${hero.url}" alt="Native termites can swarm in winter" width="582" height="326" style="width:100%;max-width:582px;height:auto;border:0;border-radius:12px;display:block;" /></a>`);
    const at = r.html_body.indexOf(hero.url);
    expect(at).toBeGreaterThan(r.html_body.indexOf('Waves Pest Insider · '));
    expect(at).toBeLessThan(r.html_body.indexOf('Hey there!'));
    // outside Outlook's skip: a JPEG with its size in the tag
    expect(r.html_body.slice(r.html_body.lastIndexOf('<!--', at), at)).not.toContain('[if !mso]');
    // the blog post's own picture is not in the email, and the plain-text copy has no picture
    expect(r.html_body).not.toContain('www.wavespestcontrol.com/images/');
    expect(r.text_body).not.toContain('/pest-insider/heroes/');
    // every fact with a reviewed post opens with its own picture
    for (const factId of Object.keys(POSTS)) expect(imgSrcs(renderIssue({ ...BASE, lead: titledLead(factId) }).html_body)[0]).toBe(heroFor(factId).url);
  });

  test("no top picture without the lead fact, or under a headline that is not the fact's title; a caller's picture never renders", () => {
    const r = renderIssue({ ...BASE, lead: { ...BASE.lead, image: 'https://www.example.com/x.png', imageUrl: 'https://www.example.com/y.png' } });
    expect(r.html_body).toBe(renderIssue(BASE).html_body);
    expect(r.html_body).not.toContain('example.com');
    const t03Title = factById('T03').title;
    for (const lead of [
      BASE.lead, // no fact
      leadFor('T03'), // the fact, under another headline
      { ...titledLead('T03'), postUrl: postUrl('A01') }, // a post that is not the fact's
      { ...BASE.lead, headline: t03Title, factId: 'Z99' }, // an unknown fact
      { ...BASE.lead, headline: t03Title, factId: '__proto__' },
    ]) {
      expect(renderIssue({ ...BASE, lead }).html_body).not.toContain('/pest-insider/heroes/');
    }
  });

  test('the dateline names the edition, the send date and the read time; a date that is not a real YYYY-MM-DD is left out', () => {
    expect(renderIssue({ ...BASE, sendDate: '2026-12-03' }).text_body.startsWith('Waves Pest Insider · Dec 3, 2026 · 1-min read\n\nHey there!\n')).toBe(true);
    expect(renderIssue({ ...BASE, sendDate: '2027-01-21' }).html_body).toContain('>Waves Pest Insider · Jan 21, 2027 · 1-min read</p>');
    for (const sendDate of [undefined, '2026-13-03', '2026-12-00', 'Dec 3', '<b>2026-12-03</b>', 20261203]) {
      const r = renderIssue({ ...BASE, sendDate });
      expect(r.text_body.startsWith('Waves Pest Insider · 1-min read\n')).toBe(true);
    }
  });

  test("the lead fact's card shows after its sentences, with its words as alt text; no card without the lead fact", () => {
    const card = cardFor('A01');
    const r = renderIssue({ ...BASE, lead: leadFor('A01') });
    expect(r.html_body).toContain(`<img src="${card.url}" alt="${card.alt}" width="582" height="300"`);
    expect(card.url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/pest-insider\/cards\/a01-[0-9a-f]{10}\.png$/);
    // after the lead sentences, before the fact box
    const at = r.html_body.indexOf(card.url);
    expect(at).toBeGreaterThan(r.html_body.indexOf('>They stick to container walls.</p>'));
    expect(at).toBeLessThan(r.html_body.indexOf(POST_LINK_TEXT));
    // outside Outlook's skip: a PNG every Outlook shows
    expect(r.html_body.slice(r.html_body.lastIndexOf('<!--', at), at)).not.toContain('[if !mso]');
    // the plain-text copy already has the fact's sentences
    expect(r.text_body).not.toContain(card.url);
    // no fact id, a fact whose post is not the lead's, or an unknown id: no card
    for (const lead of [BASE.lead, { ...leadFor('A01'), postUrl: postUrl('T03') }, { ...BASE.lead, factId: 'Z99' }]) {
      expect(renderIssue({ ...BASE, lead }).html_body).not.toContain('/pest-insider/cards/');
    }
  });

  test('every mention of the Waves newsletter, blog, website or app says Waves (owner 2026-11-19)', () => {
    const species = { slug: 'pillbug', name: 'Pillbug', category: 'Occasional invaders', scientific: 'Armadillidium vulgare', verdict: 'watch' };
    const r = withToolBlock(renderIssue({ ...BASE, sendDate: '2026-12-03', lead: leadFor('A01'), idItem: { ...BASE.idItem, species } }), toolById('acurite-glass-rain-gauge'));
    const words = (text) => text.replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/&#39;/g, "'");
    for (const part of [r.html_body, r.text_body]) {
      const text = words(part);
      expect(text).not.toMatch(/\b(our|the|this) (blog|website|site|newsletter|app)\b/i);
      const mentions = [...text.matchAll(/(\S+)\s+(?:Pest Insider|blog|website|site|newsletter|app)\b/gi)].map((m) => m[1]);
      expect(mentions.length).toBeGreaterThan(0);
      mentions.forEach((before) => expect(before).toBe('Waves'));
    }
    expect(POST_LINK_TEXT).toBe('Read the full story on the Waves blog');
    expect(r.text_body).toContain('Pillbug page on the Waves website: https://www.wavespestcontrol.com/pest-identifier/pillbug/');
  });

  test("the fact box names the lead fact's sources, by the names its sentences use, only for the fact whose post the lead links", () => {
    // T03 (termite): its two quotes are UF/IFAS EDIS publications; its band carries the termite emoji
    const t03 = renderIssue({ ...BASE, lead: leadFor('T03') });
    expect(t03.html_body).toContain('📚 <em>Source: UF/IFAS</em>');
    expect(t03.text_body).toContain(`${POST_LINK_TEXT}: ${postUrl('T03')}\nSource: UF/IFAS\n`);
    expect(t03.html_body).toContain('>🪵</span> <strong><em>Dry eggs, wet future</em></strong>');
    expect(renderIssue({ ...BASE, lead: leadFor('D02') }).text_body).toContain('Sources: CDC and UF/IFAS');
    expect(renderIssue({ ...BASE, lead: leadFor('O02') }).text_body).toContain('Sources: UF/IFAS, WUSF and City of North Port');
    // a fact id that is not the post's fact, or no fact: no source line, the default emoji
    for (const factId of ['T03', 'NOPE', '__proto__', undefined]) {
      const r = renderIssue({ ...BASE, lead: { ...BASE.lead, postUrl: postUrl('A01'), factId: factId === 'T03' ? 'T03' : factId } });
      expect(r.text_body).not.toMatch(/Sources?:/);
      expect(r.html_body).toContain('>💡</span> <strong><em>Dry eggs, wet future</em></strong>');
    }
  });

  test('the species card shows its emoji tile, the latin name and the verdict chip from the entry', () => {
    const species = { slug: 'pillbug', name: 'Pillbug', category: 'Occasional invaders', scientific: 'Armadillidium vulgare', verdict: 'watch' };
    const r = renderIssue({ ...BASE, idItem: { ...BASE.idItem, species } });
    // the band shows the magnifier and the name; the tile shows the animal
    expect(r.html_body).toContain('>🔍</span> <strong><em>Pillbug</em></strong>');
    expect(r.html_body).toContain('text-align:center;font-size:36px;">🐛</div>');
    expect(r.html_body).toContain('>Armadillidium vulgare</em>');
    expect(r.html_body).toContain('>Keep an eye on it</span>');
    expect(r.text_body).toContain("WHAT'S THIS?\nPillbug (Armadillidium vulgare)\nVerdict: Keep an eye on it\n");
    for (const [verdict, { label }] of Object.entries(VERDICTS)) {
      expect(renderIssue({ ...BASE, idItem: { ...BASE.idItem, species: { ...species, verdict } } }).text_body).toContain(`Verdict: ${label}\n`);
    }
    // no verdict the website knows, no category: no chip, the default emoji
    const bare = renderIssue({ ...BASE, idItem: { ...BASE.idItem, species: { ...species, slug: 'x', verdict: 'toString', category: 'constructor' } } });
    expect(bare.text_body).not.toContain('Verdict:');
    expect(bare.html_body).toContain('text-align:center;font-size:36px;">🔍</div>');
  });

  test('a harmless species gets no chip and no verdict line: any label for it is a safety claim the send check refuses', () => {
    expect(Object.keys(VERDICTS).sort()).toEqual(['ally', 'call', 'watch']);
    const species = { slug: 'pillbug', name: 'Pillbug', category: 'Occasional invaders', scientific: 'Armadillidium vulgare', verdict: 'harmless' };
    const r = renderIssue({ ...BASE, idItem: { ...BASE.idItem, species } });
    expect(r.text_body).toContain("WHAT'S THIS?\nPillbug (Armadillidium vulgare)\nIt raises");
    expect(r.html_body).not.toContain('dm-chip-lite');
    for (const part of [r.html_body, r.text_body]) expect(part).not.toMatch(/harmless|nuisance|verdict/i);
  });

  test("each species' tile emoji is its own or its category's, never another animal's", () => {
    const slugs = new Set(SPECIES.map((s) => s.slug));
    const categories = new Set(SPECIES.map((s) => s.category));
    Object.keys(SPECIES_EMOJI).forEach((slug) => expect(slugs).toContain(slug));
    Object.keys(CATEGORY_EMOJI).forEach((category) => expect(categories).toContain(category));
    const bySlug = Object.fromEntries(SPECIES.map((s) => [s.slug, speciesEmoji(s)]));
    expect(bySlug).toMatchObject({
      'ghost-ant': '🐜', 'brown-widow': '🕷️', 'house-mouse': '🐁', 'roof-rat': '🐀', lovebug: '🪰', 'aedes-mosquito': '🦟',
      'brown-anole': '🦎', 'cuban-treefrog': '🐸', 'gopher-tortoise': '🐢', armadillo: '🔍', 'bed-bug': '🔍', 'cat-flea': '🔍', 'brown-dog-tick': '🔍',
    });
    // the two categories with no one fitting emoji
    for (const s of SPECIES.filter((x) => ['Biting', 'Wildlife neighbors'].includes(x.category) && !SPECIES_EMOJI[x.slug])) expect(bySlug[s.slug]).toBe('🔍');
    expect(speciesEmoji({ slug: '__proto__', category: 'toString' })).toBe('🔍');
  });

  test('the lead link must be a reviewed post URL: any other link is refused, and so is none', () => {
    for (const postUrl of [
      'https://www.example.com/post/',
      `${POST}?email=resident@example.com`,
      POST.replace('https://www.', 'https://'),
      `${POST}{{unsubscribe_url}}`,
      undefined,
    ]) {
      expect(() => renderIssue({ ...BASE, lead: { ...BASE.lead, postUrl } })).toThrow(/reviewed post URL/);
    }
  });

  test('the shared body never has "A tool we\'d use": the archive serves it to anyone (pre-push PR 3 r1)', () => {
    const shared = renderIssue(BASE);
    expect(renderIssue({ ...BASE, toolId: 'acurite-glass-rain-gauge' })).toEqual(shared);
    for (const part of [shared.html_body, shared.text_body]) expect(part).not.toMatch(/amazon/i);
  });

  test('withToolBlock adds the tool after "What\'s this?" and before the sign-off, with Amazon\'s sentence right after the link', () => {
    const gauge = toolById('acurite-glass-rain-gauge');
    const shared = renderIssue(BASE);
    const r = withToolBlock(shared, gauge);
    expect(r.subject).toBe(shared.subject);
    expect(r.preview).toBe(shared.preview);
    // the shared copy, unchanged, then the badge and the tool block, then the sign-off
    const signoffHtml = shared.html_body.slice(shared.html_body.lastIndexOf('<div class="dm-text">'));
    expect(signoffHtml).toContain('Catch you next time.');
    const sharedSections = shared.html_body.slice(0, shared.html_body.length - signoffHtml.length);
    expect(r.html_body.startsWith(`${sharedSections}<div style="text-align:center;margin:28px 0;"><img src="${DIVIDER}"`)).toBe(true);
    expect(r.html_body.endsWith(`\n${signoffHtml}`)).toBe(true);
    const html = r.html_body.slice(sharedSections.length, r.html_body.length - signoffHtml.length);
    expect(html).toContain('A tool we&#39;d use');
    expect(html).toContain(`<strong><em>${gauge.name}</em></strong>`);
    expect(html).toContain(`href="${gauge.url}"`);
    const linkAt = html.indexOf(`>${toolLinkText(gauge)}</a>`);
    const sentenceAt = html.indexOf(AMAZON_DISCLOSURE);
    expect(linkAt).toBeGreaterThan(html.indexOf(gauge.lines[1]));
    expect(sentenceAt).toBeGreaterThan(linkAt);
    // in normal body text, not the muted small print
    expect(html.slice(html.lastIndexOf('<p', sentenceAt), sentenceAt)).not.toMatch(/dm-muted/);
    const sharedText = shared.text_body.slice(0, shared.text_body.length - SIGNOFF_TEXT.length);
    expect(shared.text_body.endsWith(`\n\n${SIGNOFF_TEXT}`)).toBe(true);
    expect(r.text_body)
      .toBe(`${sharedText}A TOOL WE'D USE\n${gauge.lines.join(' ')}\n\n${toolLinkText(gauge)}: ${gauge.url}\n${AMAZON_DISCLOSURE}\n\n${SIGNOFF_TEXT}`);
  });

  test('withToolBlock puts the tool at the end of a body with no sign-off', () => {
    const gauge = toolById('acurite-glass-rain-gauge');
    const r = withToolBlock({ subject: 's', preview: 'p', html_body: '<div class="dm-text">\nold\n</div>', text_body: 'old\n' }, gauge);
    expect(r.html_body.startsWith('<div class="dm-text">\nold\n</div>\n<div style="text-align:center;')).toBe(true);
    expect(r.html_body.endsWith('</div>\n</div>')).toBe(true);
    expect(r.text_body).toBe(`old\n\nA TOOL WE'D USE\n${gauge.lines.join(' ')}\n\n${toolLinkText(gauge)}: ${gauge.url}\n${AMAZON_DISCLOSURE}\n`);
  });

  test('withToolBlock leaves the shared copy for a tool not usable now, or whose link is not the checked one (pre-push PR 3 r3, r4)', () => {
    const gauge = toolById('acurite-glass-rain-gauge');
    const shared = renderIssue(BASE);
    for (const picked of [
      { productId: 'ks-adjustable-door-sweep', url: gauge.url },
      { productId: 'no-such-tool', url: gauge.url },
      { productId: gauge.productId, url: 'https://www.amazon.com/dp/B000000001?tag=wavespestcont-20' },
      { productId: gauge.productId },
      gauge.productId, null, 7,
    ]) {
      expect(withToolBlock(shared, picked)).toBe(shared);
    }
  });

  test('the shared body takes no caller text or link (pre-push rounds 5 to 10)', () => {
    // One email for every subscriber, and the archive serves it as stored: a
    // caller's area line, tool, blog link or household details never render.
    const withCallerInput = renderIssue({
      ...BASE,
      blogUrl: 'https://www.wavespestcontrol.com/blog/x/?email=resident@example.com',
      areaLine: 'Side gate #1234, ask for mary johnson.',
      tool: { name: 'Termidor', why: 'x', url: 'https://www.example.com/tool?u={{unsubscribe_url}}' },
      home: { lastVisit: { date: '2026-11-04', areas: ['lanai'] } },
      greeting: 'Hey Mary',
      sources: ['Side gate #1234'],
    });
    const plain = renderIssue(BASE);
    expect(withCallerInput.html_body).toBe(plain.html_body);
    expect(withCallerInput.text_body).toBe(plain.text_body);
  });

  test('all text is escaped', () => {
    const hostile = '<script>alert("x")</script> & <img src=x onerror=1>';
    const r = renderIssue({
      ...BASE,
      sendDate: hostile,
      lead: { headline: hostile, sentences: [{ text: hostile }, { text: 'ok' }], postUrl: POST, factId: hostile },
      idItem: { text: hostile, species: { slug: 'aedes-mosquito', name: hostile, scientific: hostile, verdict: hostile, category: hostile } },
    });
    expect(r.html_body).not.toContain('<script');
    expect(r.html_body).not.toContain('<img src=x');
    expect(r.html_body).toContain('&lt;script&gt;');
    expect(r.html_body).toContain('&amp;');
  });

  test('a species slug that is not a plain slug gets no page link', () => {
    const r = renderIssue({ ...BASE, idItem: { ...BASE.idItem, species: { slug: '../admin', name: 'X' } } });
    expect(r.html_body).not.toContain('/admin');
    expect(r.html_body).toContain('href="https://www.wavespestcontrol.com/pest-identifier/"');
  });

  test('the body is dark-mode aware like the other newsletter bodies', () => {
    expect(bodyIsDarkAware(renderIssue(BASE).html_body)).toBe(true);
  });

  test('the fixed lines pass the send check for this email type', () => {
    // Greeting, intro, labels, verdict chips and sign-off: no claim the send check refuses.
    for (const verdict of [...Object.keys(VERDICTS), 'harmless']) {
      const r = renderIssue({
        ...BASE,
        sendDate: '2026-12-03',
        lead: { ...leadFor('T03'), headline: 'Native termites can swarm in winter', sentences: [{ text: 'They swarm.' }] },
        idItem: { text: 'It is small.', species: { slug: 'pillbug', name: 'Pillbug', category: 'Occasional invaders', scientific: 'Armadillidium vulgare', verdict } },
      });
      const { errors } = validateNewsletterDraft({
        subject: r.subject, preview_text: r.preview, html_body: r.html_body, text_body: r.text_body, newsletter_type: 'pest-insider-monthly',
      });
      expect(errors).toEqual([]);
    }
  });
});

describe('wrapIssueHtml', () => {
  test('the full page escapes the preview, which wrapNewsletter places raw', () => {
    const issue = renderIssue({ ...BASE, preview: 'Look <script>alert(1)</script> & "see"' });
    const html = wrapIssueHtml(issue, { unsubscribeUrl: '{{unsubscribe_url}}' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('Look &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;see&quot;');
    expect(html).toContain(issue.html_body);
    expect(html).toContain('{{unsubscribe_url}}');
  });
});
