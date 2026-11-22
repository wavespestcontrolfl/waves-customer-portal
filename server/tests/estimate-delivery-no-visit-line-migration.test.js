// Non-database half of the 20261122030000 migration check: where the line goes in the estimate email, what counts as
// "already there", who gets the sentence (a home estimate only), and that the migration's preview sample, the live
// sentence and the call script say the same words. The published-version behavior is proved by the opt-in
// PostgreSQL suite beside it.
const migration = require('../models/migrations/20261122030000_estimate_delivery_no_visit_line');
const { NO_VISIT_QUOTE_LINE, NO_VISIT_LINE_VARIABLE, noVisitLineFor } = require('../services/estimate-no-visit-line');
const callScript = require('../services/csr/weekly-call-outcomes');

const { LINE, NOTE, VARIABLE, insertLine, carriesLine } = migration._private;
const PARAGRAPH = { type: 'paragraph', content: '{{estimate_no_visit_line}}' };

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
    expect(out.filter((b) => b.content !== NOTE)).toEqual(blocks);
    expect(blocks).toHaveLength(4);
  });

  test('it follows the details block that shows the price, not an earlier details block', () => {
    const blocks = [
      { type: 'details', rows: [{ label: 'Property', value: '{{property_address}}' }] },
      { type: 'paragraph', content: 'Here is your price.' },
      { type: 'details', rows: [{ label: 'Service', value: '{{service_summary}}' }, { label: 'Estimated price', value: '{{ price_summary }}' }] },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ];
    const out = insertLine(blocks);
    expect(out.map((b) => b.type)).toEqual(['details', 'paragraph', 'details', 'paragraph', 'cta']);
    expect(out[3]).toEqual(PARAGRAPH);
  });

  test('with no price rows it goes above the first button, and with no button at the end', () => {
    expect(insertLine([{ type: 'paragraph', content: 'Hi' }, { type: 'cta', label: 'View' }, { type: 'small_note', content: 'z' }])[1]).toEqual(PARAGRAPH);
    // A details block with no price in it is not "the price rows".
    expect(insertLine([{ type: 'details', rows: [{ label: 'Property', value: '{{property_address}}' }] }, { type: 'paragraph', content: 'Hi' }, { type: 'cta', label: 'View' }])[2]).toEqual(PARAGRAPH);
    expect(insertLine([{ type: 'paragraph', content: 'Hi' }]).at(-1)).toEqual(PARAGRAPH);
  });

  test('the line counts as already there, as the variable or as the sentence, in any block that shows text', () => {
    expect(carriesLine([{ type: 'paragraph', content: '{{estimate_no_visit_line}}' }])).toBe(true);
    expect(carriesLine([{ type: 'small_note', content: 'Good to know. {{ estimate_no_visit_line }}' }])).toBe(true);
    expect(carriesLine([{ type: 'paragraph', content: `Good to know. ${LINE}` }])).toBe(true);
    expect(carriesLine([{ type: 'list', items: ['First point.', LINE] }])).toBe(true);
    expect(carriesLine([{ type: 'details', rows: [{ label: 'Does someone come out?', value: LINE }] }])).toBe(true);
    expect(carriesLine([{ type: 'paragraph', content: 'We measure your home.' }, { type: 'cta', label: 'View' }])).toBe(false);
  });

  test('the preview sample, the live sentence and the call script are the sentence the owner picked', () => {
    expect(migration._private.TEMPLATE_KEY).toBe('estimate.delivery');
    expect(LINE).toBe('We measure your home and yard from county records and satellite images, so most quotes need no visit.');
    expect(NO_VISIT_QUOTE_LINE).toBe(LINE);
    expect(callScript.NO_VISIT_QUOTE_LINE).toBe(LINE);
    expect(callScript.NO_VISIT_SCRIPT_LINE).toBe(`If the caller asks whether someone comes out to quote, say: "${LINE}"`);
    expect(VARIABLE).toBe('estimate_no_visit_line');
    expect(NO_VISIT_LINE_VARIABLE).toBe(VARIABLE);
    expect(NOTE).toBe('{{estimate_no_visit_line}}');
  });
});

describe('who gets the "no visit needed" line', () => {
  const HOME = { category: 'RESIDENTIAL', estimate_data: JSON.stringify({ services: [{ service: 'pest_control' }] }) };

  test('a home estimate gets the sentence', () => {
    expect(noVisitLineFor(HOME)).toBe(LINE);
    expect(noVisitLineFor({ category: 'residential', estimateData: { services: [] } })).toBe(LINE);
    expect(noVisitLineFor({ category: 'RESIDENTIAL' })).toBe(LINE);
  });

  test('a commercial estimate gets nothing, with or without a proposal', () => {
    expect(noVisitLineFor({ ...HOME, category: 'COMMERCIAL' })).toBe('');
    expect(noVisitLineFor({ ...HOME, category: 'COMMERCIAL' }, { proposalMode: true })).toBe('');
    expect(noVisitLineFor(HOME, { proposalMode: true })).toBe('');
  });

  test('it fails closed: no category, or commercial marks inside a residential row, gets nothing', () => {
    expect(noVisitLineFor({})).toBe('');
    expect(noVisitLineFor()).toBe('');
    expect(noVisitLineFor({ category: null, estimate_data: HOME.estimate_data })).toBe('');
    expect(noVisitLineFor({ category: 'RESIDENTIAL', estimate_data: { propertyType: 'Commercial' } })).toBe('');
    expect(noVisitLineFor({ category: 'RESIDENTIAL', estimate_data: JSON.stringify({ lines: [{ service: 'commercial_pest' }] }) })).toBe('');
    // Unreadable estimate data is not proof of a business: the row still says RESIDENTIAL.
    expect(noVisitLineFor({ category: 'RESIDENTIAL', estimate_data: '{not json' })).toBe(LINE);
  });
});
