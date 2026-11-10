// The answering staff member's first name must never become the caller's name.
// Production, 8 inbound calls in 60 days: the speaker labels swapped at the
// greeting ("Waves, this is Robin") and the extraction saved the staff member's
// first name, alone, as the caller's. Pure tests for the shared "who answered"
// read and for the primary-caller guard. Synthetic names only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const { _test } = require('../services/call-recording-processor');

const { answeringStaffFirstName, withoutAnsweringStaffNameAsCaller: guard, callerWasOnFileBeforeCall } = _test;
// The guard only acts for a caller on file before the call.
const withoutAnsweringStaffNameAsCaller = (e, x, c, opts = { callerOnFile: true }) => guard(e, x, c, opts);

const answered = (csr, over = {}) => ({
  direction: 'inbound',
  metadata: { forward_acceptance: { accepted: true, csr_name: csr } },
  ...over,
});
const v1 = (over = {}) => ({ first_name: 'Robin', last_name: null, phone: '+15555550123', call_summary: 'x', ...over });
const v2 = (caller = {}) => ({ caller: { first_name: 'Robin', last_name: null, name_full: null, email: null, ...caller }, meta: {} });

describe('answeringStaffFirstName', () => {
  test('returns the lower-case first token of the accepted staff name', () => {
    expect(answeringStaffFirstName(answered('Robin'))).toBe('robin');
    expect(answeringStaffFirstName(answered('  Robin Staffer '))).toBe('robin');
  });

  test('reads a metadata JSON string', () => {
    const call = answered('Robin', { metadata: JSON.stringify({ forward_acceptance: { accepted: true, csr_name: 'Robin' } }) });
    expect(answeringStaffFirstName(call)).toBe('robin');
  });

  test('null for an outbound call, an unaccepted record, no record, bad JSON and role labels', () => {
    expect(answeringStaffFirstName(answered('Robin', { direction: 'outbound' }))).toBeNull();
    expect(answeringStaffFirstName({ direction: 'inbound', metadata: { forward_acceptance: { accepted: false, csr_name: 'Robin' } } })).toBeNull();
    expect(answeringStaffFirstName({ direction: 'inbound', metadata: {} })).toBeNull();
    expect(answeringStaffFirstName({ direction: 'inbound', metadata: '{not json' })).toBeNull();
    expect(answeringStaffFirstName({ direction: 'inbound' })).toBeNull();
    for (const label of ['Office Manager', 'Waves', 'Unknown', 'office manager']) {
      expect(answeringStaffFirstName(answered(label))).toBeNull();
    }
  });
});

describe('withoutAnsweringStaffNameAsCaller', () => {
  test('the 8-call shape: first name only, equal to the staff name, inbound, accepted -> cleared in both objects', () => {
    const extracted = v1();
    const ext2 = v2();
    const out = withoutAnsweringStaffNameAsCaller(extracted, ext2, answered('Robin'));
    expect(out.dropped).toBe(true);
    expect(out.extracted).toMatchObject({ first_name: null, last_name: null, phone: '+15555550123', call_summary: 'x' });
    expect(out.v2Extraction.caller).toMatchObject({ first_name: null, last_name: null });
    // pure: the inputs are not mutated
    expect(extracted.first_name).toBe('Robin');
    expect(ext2.caller.first_name).toBe('Robin');
  });

  test('compares first tokens case-insensitively', () => {
    const out = withoutAnsweringStaffNameAsCaller(v1({ first_name: ' ROBIN ' }), v2({ first_name: 'robin' }), answered('Robin Staffer'));
    expect(out.dropped).toBe(true);
    expect(out.extracted.first_name).toBeNull();
    expect(out.v2Extraction.caller.first_name).toBeNull();
  });

  test('V1-only: V2 absent or carrying another name', () => {
    const a = withoutAnsweringStaffNameAsCaller(v1(), null, answered('Robin'));
    expect(a.dropped).toBe(true);
    expect(a.extracted.first_name).toBeNull();
    expect(a.v2Extraction).toBeNull();
    const ext2 = v2({ first_name: 'Taylor' });
    const b = withoutAnsweringStaffNameAsCaller(v1(), ext2, answered('Robin'));
    expect(b.dropped).toBe(true);
    expect(b.extracted.first_name).toBeNull();
    expect(b.v2Extraction).toBe(ext2);
  });

  test('V2-only: V1 empty or carrying another name', () => {
    const ext = v1({ first_name: null });
    const a = withoutAnsweringStaffNameAsCaller(ext, v2(), answered('Robin'));
    expect(a.dropped).toBe(true);
    expect(a.extracted).toBe(ext);
    expect(a.v2Extraction.caller.first_name).toBeNull();
    const ext2 = v1({ first_name: 'Taylor' });
    const b = withoutAnsweringStaffNameAsCaller(ext2, v2(), answered('Robin'));
    expect(b.dropped).toBe(true);
    expect(b.extracted).toBe(ext2);
    expect(b.v2Extraction.caller.first_name).toBeNull();
  });

  test('a single-word name_full equal to the staff name is cleared with the first name', () => {
    const out = withoutAnsweringStaffNameAsCaller(v1(), v2({ name_full: 'Robin' }), answered('Robin'));
    expect(out.v2Extraction.caller.name_full).toBeNull();
  });

  test('kept when a last name is present on either side', () => {
    const e1 = v1({ last_name: 'Sample' });
    const x1 = v2({ last_name: null });
    expect(withoutAnsweringStaffNameAsCaller(e1, x1, answered('Robin'))).toEqual({ extracted: e1, v2Extraction: x1, dropped: false });
    const e2 = v1();
    const x2 = v2({ last_name: 'Sample' });
    expect(withoutAnsweringStaffNameAsCaller(e2, x2, answered('Robin')).dropped).toBe(false);
    // a surname hidden in a longer first_name or in name_full counts too
    expect(withoutAnsweringStaffNameAsCaller(v1({ first_name: 'Robin Sample' }), null, answered('Robin')).dropped).toBe(false);
    expect(withoutAnsweringStaffNameAsCaller(v1(), v2({ name_full: 'Robin Sample' }), answered('Robin')).dropped).toBe(false);
  });

  test('kept on an outbound call', () => {
    const e = v1();
    const x = v2();
    const out = withoutAnsweringStaffNameAsCaller(e, x, answered('Robin', { direction: 'outbound' }));
    expect(out).toEqual({ extracted: e, v2Extraction: x, dropped: false });
    expect(out.extracted).toBe(e);
  });

  test('kept with no acceptance record, an unaccepted one, or a role label', () => {
    for (const call of [
      { direction: 'inbound', metadata: {} },
      { direction: 'inbound' },
      { direction: 'inbound', metadata: { forward_acceptance: { accepted: false, csr_name: 'Robin' } } },
      answered('Office Manager'),
      answered('Waves'),
      answered('Unknown'),
    ]) {
      const e = v1({ first_name: 'Office' });
      expect(withoutAnsweringStaffNameAsCaller(v1(), v2(), call).dropped).toBe(false);
      expect(withoutAnsweringStaffNameAsCaller(e, v2({ first_name: 'Waves' }), call).dropped).toBe(false);
    }
  });

  test('kept when the first names differ', () => {
    const e = v1({ first_name: 'Taylor' });
    const x = v2({ first_name: 'Taylor' });
    const out = withoutAnsweringStaffNameAsCaller(e, x, answered('Robin'));
    expect(out.dropped).toBe(false);
    expect(out.extracted).toBe(e);
    expect(out.v2Extraction).toBe(x);
  });

  test('a caller not on file, or no on-file option at all, is left unchanged', () => {
    const e = v1();
    const x = v2();
    for (const out of [
      guard(e, x, answered('Robin'), { callerOnFile: false }),
      guard(e, x, answered('Robin'), {}),
      guard(e, x, answered('Robin')),
      guard(e, x, answered('Robin'), { callerOnFile: 'true' }),
    ]) {
      expect(out).toEqual({ extracted: e, v2Extraction: x, dropped: false });
      expect(out.extracted).toBe(e);
      expect(out.v2Extraction).toBe(x);
    }
  });

  test('tolerates empty inputs', () => {
    expect(withoutAnsweringStaffNameAsCaller(undefined, undefined, answered('Robin')).dropped).toBe(false);
    expect(withoutAnsweringStaffNameAsCaller({}, { meta: {} }, answered('Robin')).dropped).toBe(false);
  });
});

// The guard is wired once, early: after V2 adoption and before the triage flags, the customer and
// lead writes read the caller's name (so no missing_last_name card is filed for a cleared name).
describe('guard placement', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  const at = (needle) => src.indexOf(needle);

  test('runs once, after adoption and before the triage flags and the customer step', () => {
    const calls = src.match(/= withoutAnsweringStaffNameAsCaller\(/g) || [];
    expect(calls).toHaveLength(1);
    // the seam hands the guard the on-file proof, not a literal
    expect(src).toContain('{ callerOnFile: await callerWasOnFileBeforeCall(call, knownCaller) },');
    const guard = at('const staffNameGuard = withoutAnsweringStaffNameAsCaller(');
    expect(guard).toBeGreaterThan(at('adoptV2PrimaryFields(extracted, v2Result.extraction'));
    expect(guard).toBeLessThan(at('computeDeterministicTriageFlags(v2Extraction'));
    expect(guard).toBeLessThan(at('// Step 3: Create or update customer'));
    expect(guard).toBeLessThan(at('// Step 4b: Create lead in leads table'));
  });
});

describe('callerWasOnFileBeforeCall', () => {
  const db = require('../models/db');
  const start = '2026-11-09T15:00:00Z';
  const call = (over = {}) => ({ direction: 'inbound', created_at: start, customer_id: null, metadata: {}, ...over });

  test('the phone pre-lookup customer counts when its row predates the call', () => (
    expect(callerWasOnFileBeforeCall(call(), { id: 'c1', createdAt: '2026-01-01T00:00:00Z' })).resolves.toBe(true)
  ));

  test('a customer created after the call started does not count', () => (
    expect(callerWasOnFileBeforeCall(call(), { id: 'c1', createdAt: '2026-11-09T15:00:05Z' })).resolves.toBe(false)
  ));

  test('a customer this call\'s own earlier pass created does not count (reprocess = first pass)', async () => {
    const meta = { created_customer_id: 'c1' };
    expect(await callerWasOnFileBeforeCall(call({ metadata: meta }), { id: 'c1', createdAt: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(await callerWasOnFileBeforeCall(call({ metadata: JSON.stringify(meta), customer_id: 'c1' }), { id: 'c1', createdAt: '2026-01-01T00:00:00Z' })).toBe(false);
  });

  test('no customer, no lookup match, or an unreadable start time is not on file', async () => {
    expect(await callerWasOnFileBeforeCall(call(), null)).toBe(false);
    expect(await callerWasOnFileBeforeCall(call({ created_at: null }), { id: 'c1', createdAt: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(await callerWasOnFileBeforeCall(call({ metadata: '{bad' }), { id: 'c1', createdAt: null })).toBe(false);
  });

  test('the customer the call carried at ring time counts when it predates the call', async () => {
    const first = jest.fn().mockResolvedValue({ created_at: '2026-01-01T00:00:00Z' });
    db.mockReturnValueOnce({ where: () => ({ whereNull: () => ({ first }) }) });
    expect(await callerWasOnFileBeforeCall(call({ customer_id: 'c2' }), { id: 'c1', createdAt: '2026-01-02T00:00:00Z' })).toBe(true);
  });

  test('a failed customer read fails closed', async () => {
    const first = jest.fn().mockRejectedValue(new Error('boom'));
    db.mockReturnValueOnce({ where: () => ({ whereNull: () => ({ first }) }) });
    expect(await callerWasOnFileBeforeCall(call({ customer_id: 'c2' }), null)).toBe(false);
  });
});
