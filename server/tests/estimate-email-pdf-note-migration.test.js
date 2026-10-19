// Non-database half of the 20261019200000 migration check: where the note
// block goes, and which templates the plan covers. The published-version
// behavior is proved by the opt-in PostgreSQL suite beside it.
const migration = require('../models/migrations/20261019200000_estimate_email_pdf_note');
const { ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS } = require('../services/estimate-email-pdf');

const NOTE = { type: 'small_note', content: '{{estimate_pdf_note}}' };

describe('estimate email PDF note migration plan', () => {
  test('inserts the note directly after the first non-link button', () => {
    const blocks = [{ type: 'paragraph', content: 'Hi' }, { type: 'cta', variant: 'link', label: 'x', url: 'https://x.test' }, { type: 'cta', label: 'View', url_variable: 'estimate_url' }, { type: 'cta', variant: 'link', label: 'y', url: 'https://y.test' }];
    const out = migration._private.insertPdfNote(blocks);
    expect(out[3]).toEqual(NOTE);
    expect(out).toHaveLength(5);
    expect(blocks).toHaveLength(4);
  });

  test('falls back to a link button, then to the end', () => {
    expect(migration._private.insertPdfNote([{ type: 'cta', variant: 'link' }, { type: 'paragraph', content: 'z' }])[1]).toEqual(NOTE);
    expect(migration._private.insertPdfNote([{ type: 'paragraph', content: 'z' }]).at(-1)).toEqual(NOTE);
  });

  test('plans cover the delivery template and every sender allowlist key, and widen only the new variable', () => {
    const planKeys = migration._private.PLANS.map((p) => p.key).sort();
    expect(planKeys).toEqual(['estimate.delivery', ...ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS].sort());
    for (const plan of migration._private.PLANS) {
      expect(plan.variables).toEqual(['estimate_pdf_note']);
      expect(Object.keys(plan.fixture)).toEqual(['estimate_pdf_note']);
    }
  });
});
