// Pest Insider renderer: escaping, optional blocks, absolute links, dark-mode hooks.
const { renderIssue, wrapIssueHtml, toolAllowed, droppedBlocks, FORWARD_LINE } = require('../services/pest-insider/render');
const { bodyIsDarkAware } = require('../services/email-template');

const BASE = {
  subject: '🦟 Mosquito eggs wait 8 months dry',
  preview: 'Dry does not mean gone.',
  lead: { headline: 'Dry eggs, wet future', sentences: [{ text: 'The CDC says eggs survive 8 months.' }, { text: 'They stick to container walls.' }] },
  idItem: { text: 'It raises a generation in about a week.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
};
const DEMO = {
  areaLine: 'Sample line near the canals.',
  tool: { name: 'Sample nozzle', why: 'Sample reason.', url: 'https://www.example.com/tool', disclosure: 'Sample disclosure.' },
};

describe('renderIssue', () => {
  test('lead and identifier blocks render with absolute site links and the forward line', () => {
    const r = renderIssue({ ...BASE, blogUrl: 'https://www.wavespestcontrol.com/blog/mosquito-eggs/' });
    expect(r.subject).toBe(BASE.subject);
    expect(r.preview).toBe(BASE.preview);
    expect(r.html_body).toContain('Today I learned');
    expect(r.html_body).toContain('Dry eggs, wet future');
    expect(r.html_body).toContain('The CDC says eggs survive 8 months. They stick to container walls.');
    expect(r.html_body).toContain('href="https://www.wavespestcontrol.com/blog/mosquito-eggs/"');
    expect(r.html_body).toContain('href="https://www.wavespestcontrol.com/pest-identifier/aedes-mosquito/"');
    expect(r.html_body).toContain('href="https://www.wavespestcontrol.com/pest-identifier/"');
    expect(r.html_body).toContain(FORWARD_LINE);
    expect(r.text_body).toContain('https://www.wavespestcontrol.com/pest-identifier/aedes-mosquito/');
    expect(r.text_body).toContain('Read the full story: https://www.wavespestcontrol.com/blog/mosquito-eggs/');
    expect(r.text_body.trim().endsWith(FORWARD_LINE)).toBe(true);
    const hrefs = [...r.html_body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    hrefs.forEach((h) => expect(h).toMatch(/^https:\/\/www\.wavespestcontrol\.com\//));
  });

  test('every optional block is omitted cleanly when its input is missing or empty', () => {
    const r = renderIssue({ ...BASE, blogUrl: null, areaLine: '  ', tool: null });
    for (const label of ['Read the full story', 'Active near you', "A tool we&#39;d use"]) expect(r.html_body).not.toContain(label);
    expect(r.text_body).not.toMatch(/ACTIVE NEAR YOU|TOOL|Read the full story/);
    // an unusable blog link (wrong host, or not https) is dropped, not rendered
    for (const blogUrl of ['https://evil.example.com/post/', 'http://www.wavespestcontrol.com/blog/x/', 'javascript:alert(1)']) {
      expect(renderIssue({ ...BASE, blogUrl }).html_body).not.toContain('Read the full story');
    }
    expect(renderIssue({ ...BASE, tool: { name: 'No link', why: 'x', url: 'http://insecure.example.com' } }).html_body).not.toContain('No link');
  });

  test('caller text that fails the customer-copy screen is left out, block by block, and reported', () => {
    const bad = { areaLine: 'Gate code 4512 at the side yard.', tool: { ...DEMO.tool, why: 'A pet-safe spray for ants.' } };
    const r = renderIssue({ ...BASE, ...bad });
    expect(r.html_body).not.toContain('Active near you');
    expect(r.html_body).not.toContain('A tool we&#39;d use');
    expect(r.text_body).not.toMatch(/4512|pet-safe/);
    // a code-shaped number never reaches the mass email, even where the shared screen allows it (pre-push round 7)
    for (const areaLine of ['Side gate #1234.', 'Gate 4417 sticks.', 'Gate code is 1-2-3-4.']) {
      expect(renderIssue({ ...BASE, areaLine }).html_body).not.toContain('Active near you');
    }
    // a count is not an access code
    expect(renderIssue({ ...BASE, areaLine: '12 homes near you reported ants this month.' }).text_body).toContain('ACTIVE NEAR YOU\n12 homes near you reported ants this month.');
    expect(droppedBlocks(bad)).toEqual(['area_line_dropped', 'tool_dropped_copy']);
    expect(droppedBlocks({ tool: { ...DEMO.tool, url: 'https://amzn.to/abc123' } })).toEqual(['tool_dropped_affiliate']);
    expect(droppedBlocks(DEMO)).toEqual([]);
    expect(droppedBlocks({ areaLine: '  ', tool: null })).toEqual([]);
  });

  test('a {{...}} merge tag in caller text or a link is left out, since the sender fills it per recipient', () => {
    for (const url of ['https://www.example.com/tool?u={{unsubscribe_url}}', 'https://www.example.com/tool?u=%7B%7Bunsubscribe_url%7D%7D']) {
      expect(renderIssue({ ...BASE, tool: { ...DEMO.tool, url } }).html_body).not.toContain('A tool we&#39;d use');
    }
    expect(renderIssue({ ...BASE, blogUrl: 'https://www.wavespestcontrol.com/blog/x/?u={{unsubscribe_url}}' }).html_body).not.toContain('Read the full story');
    expect(renderIssue({ ...BASE, areaLine: 'Ants are busy in {{city}} this month.' }).html_body).not.toContain('Active near you');
    expect(renderIssue({ ...BASE, tool: { ...DEMO.tool, why: 'Hi{{greeting-name}}, it works.' } }).html_body).not.toContain('A tool we&#39;d use');
  });

  test("a household's visit details never enter the shared body", () => {
    const r = renderIssue({ ...BASE, home: { lastVisit: { date: '2026-11-04', areas: ['lanai'] }, nextVisit: { date: '2027-01-06', service: 'pest control' } } });
    expect(r.html_body).not.toMatch(/Your home|lanai|Next visit/);
    expect(r.text_body).not.toMatch(/YOUR HOME|lanai|Next visit/);
  });

  test('optional blocks render when given', () => {
    const r = renderIssue({ ...BASE, ...DEMO });
    expect(r.html_body).toContain('Active near you');
    expect(r.html_body).toContain('Sample line near the canals.');
    expect(r.html_body).toContain('A tool we&#39;d use');
    expect(r.html_body).toContain('href="https://www.example.com/tool"');
    expect(r.html_body).toContain('Sample disclosure.');
  });

  test('all text is escaped', () => {
    const hostile = '<script>alert("x")</script> & <img src=x onerror=1>';
    const r = renderIssue({
      ...BASE,
      lead: { headline: hostile, sentences: [{ text: hostile }, { text: 'ok' }] },
      idItem: { text: hostile, species: { slug: 'aedes-mosquito', name: hostile } },
      areaLine: hostile,
      tool: { name: hostile, why: hostile, url: 'https://www.example.com/t', disclosure: hostile },
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
    expect(bodyIsDarkAware(renderIssue({ ...BASE, ...DEMO }).html_body)).toBe(true);
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

describe('tool block affiliate guard', () => {
  test('a tool with affiliate material is left out, as the send validator would refuse it', () => {
    for (const url of ['https://www.amazon.com/dp/B000TEST00?tag=example-20', 'https://amzn.to/abc123', 'https://www.awin1.com/cread.php?x=1']) {
      const tool = { ...DEMO.tool, url };
      expect(toolAllowed(tool)).toBe(false);
      const r = renderIssue({ ...BASE, tool });
      expect(r.text_body).not.toContain("A TOOL WE'D USE");
      expect(r.html_body).not.toContain('A tool we&#39;d use');
      expect(r.text_body).not.toContain(url);
      expect(r.html_body).not.toContain(url);
    }
    expect(toolAllowed({ ...DEMO.tool, why: 'See amzn.to/abc123 for it.' })).toBe(false);
    expect(toolAllowed(DEMO.tool)).toBe(true);
    const shown = renderIssue({ ...BASE, tool: DEMO.tool });
    expect(shown.text_body).toContain("A TOOL WE'D USE");
    expect(shown.html_body).toContain('A tool we&#39;d use');
  });
});
