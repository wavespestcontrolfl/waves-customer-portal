// Pest Insider renderer: reviewed copy only, escaping, absolute links, dark-mode hooks.
const {
  renderIssue, withToolBlock, addReaderBlock, wrapIssueHtml, speciesEmoji, escapeHtml, POST_LINK_TEXT, VERDICTS, SIGNOFF_TEXT, CATEGORY_EMOJI, SPECIES_EMOJI,
  homeBlock, homeBlockErrors, homeSubstitutions, HOME_LINE_LABELS, HOME_TOKEN, HOME_TEXT_TOKEN,
  CLOSING_TEXT,
} = require('../services/pest-insider/render');
const {
  REFERRAL_URL, REFERRAL_TAIL, REFERRAL_TOKEN, REFERRAL_TEXT_TOKEN, NO_LINE,
  fillReferralLine, neutralizeIssueTokens, referralTail, referralLine,
} = require('../services/pest-insider/referral-line');
const { neutralizeHomeTokens, hasHomeToken } = require('../services/pest-insider/home');
const { SPECIES } = require('../services/pest-insider/plan');
const { cardFor } = require('../services/pest-insider/cards');
const { POSTS, POST_URLS, postUrl } = require('../services/pest-insider/posts');
const { heroFor } = require('../services/pest-insider/heroes');
const { partPictureForFact } = require('../services/pest-insider/parts');
const { factById } = require('../services/pest-insider/facts');
const { toolById, toolLinkText, AMAZON_DISCLOSURE } = require('../services/pest-insider/tools');
const { bodyIsDarkAware } = require('../services/email-template');
const { validateNewsletterDraft } = require('../services/newsletter-validator');
const { PEST_INSIDER_POLL_IDS, NEWSLETTER_POLL_IDS, neutralizeQuizTokens } = require('../services/newsletter-quiz');

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
// What closes every stored issue: the referral line's token, then the sign-off.
const closingHtmlOf = (html) => html.slice(html.lastIndexOf(REFERRAL_TOKEN));
// The words a reader sees in a piece of HTML.
const wordsOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
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
    // With the lead fact: its top picture, linked to the post too, then its
    // card; a picture that moves comes as its still (for Outlook) and its GIF.
    // A fact that names a part then shows its part picture (parts.js).
    for (const id of Object.keys(POSTS)) {
      const [hero, card] = [heroFor(id), cardFor(id)];
      const issue = renderIssue({ ...BASE, lead: titledLead(id) });
      expect([id, imgSrcs(issue.html_body)]).toEqual([id, [hero.url, hero.gifUrl, card.url, card.gifUrl, partPictureForFact(id)?.url, DIVIDER].filter(Boolean)]);
      expect([id, [...issue.html_body.matchAll(/href="([^"]+)"/g)].filter((m) => m[1] === postUrl(id)).length]).toEqual([id, 2]);
    }
  });

  test("the top picture is the lead fact's own: its title as alt text, linked to the post, before the greeting, and every Outlook shows it", () => {
    // A top picture whose art does not move (which facts move is data): one
    // JPEG with its size in the tag, in no Outlook comment
    const stillId = Object.keys(POSTS).find((id) => !heroFor(id).gifUrl);
    expect(stillId).toBeDefined();
    const still = heroFor(stillId);
    const plain = renderIssue({ ...BASE, lead: titledLead(stillId) });
    expect(plain.html_body).toContain(`<a href="${postUrl(stillId)}" style="text-decoration:none;"><img src="${still.url}" alt="${escapeHtml(still.alt)}" width="582" height="326" style="width:100%;max-width:582px;height:auto;border:0;border-radius:12px;display:block;" /></a>`);
    expect(plain.html_body.slice(0, plain.html_body.indexOf(still.url))).not.toContain('<!--');
    const hero = heroFor('T03');
    const r = renderIssue({ ...BASE, lead: titledLead('T03') });
    expect(hero.url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/pest-insider\/heroes\/t03-[0-9a-f]{10}\.jpg$/);
    expect(hero.alt).toBe('Native termites can swarm in winter');
    const at = r.html_body.indexOf(hero.url);
    expect(at).toBeGreaterThan(r.html_body.indexOf('Waves Pest Insider · '));
    // the whole top picture, a moving one's GIF too, comes before the greeting
    expect(r.html_body.lastIndexOf('/pest-insider/heroes/')).toBeLessThan(r.html_body.indexOf('Hey there!'));
    // the blog post's own picture is not in the email, and the plain-text copy has no picture
    expect(r.html_body).not.toContain('www.wavespestcontrol.com/images/');
    expect(r.text_body).not.toContain('/pest-insider/heroes/');
    // every fact with a reviewed post opens with its own picture
    for (const factId of Object.keys(POSTS)) expect(imgSrcs(renderIssue({ ...BASE, lead: titledLead(factId) }).html_body)[0]).toBe(heroFor(factId).url);
  });

  test('a picture that moves comes with its still: classic Outlook and a reader who asked for less motion get the still, every other mail app the GIF, and the still comes first for the Waves website feed', () => {
    const img = (src, alt, height) => `<img src="${src}" alt="${escapeHtml(alt)}" width="582" height="${height}" style="width:100%;max-width:582px;height:auto;border:0;border-radius:12px;display:block;" />`;
    // A moving picture: the still for classic Outlook, then the GIF in a
    // <picture> whose <source> is the still, for a reader who asked for less
    // motion. A picture that does not move is one plain tag.
    const markup = (p, height) => (p.gifUrl
      ? `<!--[if mso]>${img(p.url, p.alt, height)}<![endif]--><!--[if !mso]><!--><picture style="display:block;"><source srcset="${p.url}" media="(prefers-reduced-motion: reduce)" />${img(p.gifUrl, p.alt, height)}</picture><!--<![endif]-->`
      : img(p.url, p.alt, height));
    // Which facts move is data (new art drops a fact's motion), so every fact is checked.
    const ids = Object.keys(POSTS);
    expect(ids.filter((id) => heroFor(id).gifUrl).length).toBeGreaterThan(0);
    expect(ids.filter((id) => cardFor(id).gifUrl).length).toBeGreaterThan(0);
    for (const id of ids) {
      const [hero, card] = [heroFor(id), cardFor(id)];
      const r = renderIssue({ ...BASE, lead: titledLead(id) });
      expect([id, r.html_body.includes(`<a href="${postUrl(id)}" style="text-decoration:none;">${markup(hero, 326)}</a>`), r.html_body.includes(markup(card, 300))]).toEqual([id, true, true]);
      // only a reduced-motion setting picks a still: one <source> per moving picture, and no other
      expect([id, [...r.html_body.matchAll(/<source [^>]*>/g)].map((m) => m[0])])
        .toEqual([id, [hero, card].filter((p) => p.gifUrl).map((p) => `<source srcset="${p.url}" media="(prefers-reduced-motion: reduce)" />`)]);
      // a mail app that reads no Outlook comment shows the GIFs
      expect([id, imgSrcs(r.html_body.replace(/<!--[\s\S]*?-->/g, ''))]).toEqual([id, [hero.gifUrl || hero.url, card.gifUrl || card.url, partPictureForFact(id)?.url, DIVIDER].filter(Boolean)]);
      // classic Outlook shows what [if mso] holds and skips what [if !mso] holds: the stills
      const outlook = r.html_body.replace(/<!--\[if mso\]>([\s\S]*?)<!\[endif\]-->/g, '$1').replace(/<!--\[if !mso\]><!-->[\s\S]*?<!--<!\[endif\]-->/g, '');
      expect([id, imgSrcs(outlook)]).toEqual([id, [hero.url, card.url, partPictureForFact(id)?.url, DIVIDER].filter(Boolean)]);
    }
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
    expect(renderIssue({ ...BASE, sendDate: '2028-02-29' }).text_body.startsWith('Waves Pest Insider · Feb 29, 2028 · 1-min read\n')).toBe(true);
    for (const sendDate of [undefined, '2026-13-03', '2026-12-00', '2027-02-30', '2026-04-31', '2027-02-29', 'Dec 3', '<b>2026-12-03</b>', 20261203]) {
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
    const signoffHtml = closingHtmlOf(shared.html_body);
    expect(signoffHtml.startsWith(`${REFERRAL_TOKEN}<div class="dm-text">`)).toBe(true);
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
    const sharedText = shared.text_body.slice(0, shared.text_body.length - CLOSING_TEXT.length);
    // The "Your home" token stands right before the sign-off; the tool block goes between them.
    expect(shared.text_body.endsWith(`\n\n${HOME_TEXT_TOKEN}${CLOSING_TEXT}`)).toBe(true);
    expect(r.text_body)
      .toBe(`${sharedText}A TOOL WE'D USE\n${gauge.lines.join(' ')}\n\n${toolLinkText(gauge)}: ${gauge.url}\n${AMAZON_DISCLOSURE}\n\n${CLOSING_TEXT}`);
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
      poll: PEST_INSIDER_POLL_IDS[0],
      pollQuizId: '{{unsubscribe_url}}',
    });
    const plain = renderIssue(BASE);
    expect(withCallerInput.html_body).toBe(plain.html_body);
    expect(withCallerInput.text_body).toBe(plain.text_body);
  });

  test('a Waves Pest Insider poll goes after "What\'s this?", once in each part, and a reader\'s tool block after it', () => {
    const poll = PEST_INSIDER_POLL_IDS[1];
    const r = renderIssue({ ...BASE, pollQuizId: poll });
    const html = r.html_body;
    expect(html.split(`{{quiz:${poll}}}`)).toHaveLength(2);
    expect(html.indexOf(`{{quiz:${poll}}}`)).toBeGreaterThan(html.indexOf('Aedes Mosquito'));
    expect(html.indexOf(`{{quiz:${poll}}}`)).toBeLessThan(html.indexOf('Catch you next time.'));
    expect(html).toContain('<strong><em>Quick poll</em></strong>');
    // The band stands alone: no small label over it, as in the Waves Newsletter.
    expect(html).toContain('<div class="dm-text">\n<h2 class="dm-chip"');
    expect(renderIssue(BASE).html_body).not.toContain('<div class="dm-text">\n<h2 class="dm-chip"');
    expect(r.text_body).toContain(`\n\nQUICK POLL\n{{quiz-text:${poll}}}\n\n${HOME_TEXT_TOKEN}${CLOSING_TEXT}`);
    // The tool is added per reader before the sign-off, so after the poll.
    const withTool = withToolBlock(r, toolById('acurite-glass-rain-gauge'));
    expect(withTool.html_body.indexOf('A tool we&#39;d use')).toBeGreaterThan(withTool.html_body.indexOf(`{{quiz:${poll}}}`));
    // The archive and the FYI copy show the question and answers with no vote link.
    const archive = neutralizeQuizTokens(html);
    expect(archive).toContain('Lizards on the lanai: friend or foe?');
    expect(archive).toContain('What lizards?');
    expect(archive).not.toMatch(/\/api\/public\/newsletter\/quiz|\{\{quiz/);
    // Any other id adds nothing: the same body as no poll.
    for (const other of [NEWSLETTER_POLL_IDS[0], 'pest-pressure-v1', 'pi-poll-unknown-v1', null, 7]) {
      expect(renderIssue({ ...BASE, pollQuizId: other })).toEqual(renderIssue(BASE));
    }
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

describe('"Your home": the tokens in the shared body and the per-reader block', () => {
  const NOW = new Date('2026-11-21T15:00:00Z');
  const HOME = { lastVisit: { date: '2026-11-10', line: 'pest' }, sinceDate: '2024-03-05' };
  const POLL = PEST_INSIDER_POLL_IDS[0];
  const signoffHtmlOf = closingHtmlOf;

  test('both tokens stand alone right before the sign-off, after "What\'s this?" and the poll, in both parts', () => {
    for (const pollQuizId of [null, POLL]) {
      const r = renderIssue({ ...BASE, pollQuizId });
      const signoffHtml = signoffHtmlOf(r.html_body);
      // The HTML token is a line of its own glued to the sign-off: no divider, heading or wrapper around it.
      expect(r.html_body.endsWith(`\n${HOME_TOKEN}${signoffHtml}`)).toBe(true);
      expect(r.html_body.split(HOME_TOKEN)).toHaveLength(2);
      expect(r.html_body.indexOf(HOME_TOKEN)).toBeGreaterThan(r.html_body.indexOf('Aedes Mosquito'));
      if (pollQuizId) expect(r.html_body.indexOf(HOME_TOKEN)).toBeGreaterThan(r.html_body.indexOf(`{{quiz:${pollQuizId}}}`));
      expect(r.text_body.endsWith(`\n\n${HOME_TEXT_TOKEN}${CLOSING_TEXT}`)).toBe(true);
      expect(r.text_body.split(HOME_TEXT_TOKEN)).toHaveLength(2);
      expect(r.text_body.indexOf(HOME_TEXT_TOKEN)).toBeGreaterThan(r.text_body.indexOf('WHAT\'S THIS?'));
      if (pollQuizId) expect(r.text_body.indexOf(HOME_TEXT_TOKEN)).toBeGreaterThan(r.text_body.indexOf(`{{quiz-text:${pollQuizId}}}`));
      expect(hasHomeToken(r.html_body)).toBe(true);
      expect(hasHomeToken(r.text_body)).toBe(true);
    }
  });

  test('with an empty value the body is the issue without the block: no empty band, no extra blank line', () => {
    for (const pollQuizId of [null, POLL]) {
      const r = renderIssue({ ...BASE, pollQuizId });
      const html = neutralizeHomeTokens(r.html_body);
      const text = neutralizeHomeTokens(r.text_body);
      // The issue as it read before the tokens: every part joined by one newline (HTML) or one blank line (text).
      expect(html).not.toContain(`\n\n${signoffHtmlOf(r.html_body)}`);
      expect(html).toContain(`</div>\n${signoffHtmlOf(r.html_body)}`);
      // The token adds no newline of its own: the blank lines the HTML already had are all it has.
      expect(html.split('\n\n')).toHaveLength(r.html_body.split('\n\n').length);
      expect(html.endsWith(signoffHtmlOf(r.html_body))).toBe(true);
      expect(text).not.toMatch(/\n\n\n/);
      expect(text.endsWith(`\n\n${CLOSING_TEXT}`)).toBe(true);
      expect(text).not.toContain('{{pi-home');
      // The substitution a reader with no block gets is exactly that.
      const empty = homeSubstitutions(null).substitutions;
      expect(r.html_body.split(HOME_TOKEN).join(empty[HOME_TOKEN])).toBe(html);
      expect(r.text_body.split(HOME_TEXT_TOKEN).join(empty[HOME_TEXT_TOKEN])).toBe(text);
    }
  });

  test('with a value, the block sits between "What\'s this?" and the sign-off, and the reader blocks still go before the sign-off', () => {
    const r = renderIssue({ ...BASE, pollQuizId: POLL });
    const subs = homeSubstitutions(HOME, { now: NOW }).substitutions;
    const filledHtml = r.html_body.split(HOME_TOKEN).join(subs[HOME_TOKEN]);
    const filledText = r.text_body.split(HOME_TEXT_TOKEN).join(subs[HOME_TEXT_TOKEN]);
    expect(filledHtml.indexOf('Your home')).toBeGreaterThan(filledHtml.indexOf(`{{quiz:${POLL}}}`));
    expect(filledHtml.indexOf('Your home')).toBeLessThan(filledHtml.indexOf('Catch you next time.'));
    expect(filledText).toContain(`{{quiz-text:${POLL}}}\n\nYOUR HOME\nLast visit: November 10 (pest control).\nWith Waves since March 2024.\n\n${CLOSING_TEXT}`);
    expect(filledHtml.split('<h2 class="dm-chip"').length - 1).toBe(4);
    // addReaderBlock / withToolBlock still put their block before the sign-off, and the body still ends with it.
    const gauge = toolById('acurite-glass-rain-gauge');
    const withTool = withToolBlock(r, gauge);
    expect(withTool.html_body.endsWith(signoffHtmlOf(r.html_body))).toBe(true);
    expect(withTool.text_body.endsWith(CLOSING_TEXT)).toBe(true);
    expect(withTool.html_body.indexOf(HOME_TOKEN)).toBeLessThan(withTool.html_body.indexOf('A tool we&#39;d use'));
    expect(withTool.html_body.indexOf('A tool we&#39;d use')).toBeLessThan(withTool.html_body.indexOf('Catch you next time.'));
    const added = addReaderBlock(r, { html: '<p>mine</p>', text: 'MINE' });
    expect(added.html_body.endsWith(signoffHtmlOf(r.html_body))).toBe(true);
    expect(added.html_body).toContain(`<p>mine</p>\n</div>\n${REFERRAL_TOKEN}<div class="dm-text">`);
    expect(added.text_body).toBe(`${r.text_body.slice(0, r.text_body.length - CLOSING_TEXT.length)}MINE\n\n${CLOSING_TEXT}`);
    // A tool block after an empty home value reads as it does today: one blank line between the sections.
    const toolText = neutralizeHomeTokens(withTool.text_body);
    expect(toolText).toContain(`${AMAZON_DISCLOSURE}\n\n${CLOSING_TEXT}`);
    expect(toolText).not.toMatch(/\n\n\n/);
  });

  test('the block prints the fixed words and the dates it formats itself', () => {
    const b = homeBlock(HOME, NOW);
    expect(b.text).toBe('YOUR HOME\nLast visit: November 10 (pest control).\nWith Waves since March 2024.\n\n');
    expect(b.html.startsWith(`<div style="text-align:center;margin:28px 0;"><img src="${DIVIDER}"`)).toBe(true);
    expect(b.html.endsWith('</div>\n')).toBe(true);
    expect(b.html).toContain('<strong><em>Your home</em></strong>');
    expect(b.html).toContain('📅 Last visit: November 10 (pest control).<br/>');
    expect(b.html).toContain('🌊 With Waves since March 2024.');
  });

  test('no visit count in any form: the records begin in August 2025, so a count would be too low for a long-time customer', () => {
    for (const home of [HOME, { ...HOME, visitCount: 1 }, { ...HOME, visitCount: 120 }, { ...HOME, visits: 7, count: 7 }]) {
      const b = homeBlock(home, NOW);
      for (const part of [b.html, b.text]) {
        expect(part).not.toMatch(/visits? so far/i);
        expect(part).not.toMatch(/\b\d+ visits?\b/i);
        expect(part).not.toMatch(/120|\b7\b/);
      }
      expect(b.text).toBe('YOUR HOME\nLast visit: November 10 (pest control).\nWith Waves since March 2024.\n\n');
    }
  });

  test('a visit from an earlier year names its year, and only then', () => {
    expect(homeBlock({ ...HOME, lastVisit: { date: '2025-12-02', line: 'pest' }, sinceDate: '2024-03-05' }, NOW).text)
      .toContain('Last visit: December 2, 2025 (pest control).\n');
    expect(homeBlock({ ...HOME, lastVisit: { date: '2025-12-02', line: null } }, NOW).html).toContain('📅 Last visit: December 2, 2025.<br/>');
    expect(homeBlock({ ...HOME, lastVisit: { date: '2026-01-02', line: 'pest' } }, NOW).text).toContain('Last visit: January 2 (pest control).');
    // The year is the Eastern year: late on New Year\'s Eve Eastern it is still the old year.
    const eve = new Date('2027-01-01T03:00:00Z');
    expect(homeBlock({ ...HOME, lastVisit: { date: '2026-12-30', line: 'pest' } }, eve).text).toContain('Last visit: December 30 (pest control).');
    expect(homeBlock({ ...HOME, lastVisit: { date: '2026-12-30', line: 'pest' } }, new Date('2027-01-01T15:00:00Z')).text).toContain('Last visit: December 30, 2026 (pest control).');
  });

  test('the since line is optional: dropped when missing, not a real day, still to come, or after the last visit', () => {
    const last = { date: '2026-11-10', line: 'pest' };
    const only = 'YOUR HOME\nLast visit: November 10 (pest control).\n\n';
    for (const sinceDate of [null, undefined, '', '2026-02-30', 'March 2024', 20240305, new Date('2024-03-05'), '2027-01-01', '2026-11-11', '2026-11-22']) {
      expect(homeBlock({ lastVisit: last, sinceDate }, NOW).text).toBe(only);
    }
    expect(homeBlock({ lastVisit: last }, NOW).text).toBe(only);
    // On the last visit's own day it still reads: the two lines do not contradict.
    expect(homeBlock({ lastVisit: last, sinceDate: '2026-11-10' }, NOW).text).toContain('With Waves since November 2026.');
  });

  test('no valid last visit means no block, never the since line alone', () => {
    for (const date of [null, undefined, '', '2026-02-30', '2026-11-22', '2027-01-01', 'x', 20261110]) {
      expect(homeBlock({ lastVisit: { date, line: 'pest' }, sinceDate: '2024-03-05' }, NOW)).toBeNull();
    }
    expect(homeBlock({ sinceDate: '2024-03-05' }, NOW)).toBeNull();
    expect(homeSubstitutions({ sinceDate: '2024-03-05' }, { now: NOW }).substitutions[HOME_TEXT_TOKEN]).toBe('');
  });

  test.each(Object.entries(HOME_LINE_LABELS))('the fixed label for %s prints and the whole block passes the send check', (line, label) => {
    const b = homeBlock({ ...HOME, lastVisit: { date: '2026-11-10', line } }, NOW);
    expect(b.text).toContain(`Last visit: November 10 (${label}).`);
    expect(b.html).toContain(`Last visit: November 10 (${label}).`);
    expect(homeBlockErrors(b)).toEqual([]);
    expect(homeSubstitutions({ ...HOME, lastVisit: { date: '2026-11-10', line } }, { now: NOW }).substitutions[HOME_TEXT_TOKEN]).toBe(b.text);
  });

  test('no label claims a result: an inspection-only visit is on the termite or rodent line too', () => {
    for (const label of Object.values(HOME_LINE_LABELS)) expect(label).not.toMatch(/protect|guarantee|eliminat|free\b/i);
    expect(HOME_LINE_LABELS.termite).toBe('termite service');
    expect(HOME_LINE_LABELS.rodent).toBe('rodent service');
  });

  test('the labels are the six service lines', () => {
    expect(Object.keys(HOME_LINE_LABELS)).toEqual(['pest', 'lawn', 'mosquito', 'termite', 'rodent', 'tree_shrub']);
    expect(Object.values(HOME_LINE_LABELS)).toEqual(['pest control', 'lawn care', 'mosquito control', 'termite service', 'rodent service', 'tree and shrub care']);
  });

  test.each([null, undefined, 'lawn and tree', 'constructor', '__proto__', 'toString', 7, {}, ['pest']])('an unknown or missing line (%p) prints no label', (line) => {
    const b = homeBlock({ ...HOME, lastVisit: { date: '2026-11-10', line } }, NOW);
    expect(b.text).toContain('Last visit: November 10.\n');
    expect(b.html).not.toContain('(');
  });

  test('a last visit in the future, or not a real day, drops the block; after today in Eastern time', () => {
    // After today in Eastern time: the late evening of the 20th is still the 20th.
    expect(homeBlock({ ...HOME, lastVisit: { date: '2026-11-22', line: 'pest' } }, NOW)).toBeNull();
    expect(homeBlock({ ...HOME, lastVisit: { date: '2026-11-21', line: 'pest' } }, NOW).text).toContain('Last visit: November 21 (pest control).');
    expect(homeBlock({ ...HOME, lastVisit: { date: '2026-11-21', line: 'pest' } }, new Date('2026-11-21T03:00:00Z'))).toBeNull();
    for (const home of [null, undefined, {}, { lastVisit: null }, 'home', 7]) expect(homeBlock(home, NOW)).toBeNull();
    for (const date of ['2026-02-30', '2026-13-01', '2026-11-1', 'tomorrow', '', null, undefined, 20261110, new Date('2026-11-10'), '2026-11-10T00:00:00Z', '0000-01-01']) {
      expect(homeBlock({ ...HOME, lastVisit: { date, line: 'pest' } }, NOW)).toBeNull();
    }
  });

  test('no database text reaches the block: hostile strings in every field print nothing of theirs', () => {
    const hostile = '<script>alert(1)</script> gate code 4821 Mary Johnson 123 Main St {{unsubscribe_url}} {{quiz:x}} resident@example.com';
    const homes = [
      { lastVisit: { date: '2026-11-10', line: hostile, serviceType: hostile, notes: hostile, name: hostile }, sinceDate: '2024-03-05', name: hostile, address: hostile, notes: hostile },
      { lastVisit: { date: hostile, line: hostile }, sinceDate: hostile },
      { lastVisit: { date: '2026-11-10', line: 'pest', label: hostile, text: hostile }, sinceDate: '2024-03-05', line: hostile },
    ];
    for (const home of homes) {
      const b = homeBlock(home, NOW);
      const all = b ? `${b.html}\n${b.text}` : '';
      for (const word of ['script', '4821', 'Mary', 'Main St', 'unsubscribe_url', '{{', 'resident@', 'hostile', 'gate code']) expect(all).not.toContain(word);
      if (b) expect(b.html.replace(/<[^>]+>/g, '')).not.toMatch(/[<>"]/);
    }
    // A date string with markup in it is no calendar day: nothing of it can print.
    expect(homeBlock({ lastVisit: { date: `2026-11-10${hostile}` }, sinceDate: `2024-03-05${hostile}` }, NOW)).toBeNull();
  });

  test('homeSubstitutions always has both keys; a block the send check refuses leaves both empty and is reported', () => {
    for (const home of [null, undefined, {}, { lastVisit: { date: 'x' } }]) {
      expect(homeSubstitutions(home, { now: NOW })).toEqual({ substitutions: { [HOME_TOKEN]: '', [HOME_TEXT_TOKEN]: '' }, rejected: false });
    }
    const ok = homeSubstitutions(HOME, { now: NOW });
    expect(Object.keys(ok.substitutions)).toEqual([HOME_TOKEN, HOME_TEXT_TOKEN]);
    expect(ok.substitutions[HOME_TEXT_TOKEN]).toBe(homeBlock(HOME, NOW).text);
    expect(ok.rejected).toBe(false);
    expect(homeSubstitutions(HOME, { now: NOW, errorsOf: () => ['blocked'] }))
      .toEqual({ substitutions: { [HOME_TOKEN]: '', [HOME_TEXT_TOKEN]: '' }, rejected: true });
  });

  test('only the two exact spellings are tokens: a variant is not detected and not stripped, so it stays visible', () => {
    expect(hasHomeToken('a {{pi-home}} b')).toBe(true);
    expect(hasHomeToken('a {{pi-home-text}} b')).toBe(true);
    // SendGrid fills only the two exact literals: any other spelling must never be hidden.
    for (const variant of ['{{PI-HOME}}', '{{Pi-Home-Text}}', '{{ pi-home }}', '{{pi-home }}', '{{ pi-home-text}}', '{{pi-homes}}', '{{pi}}', '{{quiz:x}}', '{pi-home}', '{{pi-home}']) {
      expect(hasHomeToken(`a ${variant} b`)).toBe(false);
      expect(neutralizeHomeTokens(`a ${variant} b`)).toBe(`a ${variant} b`);
    }
    expect(hasHomeToken(null)).toBe(false);
    expect(neutralizeHomeTokens('a {{pi-home}}b{{pi-home-text}}{{ PI-Home }} c')).toBe('a b{{ PI-Home }} c');
    expect(neutralizeHomeTokens('{{pi-home}}{{pi-home-text}}{{pi-home}}')).toBe('');
    expect(neutralizeHomeTokens(null)).toBe('');
    // Repeated calls keep working (no sticky regex state).
    for (let i = 0; i < 3; i += 1) expect(hasHomeToken('{{pi-home}}')).toBe(true);
  });
});

describe('the referral line', () => {
  // The owner's approved words (2026-11-21 "words ok"): the line until the new referral rules are on, and after.
  const TODAY = 'Know a neighbor fighting the same bugs? Send them our way — referrals are the nicest compliment we get.';
  const NEW_50 = 'Know a neighbor fighting the same bugs? Send them our way. They get a $50 credit after their first plan service.';
  const SIGNOFF_WORDS = 'Catch you next time. — The Waves Team 🌊';
  const SIGNOFF_OPENS = '<div class="dm-text">\n<p style="margin:26px 0 4px 0;';
  // The last two text blocks of a body whose tokens have their values.
  const lastTwoBlocks = (html) => html.slice(html.lastIndexOf('<div class="dm-text">', html.lastIndexOf('<div class="dm-text">') - 1));

  test('every issue closes with the line\'s token and then the sign-off, once in each part; the stored body holds no word of the line and no amount', () => {
    expect(CLOSING_TEXT).toBe(`${REFERRAL_TEXT_TOKEN}${SIGNOFF_TEXT}`);
    for (const pollQuizId of [null, PEST_INSIDER_POLL_IDS[0]]) {
      const r = renderIssue({ ...BASE, pollQuizId });
      expect(r.html_body).toContain(`</div>\n${HOME_TOKEN}${REFERRAL_TOKEN}${SIGNOFF_OPENS}`);
      expect(r.text_body.endsWith(`\n\n${HOME_TEXT_TOKEN}${REFERRAL_TEXT_TOKEN}${SIGNOFF_TEXT}`)).toBe(true);
      // Each part holds its own token, once, and not the other part's.
      expect(r.html_body.split(REFERRAL_TOKEN)).toHaveLength(2);
      expect(r.html_body).not.toContain(REFERRAL_TEXT_TOKEN);
      expect(r.text_body.split(REFERRAL_TEXT_TOKEN)).toHaveLength(2);
      expect(r.text_body).not.toContain(REFERRAL_TOKEN);
      for (const part of [r.html_body, r.text_body]) {
        // The archive serves this body for good: it can never state a credit, and a pause of the program can take the whole line out.
        expect(part).not.toContain('Know a neighbor');
        expect(part).not.toContain(REFERRAL_URL);
        expect(part).not.toMatch(/\$\s?\d/);
        expect(part).not.toMatch(/credit/i);
      }
    }
  });

  test('referralLine gives the two approved forms word for word, with the link on "Send them our way"', () => {
    expect(REFERRAL_URL).toBe('https://www.wavespestcontrol.com/referral/');
    const first = referralLine(REFERRAL_TAIL);
    expect(wordsOf(first.html)).toBe(TODAY);
    expect(first.text).toBe(`${TODAY}\n${REFERRAL_URL}\n\n`);
    const paid = referralLine(referralTail(5000));
    expect(wordsOf(paid.html)).toBe(NEW_50);
    expect(paid.text).toBe(`${NEW_50}\n${REFERRAL_URL}\n\n`);
    for (const line of [first, paid]) {
      // One text block of the body, with the body's own paragraph and link markup, and a newline for the sign-off to follow.
      expect(line.html).toMatch(new RegExp(`^<div class="dm-text">\\n<p style="margin:0 0 14px 0;font-size:16px;line-height:1.6;">Know a neighbor fighting the same bugs\\? <a class="dm-link" href="${REFERRAL_URL}" style="[^"]+">Send them our way</a>[^<]+</p>\\n</div>\\n$`));
      expect([...line.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([REFERRAL_URL]);
    }
    // The link is styled as the issue's other text links are.
    const leadLink = renderIssue(BASE).html_body.match(/<a class="dm-link" href="[^"]+" style="([^"]+)"/)[1];
    expect(first.html).toContain(`style="${leadLink}">Send them our way</a>`);
    // An end is written into the HTML part as text.
    expect(referralLine(' <b>&').html).toContain('Send them our way</a> &lt;b&gt;&amp;</p>');
    expect(referralLine(' <b>&').text).toContain('Send them our way <b>&\n');
    expect(NO_LINE).toEqual({ html: '', text: '' });
  });

  test('a surface with no reader shows the first approved form, with no token left: neutralizeIssueTokens, and the archive\'s stripPersonalizationTokens', () => {
    const { stripPersonalizationTokens } = require('../services/newsletter-draft');
    const r = renderIssue({ ...BASE, pollQuizId: PEST_INSIDER_POLL_IDS[0] });
    const html = neutralizeIssueTokens(r.html_body);
    const text = neutralizeIssueTokens(r.text_body);
    expect(wordsOf(lastTwoBlocks(html))).toBe(`${TODAY} ${SIGNOFF_WORDS}`);
    expect(html.endsWith(`</div>\n${referralLine(REFERRAL_TAIL).html}${closingHtmlOf(r.html_body).slice(REFERRAL_TOKEN.length)}`)).toBe(true);
    expect(text.endsWith(`\n\n${TODAY}\n${REFERRAL_URL}\n\n${SIGNOFF_TEXT}`)).toBe(true);
    expect(text).not.toMatch(/\n\n\n/);
    // The "Your home" tokens go in the same call, as before.
    expect(html).toBe(neutralizeHomeTokens(r.html_body).split(REFERRAL_TOKEN).join(referralLine(REFERRAL_TAIL).html));
    expect(text).toBe(neutralizeHomeTokens(r.text_body).split(REFERRAL_TEXT_TOKEN).join(referralLine(REFERRAL_TAIL).text));
    for (const part of [html, text, stripPersonalizationTokens(r.html_body), stripPersonalizationTokens(r.text_body)]) {
      expect(part).not.toContain('{{pi-');
      expect(part.split('referrals are the nicest compliment we get.')).toHaveLength(2);
      expect(part).not.toMatch(/\$\s?\d/);
    }
    // Only the exact spellings are the tokens: a variant stays visible, never hidden behind a clean-looking copy.
    const variants = 'a {{ pi-referral }} b {{PI-REFERRAL-TEXT}} c {{pi-referral-tail}}';
    expect(neutralizeIssueTokens(variants)).toBe(variants);
    // A body with no token of the line is only cleared of the "Your home" tokens.
    expect(neutralizeIssueTokens(`a${HOME_TOKEN}b`)).toBe('ab');
    expect(neutralizeIssueTokens(null)).toBe('');
  });

  test('referralTail gives the amount end only for a whole, positive number of cents', () => {
    expect(referralTail(5000)).toBe('. They get a $50 credit after their first plan service.');
    expect(referralTail(2500)).toBe('. They get a $25 credit after their first plan service.');
    expect(referralTail(2550)).toBe('. They get a $25.50 credit after their first plan service.');
    for (const none of [0, -5000, NaN, null, undefined, '5000', 50.5, Infinity]) expect(referralTail(none)).toBe(REFERRAL_TAIL);
    expect(REFERRAL_TAIL).toBe(' — referrals are the nicest compliment we get.');
    // The member is promised nothing: a member at the yearly limit earns no credit.
    expect(referralTail(5000)).not.toMatch(/\byou\b|\byour\b|\bwe\b/i);
  });

  test('with the amount line in the place of the tokens, both parts read as the second approved form, and nothing else changes', () => {
    const r = renderIssue({ ...BASE, pollQuizId: PEST_INSIDER_POLL_IDS[0] });
    const paid = referralLine(referralTail(5000));
    const html = fillReferralLine(r.html_body, paid);
    const text = fillReferralLine(r.text_body, paid);
    expect(wordsOf(lastTwoBlocks(html))).toBe(`${NEW_50} ${SIGNOFF_WORDS}`);
    expect(text.endsWith(`${NEW_50}\n${REFERRAL_URL}\n\n${SIGNOFF_TEXT}`)).toBe(true);
    expect(html).toBe(r.html_body.split(REFERRAL_TOKEN).join(paid.html));
    expect(text).toBe(r.text_body.split(REFERRAL_TEXT_TOKEN).join(paid.text));
    // No line given, or no content: back as it is.
    expect(fillReferralLine(r.html_body, null)).toBe(r.html_body);
    expect(fillReferralLine(r.html_body, undefined)).toBe(r.html_body);
    expect(fillReferralLine(null, paid)).toBeNull();
    expect(fillReferralLine(undefined, paid)).toBeUndefined();
  });

  test('with no line (a paused referral program), a reader gets exactly the issue without it: the sign-off follows the last section', () => {
    for (const pollQuizId of [null, PEST_INSIDER_POLL_IDS[0]]) {
      const r = renderIssue({ ...BASE, pollQuizId });
      const html = neutralizeHomeTokens(fillReferralLine(r.html_body, NO_LINE));
      const text = neutralizeHomeTokens(fillReferralLine(r.text_body, NO_LINE));
      for (const part of [html, text]) {
        expect(part).not.toContain('{{pi-');
        expect(part).not.toContain('Know a neighbor');
        expect(part).not.toContain(REFERRAL_URL);
      }
      expect(html).toBe(r.html_body.split(`${HOME_TOKEN}${REFERRAL_TOKEN}`).join(''));
      expect(html).toContain(`</div>\n${SIGNOFF_OPENS}`);
      expect(text).toBe(r.text_body.split(`${HOME_TEXT_TOKEN}${REFERRAL_TEXT_TOKEN}`).join(''));
      expect(text.endsWith(`\n\n${SIGNOFF_TEXT}`)).toBe(true);
      expect(text).not.toMatch(/\n\n\n/);
    }
  });

  test('the first form and an issue with no line pass the send check; the amount form would not: it never goes in a stored body', () => {
    const r = renderIssue(BASE);
    const check = (html, text) => validateNewsletterDraft({ html_body: html, text_body: text, subject: r.subject, newsletter_type: 'pest-insider-monthly' }, { recipientCount: 1 }).errors;
    expect(check(neutralizeIssueTokens(r.html_body), neutralizeIssueTokens(r.text_body))).toEqual([]);
    const withLine = (line) => (part) => neutralizeHomeTokens(fillReferralLine(part, line));
    const none = withLine(NO_LINE);
    expect(check(none(r.html_body), none(r.text_body))).toEqual([]);
    const paid = withLine(referralLine(referralTail(5000)));
    expect(check(paid(r.html_body), paid(r.text_body)).join(' ')).toMatch(/dollar amount/);
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
