// Pest Insider renderer: reviewed copy only, escaping, absolute links, dark-mode hooks.
const { renderIssue, wrapIssueHtml, POST_LINK_TEXT } = require('../services/pest-insider/render');
const { POST_URLS } = require('../services/pest-insider/posts');
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
