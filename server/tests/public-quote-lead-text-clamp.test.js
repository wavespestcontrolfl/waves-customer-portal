/**
 * 2026-11-05 new-customer walk: a 300-character first name overflowed
 * leads.first_name (varchar 255) and /calculate answered 500. Free-text is now
 * cut to its leads column before the leads insert and update.
 */
const fs = require('fs');
const path = require('path');
const { _internals } = require('../routes/public-quote');

const { clampLeadText, LEAD_TEXT_LIMITS } = _internals;

describe('clampLeadText', () => {
  test('a 300-character first name is stored at 255 characters', () => {
    const out = clampLeadText({ first_name: 'A'.repeat(300), last_name: 'Sample' });
    expect(out.first_name).toHaveLength(255);
    expect(out.last_name).toBe('Sample');
  });

  test('every free-text lead column is cut to its limit', () => {
    const input = {};
    for (const key of Object.keys(LEAD_TEXT_LIMITS)) input[key] = 'x'.repeat(400);
    const out = clampLeadText(input);
    for (const [key, max] of Object.entries(LEAD_TEXT_LIMITS)) expect(out[key]).toHaveLength(max);
    expect(LEAD_TEXT_LIMITS.service_key).toBe(80);
  });

  test('short values, nulls and non-text values pass through unchanged', () => {
    const when = new Date();
    const raw = { toSQL: () => 'x' };
    const input = { first_name: 'Sam', city: null, zip: undefined, monthly_value: 12.5, updated_at: when, extracted_data: raw, status: 'new' };
    const out = clampLeadText(input);
    expect(out).toEqual(input);
    expect(out.extracted_data).toBe(raw);
    expect(out.updated_at).toBe(when);
  });

  test('does not change the object it was given', () => {
    const input = { first_name: 'A'.repeat(300) };
    clampLeadText(input);
    expect(input.first_name).toHaveLength(300);
  });

  test('both /calculate lead writes (insert and token update) go through the clamp', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
    expect(src).toMatch(/db\('leads'\)\.insert\(clampLeadText\(\{\s*first_name: contactFirstName/);
    expect(src).toMatch(/const updateFields = clampLeadText\(\{\s*first_name: contactFirstName/);
  });
});
