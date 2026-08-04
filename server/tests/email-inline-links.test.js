/**
 * Inline markdown links in block prose.
 *
 * Until now the only way to put a link in a template was a `cta` block, which
 * renders as a full-width gold bar — right for the primary action, far too
 * heavy for background reading. Block content is escaped, so an authored <a>
 * would render as literal text.
 *
 * Pins the security-relevant part: escaping happens FIRST and only the exact
 * markdown pattern is turned back into an anchor, and the href still goes
 * through safeUrl. A javascript:/data: URL must never become an executable
 * href, and unrelated angle brackets in content must stay escaped.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');

function render(content) {
  const template = {
    id: 't1',
    template_key: 'test.links',
    mode: 'service',
    allowed_variables: ['url'],
    required_variables: [],
    from_name: 'Waves Pest Control',
    from_email: 'contact@wavespestcontrol.com',
  };
  const version = {
    id: 'v1',
    subject: 'S',
    preview_text: 'P',
    blocks: [{ type: 'small_note', content }],
    text_body: '',
  };
  return EmailTemplates.renderTemplate({ template, version, payload: { url: 'https://www.wavespestcontrol.com/x/' } });
}
const markup = (html) => html.slice(html.indexOf('</style>'));

describe('inline markdown links in blocks', () => {
  test('renders an anchor with the label and href', () => {
    const body = markup(render('Read [the watering guide](https://www.wavespestcontrol.com/lawn-care/x/) first.').html);
    expect(body).toContain('href="https://www.wavespestcontrol.com/lawn-care/x/"');
    expect(body).toContain('>the watering guide</a>');
    expect(body).toContain('target="_blank"');
    expect(body).toContain('rel="noopener"');
  });

  test('the anchor carries dm-link so it stays legible on the dark card', () => {
    const body = markup(render('Read [it](https://www.wavespestcontrol.com/a/).').html);
    expect(body).toMatch(/<a class="dm-link"/);
  });

  test('a javascript: URL never becomes an executable href', () => {
    const body = markup(render('Click [here](javascript:alert(1)) now.').html);
    expect(body).not.toMatch(/href="javascript:/i);
    // Left as inert escaped text rather than silently dropped.
    expect(body).toContain('[here]');
  });

  test('a data: URL never becomes an executable href', () => {
    const body = markup(render('Click [here](data:text/html;base64,PHNjcmlwdD4=) now.').html);
    expect(body).not.toMatch(/href="data:/i);
  });

  test('unrelated markup in content is still escaped', () => {
    const body = markup(render('Careful <script>alert(1)</script> and [ok](https://www.wavespestcontrol.com/a/).').html);
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('href="https://www.wavespestcontrol.com/a/"');
  });

  test('a URL containing an ampersand survives escaping intact', () => {
    const body = markup(render('[go](https://www.wavespestcontrol.com/a/?x=1&y=2)').html);
    expect(body).toContain('href="https://www.wavespestcontrol.com/a/?x=1&amp;y=2"');
  });

  test('the plain-text part carries the destination, not a dangling label', () => {
    const out = render('Read [the guide](https://www.wavespestcontrol.com/lawn-care/x/) first.');
    expect(out.text).toContain('the guide (https://www.wavespestcontrol.com/lawn-care/x/)');
    expect(out.text).not.toContain('[the guide]');
  });

  test('a PAYLOAD value cannot inject a link (codex #3167 P1)', () => {
    // Payload values are customer-influenced. If substitution ran before
    // linkifying, a name or note containing markdown-link syntax would become
    // a live anchor in an outgoing email.
    const template = {
      id: 't1', template_key: 'test.inject', mode: 'service',
      allowed_variables: ['first_name'], required_variables: [],
      from_name: 'Waves Pest Control', from_email: 'contact@wavespestcontrol.com',
    };
    const version = {
      id: 'v1', subject: 'S', preview_text: 'P',
      blocks: [{ type: 'paragraph', content: 'Hello {{first_name}}.' }], text_body: '',
    };
    const out = EmailTemplates.renderTemplate({
      template, version,
      payload: { first_name: '[click me](https://evil.example.com/steal)' },
    });
    const body = markup(out.html);
    expect(body).not.toContain('evil.example.com/steal"');
    expect(body).not.toMatch(/<a[^>]*evil\.example\.com/);
    // It survives as inert escaped text.
    expect(body).toContain('[click me]');
  });

  test('a payload value cannot smuggle a link into the TEXT part either', () => {
    const template = {
      id: 't1', template_key: 'test.inject2', mode: 'service',
      allowed_variables: ['note'], required_variables: [],
      from_name: 'Waves Pest Control', from_email: 'contact@wavespestcontrol.com',
    };
    const version = {
      id: 'v1', subject: 'S', preview_text: 'P',
      blocks: [{ type: 'paragraph', content: '{{note}}' }], text_body: '',
    };
    const out = EmailTemplates.renderTemplate({
      template, version, payload: { note: '[x](https://evil.example.com/a)' },
    });
    // Unchanged — not rewritten into "x (url)" as an authored link would be.
    expect(out.text).toContain('[x](https://evil.example.com/a)');
  });

  test('a variable inside an AUTHORED link label resolves in BOTH parts', () => {
    // The first version of this test only asserted the href, so it passed
    // while the label shipped a literal {{url}} to the customer. Assert the
    // rendered label text, not just the destination.
    const out = render('Read [the {{url}} guide](https://www.wavespestcontrol.com/a/).');
    const body = markup(out.html);
    expect(body).toContain('href="https://www.wavespestcontrol.com/a/"');
    expect(body).toContain('the https://www.wavespestcontrol.com/x/ guide</a>');
    expect(body).not.toContain('{{url}}');
    expect(out.text).not.toContain('{{url}}');
  });

  test('a payload value used INSIDE a link label cannot inject markup', () => {
    // The label is substituted then escaped, so a payload cannot open a tag
    // or a second anchor from inside an authored link.
    const template = {
      id: 't1', template_key: 'test.labelinject', mode: 'service',
      allowed_variables: ['name'], required_variables: [],
      from_name: 'Waves Pest Control', from_email: 'contact@wavespestcontrol.com',
    };
    const version = {
      id: 'v1', subject: 'S', preview_text: 'P',
      blocks: [{ type: 'paragraph', content: 'Hi [{{name}}](https://www.wavespestcontrol.com/a/).' }],
      text_body: '',
    };
    const out = EmailTemplates.renderTemplate({
      template, version, payload: { name: '</a><script>alert(1)</script>' },
    });
    const body = markup(out.html);
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
    // Exactly one anchor came from this block.
    expect((body.match(/<a class="dm-link"/g) || []).length).toBe(1);
  });

  test('content without link syntax produces no block anchor', () => {
    // Scoped to dm-link: the chrome (logo, footer, app badges) has its own
    // anchors, so a bare '<a ' assertion would always fail.
    const body = markup(render('Just a plain sentence.').html);
    expect(body).toContain('Just a plain sentence.');
    expect(body).not.toContain('<a class="dm-link"');
  });
});
