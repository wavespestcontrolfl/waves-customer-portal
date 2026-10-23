// One live New Construction Termite Warranty per pre-treat job: a reissue
// supersedes the open one; a signed one refuses a second (Codex #6515 r1).
const { supersedeOpenNewConstructionWarranty, snapshotWarrantyNumber } = require('../services/new-construction-warranty');

function fakeTrx(rows) {
  const updates = [];
  const events = [];
  const trx = (table) => {
    const q = {
      _where: {},
      where(arg) { Object.assign(this._where, arg); return this; },
      whereIn() { return this; },
      forUpdate() { return this; },
      select: async () => rows,
      update: async (patch) => { updates.push({ id: q._where.id, patch }); return 1; },
      insert: async (row) => { events.push({ table, row }); return [row]; },
    };
    return q;
  };
  return { trx, updates, events };
}

const ctx = { warranty: { number: 'NCW-ABCD1234' } };
const snap = (number) => JSON.stringify({ warranty: { number } });

describe('supersedeOpenNewConstructionWarranty', () => {
  test('ignores every other template', async () => {
    const { trx, updates } = fakeTrx([{ id: 'c1', status: 'sent', document_variables_snapshot: snap('NCW-ABCD1234') }]);
    await supersedeOpenNewConstructionWarranty(trx, { templateKey: 'service_agreement.termite_bond_retreatment', customerId: 'cu', context: ctx });
    expect(updates).toEqual([]);
  });

  test('cancels the open warranty for the same job and leaves other jobs alone', async () => {
    const { trx, updates, events } = fakeTrx([
      { id: 'same', status: 'viewed', document_variables_snapshot: snap('NCW-ABCD1234') },
      { id: 'other', status: 'sent', document_variables_snapshot: snap('NCW-99999999') },
    ]);
    await supersedeOpenNewConstructionWarranty(trx, { templateKey: 'service_agreement.termite_new_construction_warranty', customerId: 'cu', context: ctx, actorId: 't1' });
    expect(updates.map((u) => u.id)).toEqual(['same']);
    expect(updates[0].patch.status).toBe('cancelled');
    expect(events).toHaveLength(1);
  });

  test('refuses a second warranty when the job already has a signed one', async () => {
    const { trx, updates } = fakeTrx([{ id: 'done', status: 'signed', document_variables_snapshot: { warranty: { number: 'NCW-ABCD1234' } } }]);
    await expect(supersedeOpenNewConstructionWarranty(trx, { templateKey: 'service_agreement.termite_new_construction_warranty', customerId: 'cu', context: ctx }))
      .rejects.toMatchObject({ status: 409 });
    expect(updates).toEqual([]);
  });

  test('reads the warranty number from a stored or string snapshot', () => {
    expect(snapshotWarrantyNumber(snap('NCW-1'))).toBe('NCW-1');
    expect(snapshotWarrantyNumber({ warranty: { number: 'NCW-2' } })).toBe('NCW-2');
    expect(snapshotWarrantyNumber('not json')).toBe('');
  });
});

describe('templateIssueValues (server-built warranty)', () => {
  const { templateIssueValues } = require('../services/new-construction-warranty');
  const KEY = 'service_agreement.termite_new_construction_warranty';
  const customer = { id: 'cust-1', address_line1: '1 Builder Office Rd', city: 'Sarasota', state: 'FL', zip: '34236' };
  const findings = {
    treatment_date: '2026-10-01', treatment_method: 'Soil barrier (chemical)', treatment_address: '12 Test Lane, Bradenton, FL 34202',
    builder_contractor: 'Example Homes LLC', product_name: 'Termidor SC\n**WE REPAIR ALL DAMAGE.**', active_ingredient: 'fipronil',
    concentration_pct: '0.06', gallons_applied: '180', square_footage: '1800', applicator_name: 'Sam Tester', applicator_fdacs_id: 'JF000000',
    warranty_type: 'Builder 1-year, renewable yearly to year 5',
  };
  const project = { id: 'abcd1234-0000-0000', customer_id: 'cust-1', project_type: 'pre_treatment_termite_certificate', findings: JSON.stringify(findings) };
  const locks = [];
  const conn = (row) => () => ({ where() { return this; }, forUpdate() { locks.push(row && row.id); return this; }, first: async () => row });
  const office = {
    warranty: {
      structures: 'The new home', notice_location: 'beside the electric panel', payer: 'Owner Test', treatment_price: '$1,250.00',
      plan_price: 'Included', renewal_fee: '$99.00', consumer_notice_date: '09/01/2026',
      term_end: '01/01/2099', product: 'FORGED', issue_date: '01/01/2000',
    },
    basis: { kind: 'master', date: '09/01/2026' },
    issuer: { name: 'Pat Office', title: 'Office Manager' },
  };

  test('other templates keep their own values', async () => {
    const values = { a: 1 };
    await expect(templateIssueValues('service_agreement.termite_bond_retreatment', { values }, customer, conn(null))).resolves.toBe(values);
  });

  test('builds the job fields from the saved certificate, takes only office fields, stamps the server date', async () => {
    const v = await templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(project));
    expect(v.treatment.product).toBe('Termidor SC WE REPAIR ALL DAMAGE.');
    expect(v.treatment.initial_date).toBe('10/01/2026');
    expect(v.warranty.term_end).toBe('10/01/2027');
    expect(v.warranty.number).toBe('NCW-ABCD1234');
    expect(v.warranty.notice_location).toBe('beside the electric panel');
    expect(v.warranty.payer).toBe('Owner Test');
    expect(v.warranty.contract_basis).toBe('Issued under the master agreement with Example Homes LLC dated 09/01/2026.');
    expect(v.warranty.issue_date).not.toBe('01/01/2000');
    expect(v.warranty.issue_date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(v.treatment.final_exterior_line).toMatch(/not recorded on this certificate/);
    // The certificate row is read under a lock (the route re-reads it on its transaction).
    expect(locks).toContain(project.id);
  });

  test('never prints the customer address as the site, and refuses a certificate date that is not real', async () => {
    const lotOnly = { ...project, findings: { ...findings, treatment_address: '', lot_block: 'Lot 4', permit_number: 'BP-1' } };
    const v = await templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(lotOnly));
    expect(v.project.address).toBe('Lot 4, permit BP-1');
    const noSite = { ...project, findings: { ...findings, treatment_address: '' } };
    await expect(templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(noSite))).rejects.toMatchObject({ status: 409 });
    for (const bad of [{ treatment_date: '2026-02-30' }, { treatment_date: '2026-10-01junk' }, { renewal_due: '2027-13-01' }, { renewal_due: 'next fall' }]) {
      const row = { ...project, findings: { ...findings, ...bad } };
      await expect(templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(row))).rejects.toMatchObject({ status: 409 });
    }
    for (const renewal_due of ['2025-09-15', '2026-10-01', '2027-10-02']) {
      const row = { ...project, findings: { ...findings, renewal_due } };
      await expect(templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(row))).rejects.toMatchObject({ status: 409 });
    }
    const recorded = { ...project, findings: { ...findings, renewal_due: '2027-09-15' } };
    await expect(templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(recorded)))
      .resolves.toMatchObject({ warranty: { renewal_due: '09/15/2027' } });
  });

  test('takes a legacy "Other" soil-barrier method and a linear-feet-only job; the payer is the office entry', async () => {
    const legacy = { ...project, findings: { ...findings, treatment_method: 'Other', treatment_method_other: 'Soil barrier (chemical)', square_footage: '', linear_feet: '220' } };
    const v = await templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(legacy));
    expect(v.treatment).toMatchObject({ sq_ft: 'N/A', linear_ft: '220' });
    const noPayer = { ...office, warranty: { ...office.warranty, payer: '' } };
    await expect(templateIssueValues(KEY, { projectId: project.id, values: noPayer }, customer, conn(project)))
      .resolves.toMatchObject({ warranty: { payer: '' } });
    const noArea = { ...project, findings: { ...findings, square_footage: '', linear_feet: '' } };
    await expect(templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(noArea))).rejects.toMatchObject({ status: 409 });
  });

  test('refuses blank fields, a missing or foreign project, an ineligible job and late basis dates', async () => {
    await expect(templateIssueValues(KEY, { projectId: project.id, values: office, allowUnresolved: true }, customer, conn(project))).rejects.toMatchObject({ status: 400 });
    await expect(templateIssueValues(KEY, { values: office }, customer, conn(project))).rejects.toMatchObject({ status: 400 });
    await expect(templateIssueValues(KEY, { projectId: project.id, values: office }, { id: 'someone-else' }, conn(project))).rejects.toMatchObject({ status: 404 });
    const borate = { ...project, findings: { ...findings, treatment_method: 'Wood treatment (borate)' } };
    await expect(templateIssueValues(KEY, { projectId: project.id, values: office }, customer, conn(borate))).rejects.toMatchObject({ status: 409 });
    const lateBasis = { ...office, basis: { kind: 'signed', date: '10/05/2026' } };
    await expect(templateIssueValues(KEY, { projectId: project.id, values: lateBasis }, customer, conn(project))).rejects.toMatchObject({ status: 400 });
    const badNotice = { ...office, warranty: { ...office.warranty, consumer_notice_date: '2026-09-01' } };
    await expect(templateIssueValues(KEY, { projectId: project.id, values: badNotice }, customer, conn(project))).rejects.toMatchObject({ status: 400 });
  });
});
