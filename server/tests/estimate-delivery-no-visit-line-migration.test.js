// Non-database half of the 20261122030000 migration check: where the line goes in the estimate email, and that the
// two places that carry the owner's sentence (call script, estimate email) say the same words. The published-version
// behavior is proved by the opt-in PostgreSQL suite beside it.
const migration = require('../models/migrations/20261122030000_estimate_delivery_no_visit_line');
const { NO_VISIT_QUOTE_LINE } = require('../services/csr/weekly-call-outcomes');

const { LINE, insertLine } = migration._private;
const PARAGRAPH = { type: 'paragraph', content: LINE };

describe('estimate email "no visit needed" line migration plan', () => {
  test('the line goes directly under the price rows, and the source blocks are not changed', () => {
    const blocks = [
      { type: 'paragraph', content: 'Hi {{first_name}}' },
      { type: 'details', rows: [{ label: 'Estimated price', value: '{{price_summary}}' }] },
      { type: 'paragraph', content: 'Inside the estimate you can review the service breakdown.' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ];
    const out = insertLine(blocks);
    expect(out[2]).toEqual(PARAGRAPH);
    expect(out).toHaveLength(5);
    expect(out.filter((b) => b.content !== LINE)).toEqual(blocks);
    expect(blocks).toHaveLength(4);
  });

  test('with no price rows it goes above the first button, and with no button at the end', () => {
    expect(insertLine([{ type: 'paragraph', content: 'Hi' }, { type: 'cta', label: 'View' }, { type: 'small_note', content: 'z' }])[1]).toEqual(PARAGRAPH);
    expect(insertLine([{ type: 'paragraph', content: 'Hi' }]).at(-1)).toEqual(PARAGRAPH);
  });

  test('the estimate email and the call script carry the same sentence, the one the owner picked', () => {
    expect(migration._private.TEMPLATE_KEY).toBe('estimate.delivery');
    expect(LINE).toBe('We measure your home and yard from county records and satellite images, so most quotes need no visit.');
    expect(NO_VISIT_QUOTE_LINE).toBe(LINE);
  });
});
