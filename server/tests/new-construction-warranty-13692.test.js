// New Construction Termite Warranty and the FDACS-13692 consumer notice (GATE_WARRANTY_13692_CHECK, owner
// 2026-10-24, Rule 5E-14.105(1)): a notice on file supplies the printed date; with none, the typed date works
// through the grace end (2026-11-24) with a warning, then the issue refuses. Gate off = the typed date only.
// Synthetic data only.
const mockReadiness = jest.fn(() => ({ missing: [] }));
jest.mock('../routes/admin-projects', () => ({ _private: { evaluateProjectSendReadiness: (...args) => mockReadiness(...args) } }));
const mockFind = jest.fn();
jest.mock('../services/consumer-notices', () => ({
  ...jest.requireActual('../services/consumer-notices'),
  findConsumerNotice: (...args) => mockFind(...args),
}));

const { templateIssueWithWarnings } = require('../services/new-construction-warranty');

const KEY = 'service_agreement.termite_new_construction_warranty';
const customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Owner', address_line1: '1 Builder Office Rd', city: 'Sarasota', state: 'FL', zip: '34236' };
const findings = {
  treatment_date: '2026-10-01', treatment_method: 'Soil barrier (chemical)', treatment_address: '12 Test Lane, Bradenton, FL 34202',
  builder_contractor: 'Example Homes LLC', product_name: 'Termidor SC', active_ingredient: 'fipronil',
  concentration_pct: '0.06', gallons_applied: '180', square_footage: '1800', applicator_name: 'Sam Tester', applicator_fdacs_id: 'JF000000',
  warranty_type: 'Builder 1-year, renewable yearly to year 5', wdo_target: ['Subterranean termites'],
  // A builder lot (master basis) runs from its final treatment date.
  final_exterior_date: '2026-10-20',
};
const project = { id: 'abcd1234-0000-0000', customer_id: 'cust-1', project_date: '2026-10-01', sent_at: '2026-10-02T12:00:00Z', project_type: 'pre_treatment_termite_certificate', findings: JSON.stringify(findings) };
const conn = (table) => ({
  where() { return this; },
  whereRaw(sql, [name]) { this._product = name; return this; },
  forUpdate() { return this; },
  async first() {
    if (table === 'customers') return customer;
    if (table === 'products_catalog') return { name: 'Termidor SC', active_ingredient: 'Fipronil 9.1%' };
    return { ...project, pretreat_sent_snapshot: { findings: project.findings, project_date: project.project_date } };
  },
});
const office = (noticeDate = '09/01/2026', basisDate = '09/01/2026') => ({
  projectId: project.id,
  values: {
    warranty: { structures: 'The new home', notice_location: 'beside the electric panel', payer: 'Owner Test', treatment_price: '$1,250.00', plan_price: 'Included in the treatment price', renewal_fee: '99', consumer_notice_date: noticeDate },
    basis: { kind: 'master', date: basisDate },
    issuer: { name: 'Pat Office', title: 'Office Manager' },
  },
});
const issue = (body) => templateIssueWithWarnings(KEY, body, customer, conn);
// The grace end is an Eastern date: 16:00 UTC is the same day in Eastern time.
const onDay = (day) => jest.useFakeTimers({ now: new Date(`${day}T16:00:00Z`), doNotFake: ['nextTick', 'setImmediate'] });

afterEach(() => { jest.useRealTimers(); delete process.env.GATE_WARRANTY_13692_CHECK; mockFind.mockReset(); });

describe('gate off', () => {
  test('uses the typed date exactly as before and never looks for a notice', async () => {
    onDay('2027-01-01');
    const { values, warnings } = await issue(office('08/15/2026'));
    expect(values.warranty.consumer_notice_date).toBe('08/15/2026');
    expect(warnings).toEqual([]);
    expect(mockFind).not.toHaveBeenCalled();
    await expect(issue(office('10/05/2026'))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/on or before the treatment date/) });
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_WARRANTY_13692_CHECK = 'true'; });

  test('a notice on file prints its signed date, the typed value is ignored, and there is no warning', async () => {
    mockFind.mockResolvedValue({ source: 'esign', id: 'e1', signedOn: '08/20/2026' });
    onDay('2027-03-01');
    const { values, warnings } = await issue(office('garbage'));
    expect(values.warranty.consumer_notice_date).toBe('08/20/2026');
    expect(warnings).toEqual([]);
    // Looks for a notice on or before the earlier of the contract basis date and the treatment date.
    expect(mockFind.mock.calls[0][1]).toBe('cust-1');
    expect(mockFind.mock.calls[0][2]).toEqual({ onOrBefore: { y: 2026, m: 9, d: 1 } });
  });

  test('the treatment date limits the lookup when it is the earlier one', async () => {
    mockFind.mockResolvedValue({ source: 'paper', id: 'p1', signedOn: '09/01/2026' });
    onDay('2026-10-24');
    await issue(office('', '10/01/2026'));
    expect(mockFind.mock.calls[0][2]).toEqual({ onOrBefore: { y: 2026, m: 10, d: 1 } });
  });

  test('none on file through the grace end: the typed date still works and the preview carries a warning', async () => {
    mockFind.mockResolvedValue(null);
    for (const day of ['2026-10-24', '2026-11-24']) {
      onDay(day);
      const { values, warnings } = await issue(office('08/15/2026'));
      expect(values.warranty.consumer_notice_date).toBe('08/15/2026');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/No signed FDACS-13692/);
      expect(warnings[0]).toMatch(/11\/24\/2026/);
    }
    // The typed date keeps its own checks.
    onDay('2026-10-24');
    await expect(issue(office('09/15/2026'))).rejects.toMatchObject({ status: 400 });
  });

  test('none on file after the grace end: refuses with 409', async () => {
    mockFind.mockResolvedValue(null);
    onDay('2026-11-25');
    await expect(issue(office('08/15/2026'))).rejects.toMatchObject({
      status: 409,
      message: 'Get the FDACS-13692 consumer notice signed (send it from Document Requests, or upload the paper form) on or before the contract basis date, then issue the warranty.',
    });
  });

  test('preview and issue print the same text: the same inputs give the same values', async () => {
    mockFind.mockResolvedValue({ source: 'paper', id: 'p1', signedOn: '08/20/2026' });
    onDay('2026-10-24');
    const preview = await issue(office('08/15/2026'));
    const locked = await issue(office('08/15/2026'));
    expect(locked.values).toEqual(preview.values);
  });

  test('a basis date that is not a date stops before any lookup', async () => {
    await expect(issue(office('08/15/2026', 'soon'))).rejects.toMatchObject({ status: 400 });
    expect(mockFind).not.toHaveBeenCalled();
  });
});
