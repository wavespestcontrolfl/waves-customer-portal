// Contract for the `list` block added to the email template renderer —
// check-list rows used by the estimate.engage_* "Why folks choose Waves"
// module. Items resolve {{variables}} like every other block, and an item
// that resolves to blank drops (same truth-scope mechanism as FAQ rows).
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => null) })) }));
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: () => 0,
  newsletterGroupId: () => 0,
}));

const { renderTemplate } = require('../services/email-template-library');

const baseTemplate = { name: 'Engage', mode: 'service' };
const render = (blocks, payload = {}) =>
  renderTemplate({ template: baseTemplate, version: { subject: 'Why Waves', blocks }, payload });

describe('email renderer — list block', () => {
  test('renders one check row per item, in order, with the plain-text fallback', () => {
    const { html, text } = render([
      { type: 'list', items: ['Family-owned and local.', 'FDACS-licensed and insured.'] },
    ]);
    expect(html).toContain('&#10003;');
    expect(html.indexOf('Family-owned and local.')).toBeLessThan(html.indexOf('FDACS-licensed and insured.'));
    expect(text).toContain('- Family-owned and local.');
    expect(text).toContain('- FDACS-licensed and insured.');
  });

  test('items resolve payload variables, and blank-resolving items drop', () => {
    const { html } = render(
      [{ type: 'list', items: ['Serving {{service_area}}.', '{{maybe_claim}}'] }],
      { service_area: 'Southwest Florida', maybe_claim: '' },
    );
    expect(html).toContain('Serving Southwest Florida.');
    // Only the surviving item renders a check row.
    expect(html.match(/&#10003;/g)).toHaveLength(1);
  });

  test('an all-blank list renders nothing (no empty check rows leak past the guard)', () => {
    const { html } = render([{ type: 'list', items: ['', '   '] }]);
    expect(html).not.toContain('&#10003;');
  });
});
