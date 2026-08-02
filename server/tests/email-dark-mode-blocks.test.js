/**
 * Dark mode for DB-driven templates.
 *
 * The dark stylesheet keys entirely off `dm-*` classes. Before this, the block
 * renderer emitted none of them, so `glassCard` fell back to `dm-lightcard` —
 * a deliberate safety choice, since forcing a dark card under light-theme
 * inline colours would have left dark text on dark. The result was a bright
 * white slab on a dark navy page for every one of the ~93 active templates,
 * which is what the owner reported on 2026-08-02.
 *
 * Pins: (1) each block type emits its hook, so the sheet can reach it;
 * (2) the assembled email lands on the DARK card, not the pinned-white one;
 * (3) the fallback still works — a body with no hooks (assembled elsewhere, or
 * persisted before the hooks existed) stays on the light card and keeps its
 * contrast rather than going unreadable;
 * (4) the gold CTA is deliberately left un-hooked — `dm-gold` flips its text to
 * navy and the button stays gold in both themes.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const { bodyIsDarkAware, wrapServiceEmail } = require('../services/email-template');

const BLOCKS = [
  { type: 'heading', content: 'Heading' },
  { type: 'paragraph', content: 'A paragraph.' },
  { type: 'callout', content: 'A callout.' },
  { type: 'details', rows: [{ label: 'Label', value: 'Value' }] },
  { type: 'details', variant: 'faq', rows: [{ label: 'Question?', value: 'Answer.' }] },
  { type: 'list', items: ['One', 'Two'] },
  { type: 'divider' },
  { type: 'cta', label: 'Do the thing', url: 'https://portal.wavespestcontrol.com/' },
  { type: 'small_note', content: 'Small print.' },
  { type: 'signature', content: '— The Waves Team' },
];

function render(blocks = BLOCKS) {
  const template = {
    id: 't1',
    template_key: 'test.dark',
    mode: 'service',
    allowed_variables: [],
    required_variables: [],
    from_name: 'Waves Pest Control',
    from_email: 'contact@wavespestcontrol.com',
  };
  const version = { id: 'v1', subject: 'Subject', preview_text: 'Preview', blocks, text_body: '' };
  return EmailTemplates.renderTemplate({ template, version, payload: {} });
}

// Everything after </style> is the actual email markup; the sheet itself
// mentions every class and would make any "is the hook present" check pass.
const markup = (html) => html.slice(html.indexOf('</style>'));

describe('dark-mode hooks on rendered blocks', () => {
  test.each([
    ['heading', 'dm-ink'],
    ['paragraph', 'dm-text'],
    ['callout', 'dm-box'],
    ['details row label', 'dm-muted'],
    ['details row value', 'dm-ink'],
    ['detail table + divider hairlines', 'dm-rule'],
    ['small note', 'dm-muted'],
    ['signature', 'dm-text'],
  ])('%s carries %s', (_label, cls) => {
    const body = markup(render().html);
    expect(new RegExp(`class="[^"]*${cls}[^"]*"`).test(body)).toBe(true);
  });

  test('the assembled body is recognised as dark-capable', () => {
    const { bodyHtml } = EmailTemplates.__private
      ? EmailTemplates.__private.renderBlocks(BLOCKS, {})
      : { bodyHtml: markup(render().html) };
    expect(bodyIsDarkAware(bodyHtml)).toBe(true);
  });

  test('the email lands on the DARK card, not the pinned-white one', () => {
    const body = markup(render().html);
    expect(body).toContain('class="dm-card"');
    expect(body).not.toContain('class="dm-lightcard"');
  });

  test('a body with NO hooks still falls back to the light card', () => {
    // The guard that protects bodies assembled elsewhere, or persisted before
    // the hooks existed — forcing them dark would make them unreadable.
    const plain = '<p style="color:#333;">no hooks here</p>';
    expect(bodyIsDarkAware(plain)).toBe(false);
    const html = wrapServiceEmail({ body: plain, darkAwareBody: bodyIsDarkAware(plain) });
    expect(markup(html)).toContain('class="dm-lightcard"');
  });

  test('the glass sentinel stays truthy — secondary CTAs remain gold bars', () => {
    // cardGlassBg is overloaded: it is the colour AND the "glass theme is
    // active" flag that makes ctaChip return the gold bar (owner call
    // 2026-07-06 — under glass ALL buttons render as identical gold bars).
    // Making the card opaque by NULLING it silently reverted every secondary
    // CTA to the old outlined chip. Opaque-but-truthy is the requirement.
     
    const { __testables, ctaChip, ctaButton } = require('../services/email-template');
    const chip = ctaChip('https://example.com/', 'Second action');
    const button = ctaButton('https://example.com/', 'Second action');
    expect(chip).toBe(button);
    // …and the surface it renders on must have no alpha channel.
    const blocks = [{ type: 'paragraph', content: 'x' }];
    const body = markup(render(blocks).html);
    expect(body).not.toMatch(/background:\s*rgba\([^)]*0?\.\d+\s*\)/);
  });

  test('the gold CTA button keeps its gold surface in both themes', () => {
    const body = markup(render().html);
    // Gold stays gold; dm-gold flips the LABEL to navy so it stays legible.
    expect(body).toContain('#F5B520');
    expect(body).toMatch(/class="[^"]*dm-gold[^"]*"/);
  });

  test('no light surface inside the card is left without a dark hook', () => {
    const body = markup(render().html);
    const offenders = [...body.matchAll(/<[^>]*background:(#[0-9A-Fa-f]{6})[^>]*>/g)]
      .filter((m) => !/class="[^"]*dm-/.test(m[0]))
      // The gold CTA is the one sanctioned exception (see above).
      .filter((m) => m[1].toUpperCase() !== '#F5B520');
    expect(offenders.map((m) => m[1])).toEqual([]);
  });
});
