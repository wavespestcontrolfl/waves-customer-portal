/**
 * /calculate without a lead token files a repeat of the same inquiry as a
 * 'duplicate' of the visitor's open quote_wizard lead instead of a second
 * 'new' lead (2026-08-31: two identical calculator quotes two minutes apart
 * became two open leads). The match is email AND phone AND quoted address —
 * a typed email alone is not ownership evidence on a public route, and the
 * helper only ever labels the NEW row; it never selects a row to mutate.
 */
const { _internals } = require('../routes/public-quote');
const { OPEN_LEAD_STATUSES } = require('../services/lead-statuses');

function chainMock(firstResult) {
  const calls = { where: [], whereRaw: [], whereIn: [], whereNull: [], orderBy: [] };
  const api = {
    where: jest.fn((...a) => { calls.where.push(a); return api; }),
    whereNull: jest.fn((...a) => { calls.whereNull.push(a); return api; }),
    whereRaw: jest.fn((...a) => { calls.whereRaw.push(a); return api; }),
    whereIn: jest.fn((...a) => { calls.whereIn.push(a); return api; }),
    orderBy: jest.fn((...a) => { calls.orderBy.push(a); return api; }),
    first: jest.fn(async () => firstResult),
  };
  const dbh = jest.fn(() => api);
  return { dbh, api, calls };
}

const SAME = { email: '  Visitor.One@Example.com ', phone: '(941) 555-0142', address: '123  Sample St, Parrish, FL 34219', serviceKey: 'pest_general_quarterly' };

describe('findPriorOpenWizardLeadId', () => {
  test('matches the newest open quote_wizard lead on service + email + phone + address, normalized', async () => {
    const { dbh, calls } = chainMock({ id: 'lead-prior' });
    const now = Date.UTC(2026, 7, 31, 19, 0, 0);
    await expect(_internals.findPriorOpenWizardLeadId(dbh, SAME, now)).resolves.toBe('lead-prior');
    expect(dbh).toHaveBeenCalledWith('leads');
    expect(calls.where[0]).toEqual([{ lead_type: 'quote_wizard', service_key: 'pest_general_quarterly' }]);
    expect(calls.whereNull[0]).toEqual(['deleted_at']);
    expect(calls.whereRaw[0]).toEqual(['LOWER(email) = ?', ['visitor.one@example.com']]);
    expect(calls.whereRaw[1][1]).toEqual(['%9415550142']);
    expect(calls.whereRaw[2][1]).toEqual(['123 sample st, parrish, fl 34219']);
    expect(calls.whereIn[0]).toEqual(['status', OPEN_LEAD_STATUSES]);
    const [col, op, cutoff] = calls.where[1];
    expect([col, op]).toEqual(['created_at', '>']);
    expect(cutoff.getTime()).toBe(now - _internals.WIZARD_LEAD_REUSE_DAYS * 86400000);
    expect(calls.orderBy[0]).toEqual(['created_at', 'desc']);
  });

  test('no matching open lead → null (the row inserts as a normal new lead)', async () => {
    const { dbh } = chainMock(undefined);
    await expect(_internals.findPriorOpenWizardLeadId(dbh, SAME)).resolves.toBeNull();
  });

  test.each([
    ['missing email', { ...SAME, email: '' }],
    ['short phone', { ...SAME, phone: '555-0142' }],
    ['missing address', { ...SAME, address: '  ' }],
    ['no catalog service key (manual / quote-on-request mix)', { ...SAME, serviceKey: null }],
  ])('%s → null without touching the database (all four keys are required)', async (_label, keys) => {
    const { dbh } = chainMock({ id: 'never' });
    await expect(_internals.findPriorOpenWizardLeadId(dbh, keys)).resolves.toBeNull();
    expect(dbh).not.toHaveBeenCalled();
  });
});

describe('duplicate ancestry follows the token the browser holds', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');

  test('duplicateOfFromExtracted reads the marker off parsed jsonb and legacy strings', () => {
    expect(_internals.duplicateOfFromExtracted({ duplicate_of_lead_id: 'lead-1' })).toBe('lead-1');
    expect(_internals.duplicateOfFromExtracted(JSON.stringify({ duplicate_of_lead_id: 'lead-2' }))).toBe('lead-2');
    expect(_internals.duplicateOfFromExtracted({})).toBeNull();
    expect(_internals.duplicateOfFromExtracted('not json')).toBeNull();
    expect(_internals.duplicateOfFromExtracted(null)).toBeNull();
  });

  test('the token path re-derives duplicate state from the stored row, and attribution is skipped for duplicates', () => {
    expect(src).toMatch(/returning\(\['id', 'lead_source_id', 'lead_type', 'status', 'extracted_data'\]\)/);
    expect(src).toMatch(/if \(lead && lead\.status === 'duplicate'\) duplicateOfLeadId = duplicateOfFromExtracted\(lead\.extracted_data\)/);
    expect(src).toMatch(/if \(!duplicateOfLeadId\) await db\('ad_service_attribution'\)\.insert\(/);
    // The replace path carries the marker forward.
    expect(src).toMatch(/'duplicate_of_lead_id', COALESCE\(extracted_data, '\{\}'::jsonb\)->'duplicate_of_lead_id'/);
  });

  test('nothing on the public surface follows the marker to the original (label only — the merge is a trusted-path job)', () => {
    // The marker is read only to label THIS row and skip its attribution;
    // no query selects the original for update from /calculate or /upsell.
    expect(src).not.toMatch(/where\(\{ id: originalId \}\)/);
    expect(src).not.toMatch(/duplicateOfFromExtracted\(lead\.extracted_data\) : null/);
    expect(src.match(/duplicateOfFromExtracted\(/g).length).toBe(2); // the definition + the token-path read
  });
});
