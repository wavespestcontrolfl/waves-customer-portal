// Pest Insider renderer: reviewed copy only, escaping, absolute links, dark-mode hooks.
const { renderIssue, withToolBlock, wrapIssueHtml, POST_LINK_TEXT } = require('../services/pest-insider/render');
const { POST_URLS } = require('../services/pest-insider/posts');
const { toolById, toolLinkText, AMAZON_DISCLOSURE } = require('../services/pest-insider/tools');
const { bodyIsDarkAware } = require('../services/email-template');

// A reviewed post URL (posts.js): the only kind of blog link the body carries.
const [POST] = [...POST_URLS];
const BASE = {
  subject: '🦟 Mosquito eggs wait 8 months dry',
  preview: 'Dry does not mean gone.',
  lead: { headline: 'Dry eggs, wet future', sentences: [{ text: 'The CDC says eggs survive 8 months.' }, { text: 'They stick to container walls.' }], postUrl: POST },
  idItem: { text: 'It raises a generation in about a week.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
};

describe('renderIssue', () => {
  test('lead and identifier blocks render with absolute site links', () => {
    const r = renderIssue(BASE);
    expect(r.subject).toBe(BASE.subject);
    expect(r.preview).toBe(BASE.preview);
    expect(r.html_body).toContain('Today I learned');
    expect(r.html_body).toContain('Dry eggs, wet future');
    expect(r.html_body).toContain('The CDC says eggs survive 8 months. They stick to container walls.');
    expect(r.html_body).toContain('href="https://www.wavespestcontrol.com/pest-identifier/aedes-mosquito/"');
    expect(r.html_body).toContain('href="https://www.wavespestcontrol.com/pest-identifier/"');
    expect(r.text_body).toContain('https://www.wavespestcontrol.com/pest-identifier/aedes-mosquito/');
    // the lead links its reviewed post, after the lead sentences
    expect(r.html_body).toContain(`href="${POST}"`);
    expect(r.html_body).toContain(`>${POST_LINK_TEXT}</a>`);
    expect(r.text_body).toContain(`container walls.\n\n${POST_LINK_TEXT}: ${POST}\n`);
    // A forwarded copy would carry the subscriber's own unsubscribe link (pre-push round 11).
    for (const part of [r.html_body, r.text_body]) expect(part).not.toMatch(/forward/i);
    const hrefs = [...r.html_body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.filter((h) => h === POST)).toHaveLength(1);
    hrefs.filter((h) => h !== POST).forEach((h) => expect(h).toMatch(/^https:\/\/www\.wavespestcontrol\.com\/pest-identifier\//));
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

  test('withToolBlock adds the tool after "What\'s this?", with Amazon\'s sentence right after the link', () => {
    const gauge = toolById('acurite-glass-rain-gauge');
    const shared = renderIssue(BASE);
    const r = withToolBlock(shared, gauge.productId);
    expect(r.subject).toBe(shared.subject);
    expect(r.preview).toBe(shared.preview);
    // the shared copy, unchanged, then the tool block
    expect(r.html_body.startsWith(`${shared.html_body}\n<div class="dm-text">`)).toBe(true);
    expect(r.text_body.startsWith(shared.text_body)).toBe(true);
    const html = r.html_body.slice(shared.html_body.length);
    expect(html).toContain('A tool we&#39;d use');
    expect(html).toContain(`href="${gauge.url}"`);
    const linkAt = html.indexOf(`>${toolLinkText(gauge)}</a>`);
    const sentenceAt = html.indexOf(AMAZON_DISCLOSURE);
    expect(linkAt).toBeGreaterThan(html.indexOf(gauge.lines[1]));
    expect(sentenceAt).toBeGreaterThan(linkAt);
    // in normal body text, not the muted small print
    expect(html.slice(html.lastIndexOf('<p', sentenceAt), sentenceAt)).not.toMatch(/dm-muted/);
    expect(r.text_body.slice(shared.text_body.length))
      .toBe(`\nA TOOL WE'D USE\n${gauge.lines.join(' ')}\n\n${toolLinkText(gauge)}: ${gauge.url}\n${AMAZON_DISCLOSURE}\n`);
  });

  test('withToolBlock leaves the shared copy for a tool that is not usable now (pre-push PR 3 r3)', () => {
    const shared = renderIssue(BASE);
    for (const toolId of ['ks-adjustable-door-sweep', 'no-such-tool', '', null, 7]) {
      expect(withToolBlock(shared, toolId)).toBe(shared);
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
    });
    const plain = renderIssue(BASE);
    expect(withCallerInput.html_body).toBe(plain.html_body);
    expect(withCallerInput.text_body).toBe(plain.text_body);
  });

  test('all text is escaped', () => {
    const hostile = '<script>alert("x")</script> & <img src=x onerror=1>';
    const r = renderIssue({
      ...BASE,
      lead: { headline: hostile, sentences: [{ text: hostile }, { text: 'ok' }], postUrl: POST },
      idItem: { text: hostile, species: { slug: 'aedes-mosquito', name: hostile } },
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
