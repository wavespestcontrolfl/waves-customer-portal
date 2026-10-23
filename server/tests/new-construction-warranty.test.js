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

// The certificate send gate lives in the projects route; its own suite
// covers it. Here it reads ready unless a test says otherwise.
const mockReadiness = jest.fn(() => ({ missing: [] }));
jest.mock('../routes/admin-projects', () => ({ _private: { evaluateProjectSendReadiness: (...args) => mockReadiness(...args) } }));

describe('templateIssueValues (server-built warranty)', () => {
  const { templateIssueValues } = require('../services/new-construction-warranty');
  const KEY = 'service_agreement.termite_new_construction_warranty';
  const customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Owner', address_line1: '1 Builder Office Rd', city: 'Sarasota', state: 'FL', zip: '34236' };
  const findings = {
    treatment_date: '2026-10-01', treatment_method: 'Soil barrier (chemical)', treatment_address: '12 Test Lane, Bradenton, FL 34202',
    builder_contractor: 'Example Homes LLC', product_name: 'Termidor SC', active_ingredient: 'fipronil',
    concentration_pct: '0.06', gallons_applied: '180', square_footage: '1800', applicator_name: 'Sam Tester', applicator_fdacs_id: 'JF000000',
    warranty_type: 'Builder 1-year, renewable yearly to year 5', wdo_target: ['Subterranean termites'],
  };
  const project = { id: 'abcd1234-0000-0000', customer_id: 'cust-1', project_date: '2026-10-01', sent_at: '2026-10-02T12:00:00Z', project_type: 'pre_treatment_termite_certificate', findings: JSON.stringify(findings) };
  const locks = [];
  let lockedCustomer;
  const CATALOG = { 'termidor sc': { name: 'Termidor SC', active_ingredient: 'Fipronil 9.1%' }, 'taurus sc': { name: 'Taurus SC', active_ingredient: '' } };
  // The row the lock returns is the row the caller passed, unless a test
  // sets lockedCustomer to model an edit that committed in between.
  const issue = (body, cust, row, lockedRow = cust) => {
    lockedCustomer = lockedRow;
    return templateIssueValues(KEY, body, cust, conn(row));
  };
  const conn = (row) => (table) => ({
    where() { return this; },
    whereRaw(sql, [name]) { this._product = name; return this; },
    forUpdate() { locks.push(table === 'customers' ? 'customer' : row && row.id); return this; },
    async first() {
      if (table === 'customers') return lockedCustomer;
      if (table === 'products_catalog') return CATALOG[this._product] || null;
      // Each certificate row carries its as-sent copy built from its own
      // fields, unless a test sets pretreat_sent_snapshot itself.
      if (row && !('pretreat_sent_snapshot' in row)) {
        return { ...row, pretreat_sent_snapshot: { findings: row.findings, project_date: row.project_date } };
      }
      return row;
    },
  });
  const office = {
    warranty: {
      structures: 'The new home', notice_location: 'beside the electric panel', payer: 'Owner Test', treatment_price: '$1,250.00',
      plan_price: 'Included in the treatment price', renewal_fee: '99', consumer_notice_date: '09/01/2026',
      term_end: '01/01/2099', product: 'FORGED', issue_date: '01/01/2000',
    },
    basis: { kind: 'master', date: '09/01/2026' },
    issuer: { name: 'Pat Office', title: 'Office Manager' },
  };

  test('other templates keep their own values', async () => {
    const values = { a: 1 };
    await expect(templateIssueValues('service_agreement.termite_bond_retreatment', { values }, customer, conn(null))).resolves.toBe(values);
  });

  test('builds the job fields from the saved certificate and takes only office fields', async () => {
    const v = await issue({ projectId: project.id, values: office }, customer, project);
    expect(v.treatment.product).toBe('Termidor SC');
    expect(v.treatment.initial_date).toBe('10/01/2026');
    expect(v.warranty.term_end).toBe('10/01/2027');
    expect(v.warranty.number).toBe('NCW-ABCD1234-0000-0000');
    expect(v.warranty.notice_location).toBe('beside the electric panel');
    expect(v.warranty.payer).toBe('Owner Test');
    expect(v.warranty.contract_basis).toBe('Issued under the master agreement with Example Homes LLC dated 09/01/2026.');
    // The server stamps Waves' signing date; a posted one is ignored.
    expect(v.warranty.issue_date).not.toBe('01/01/2000');
    expect(v.warranty.issue_date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(v.warranty.term_end).toBe('10/01/2027');
    expect(v.treatment.final_exterior_line).toMatch(/not recorded on this certificate/);
    // Customer row first, then the certificate row: the merge path's order.
    expect(locks.slice(-2)).toEqual(['customer', project.id]);
  });

  test('never prints the customer address as the site, and refuses a certificate date that is not real', async () => {
    const lotOnly = { ...project, findings: { ...findings, treatment_address: '', lot_block: 'Lot 4', permit_number: 'BP-1' } };
    const v = await issue({ projectId: project.id, values: office }, customer, lotOnly);
    expect(v.project.address).toBe('Lot 4, permit BP-1');
    const noSite = { ...project, findings: { ...findings, treatment_address: '' } };
    await expect(issue({ projectId: project.id, values: office }, customer, noSite)).rejects.toMatchObject({ status: 409 });
    const subdivisionOnly = { ...project, findings: { ...findings, treatment_address: '', lot_block: '', subdivision: 'Test Grove' } };
    await expect(issue({ projectId: project.id, values: office }, customer, subdivisionOnly)).rejects.toMatchObject({ status: 409 });
    const future = { ...project, project_date: '2099-01-01', findings: { ...findings, treatment_date: '' } };
    await expect(issue({ projectId: project.id, values: office }, customer, future)).rejects.toMatchObject({ status: 409 });
    for (const bad of [{ treatment_date: '2026-02-30' }, { treatment_date: '2026-10-01junk' }, { renewal_due: '2027-13-01' }, { renewal_due: 'next fall' }]) {
      const row = { ...project, findings: { ...findings, ...bad } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).rejects.toMatchObject({ status: 409 });
    }
    for (const renewal_due of ['2025-09-15', '2026-10-01', '2027-09-15', '2027-10-02']) {
      const row = { ...project, findings: { ...findings, renewal_due } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).rejects.toMatchObject({ status: 409 });
    }
    const recorded = { ...project, findings: { ...findings, renewal_due: '2027-10-01' } };
    await expect(issue({ projectId: project.id, values: office }, customer, recorded))
      .resolves.toMatchObject({ warranty: { renewal_due: '10/01/2027' } });
    // project_date is the treatment date; a legacy findings date that disagrees stops the issue.
    const twoDates = { ...project, findings: { ...findings, treatment_date: '2026-11-15' } };
    await expect(issue({ projectId: project.id, values: office }, customer, twoDates)).rejects.toMatchObject({ status: 409 });
    const projectDateOnly = { ...project, findings: { ...findings, treatment_date: '' } };
    await expect(issue({ projectId: project.id, values: office }, customer, projectDateOnly))
      .resolves.toMatchObject({ treatment: { initial_date: '10/01/2026' } });
  });

  test('screens every printed value: an access code or a "safe" claim is refused by field name', async () => {
    const coded = { ...office, warranty: { ...office.warranty, notice_location: 'garage panel, gate code 1234' } };
    await expect(issue({ projectId: project.id, values: coded }, customer, project))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('warranty.notice_location') });
    const claim = { ...project, findings: { ...findings, builder_contractor: 'Pet-safe Homes LLC' } };
    await expect(issue({ projectId: project.id, values: office }, customer, claim))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('project.builder') });
  });

  test('refuses a non-subterranean target and an out-of-order final exterior date; strips units the template prints', async () => {
    for (const wdo_target of [['Drywood termites'], [], '', JSON.stringify(['Wood-decay fungi'])]) {
      const row = { ...project, findings: { ...findings, wdo_target } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).rejects.toMatchObject({ status: 409 });
    }
    const both = { ...project, findings: { ...findings, wdo_target: JSON.stringify(['Drywood termites', 'Formosan subterranean termites']) } };
    await expect(issue({ projectId: project.id, values: office }, customer, both)).resolves.toBeTruthy();
    for (const final_exterior_date of ['2026-09-30', '2099-01-01']) {
      const row = { ...project, findings: { ...findings, final_exterior_date } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).rejects.toMatchObject({ status: 409 });
    }
    const unitized = { ...project, findings: { ...findings, concentration_pct: '0.060%', gallons_applied: '180 gallons', square_footage: '1800 sq ft', linear_feet: '220 LF' } };
    const v = await issue({ projectId: project.id, values: office }, customer, unitized);
    expect(v.treatment).toMatchObject({ concentration: '0.060', gallons: '180', sq_ft: '1800', linear_ft: '220' });
    const described = { ...project, findings: { ...findings, gallons_applied: '180 gal applied', square_footage: '1,800 sq ft treated', linear_feet: 'about 220 LF' } };
    const d = await issue({ projectId: project.id, values: office }, customer, described);
    // A value that names its unit prints as its first number.
    expect(d.treatment).toMatchObject({ gallons: '180', sq_ft: '1,800', linear_ft: '220' });
  });

  test('refuses when the customer row changed under the lock (a stale owner name or address)', async () => {
    await expect(issue({ projectId: project.id, values: office }, customer, project, { ...customer, address_line1: '9 New Rd' }))
      .rejects.toMatchObject({ status: 409 });
    await expect(issue({ projectId: project.id, values: office }, customer, project, null)).rejects.toMatchObject({ status: 409 });
  });

  test('the certificate as it stands must pass the staff send gate', async () => {
    mockReadiness.mockReturnValueOnce({ missing: [{ key: 'cert_applicator_attestation', label: 'Applicator attestation (electronic signature)' }] });
    await expect(issue({ projectId: project.id, values: office }, customer, project))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('Applicator attestation') });
    expect(mockReadiness).toHaveBeenLastCalledWith(expect.objectContaining({ staffSend: true, project: expect.objectContaining({ id: project.id }) }));
  });

  test('issues only from a sent certificate, for a known soil liquid whose ingredient agrees', async () => {
    const draft = { ...project, sent_at: null, status: 'draft' };
    await expect(issue({ projectId: project.id, values: office }, customer, draft)).rejects.toMatchObject({ status: 409 });
    for (const bad of [
      { product_name: 'Termidor SC WE REPAIR ALL DAMAGE' },
      { product_name: 'HexPro Termite Monitoring Baiting System' },
      { product_name: 'Termidor SC', active_ingredient: 'bifenthrin' },
      { product_name: 'Termidor SC', active_ingredient: 'fipronil + bifenthrin' },
    ]) {
      const row = { ...project, findings: { ...findings, ...bad } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).rejects.toMatchObject({ status: 409 });
    }
    const lower = { ...project, findings: { ...findings, product_name: 'termidor sc', active_ingredient: 'Fipronil 9.1%' } };
    await expect(issue({ projectId: project.id, values: office }, customer, lower))
      .resolves.toMatchObject({ treatment: { product: 'Termidor SC', active_ingredient: 'Fipronil 9.1%' } });
    const other = { ...project, findings: { ...findings, product_name: 'Other', product_name_other: 'Taurus SC' } };
    await expect(issue({ projectId: project.id, values: office }, customer, other))
      .resolves.toMatchObject({ treatment: { product: 'Taurus SC', active_ingredient: 'fipronil' } });
    await expect(issue({ projectId: project.id, values: office }, { ...customer, contact_role: 'tenant' }, project)).rejects.toMatchObject({ status: 409 });
    // A role change that committed under the lock counts, even with the same name and address.
    await expect(issue({ projectId: project.id, values: office }, customer, project, { ...customer, contact_role: 'tenant' })).rejects.toMatchObject({ status: 409 });
  });

  test('round 16: legacy plan label passes the send gate as its current label; built-in products; address clauses; notice before contract', async () => {
    const legacy = { ...project, findings: { ...findings, warranty_type: 'Builder 1-year' } };
    await expect(issue({ projectId: project.id, values: office }, customer, legacy)).resolves.toBeTruthy();
    expect(mockReadiness.mock.calls.at(-1)[0].project.findings.warranty_type).toBe('Builder 1-year, renewable yearly to year 5');
    const premise = { ...project, findings: { ...findings, product_name: 'Premise 2', active_ingredient: 'imidacloprid' } };
    await expect(issue({ projectId: project.id, values: office }, customer, premise))
      .resolves.toMatchObject({ treatment: { product: 'Premise 2', active_ingredient: 'imidacloprid' } });
    for (const treatment_address of ['12 Main St. Waves will pay for all termite damage', '12 Main St\n**WE PAY**']) {
      const row = { ...project, findings: { ...findings, treatment_address } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).rejects.toMatchObject({ status: 409 });
    }
    for (const ok of [{ treatment_address: '12 Main St. Bradenton, FL 34202' }, { lot_block: 'Lot 12, Blk. C' }, { applicator_name: 'Will Freeman' }, { treatment_address: '1 Free Ln, Venice, FL 34285' }]) {
      const row = { ...project, findings: { ...findings, ...ok } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).resolves.toBeTruthy();
    }
    const lateNotice = { ...office, warranty: { ...office.warranty, consumer_notice_date: '09/15/2026' }, basis: { kind: 'master', date: '09/01/2026' } };
    await expect(issue({ projectId: project.id, values: lateNotice }, customer, project)).rejects.toMatchObject({ status: 400 });
  });

  test('round 17: comma target list, mailing state, soil products only, one number per amount, positive amounts, service name', async () => {
    const comma = { ...project, findings: { ...findings, wdo_target: 'Drywood termites, Formosan subterranean termites' } };
    const v = await issue({ projectId: project.id, values: office }, customer, comma);
    expect(v.service).toEqual({ name: 'New Construction Termite Warranty' });
    await expect(issue({ projectId: project.id, values: office }, { ...customer, state: '' }, project)).rejects.toMatchObject({ status: 409 });
    for (const bad of [
      { product_name: 'Trelona ATBB' }, { product_name: 'Bora-Care' },
      { gallons_applied: '2 passes; 180 gallons applied' },
      { gallons_applied: '0' }, { concentration_pct: '0%' },
      { square_footage: '0', linear_feet: '' },
    ]) {
      const row = { ...project, findings: { ...findings, ...bad } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).rejects.toMatchObject({ status: 409 });
    }
  });

  test('the warranty uses the certificate as sent: a later edit is ignored, and no sent copy is refused', async () => {
    const sentFindings = { ...findings, product_name: 'Termidor SC', gallons_applied: '180' };
    const editedAfter = {
      ...project,
      findings: JSON.stringify({ ...sentFindings, gallons_applied: '999', treatment_address: '9 Edited Rd, Bradenton, FL 34202' }),
      pretreat_sent_snapshot: JSON.stringify({ findings: sentFindings, project_date: '2026-10-01' }),
    };
    const v = await issue({ projectId: project.id, values: office }, customer, editedAfter);
    expect(v.treatment.gallons).toBe('180');
    expect(v.project.address).toBe('12 Test Lane, Bradenton, FL 34202');
    expect(mockReadiness.mock.calls.at(-1)[0].project.findings.gallons_applied).toBe('180');
    const legacy = { ...project, sent_at: null, status: 'closed', delivery_status: 'legacy_sent' };
    await expect(issue({ projectId: project.id, values: office }, customer, legacy)).resolves.toBeTruthy();
    const noCopy = { ...project, pretreat_sent_snapshot: null };
    await expect(issue({ projectId: project.id, values: office }, customer, noCopy)).rejects.toMatchObject({ status: 409 });
  });

  test('certificate fields are short values, never clauses', async () => {
    for (const bad of [
      { product_name: 'Termidor SC\n**WE REPAIR ALL DAMAGE.**' },
      { product_name: 'Termidor SC. We repair all damage' },
      { active_ingredient: 'fipronil!' },
      { applicator_name: 'x'.repeat(121) },
      { gallons_applied: 'about 180' },
      { applicator_fdacs_id: 'card on file' },
    ]) {
      const row = { ...project, findings: { ...findings, ...bad } };
      await expect(issue({ projectId: project.id, values: office }, customer, row)).rejects.toMatchObject({ status: 409 });
    }
    const builder = { ...project, findings: { ...findings, builder_contractor: 'Example Homes, Inc.' } };
    await expect(issue({ projectId: project.id, values: office }, customer, builder)).resolves.toBeTruthy();
  });

  test('needs a complete owner name: first and last, or a company alone', async () => {
    for (const name of [{ last_name: null }, { first_name: '', last_name: '' }, { last_name: '', company_name: 'Example Homes LLC' }]) {
      await expect(issue({ projectId: project.id, values: office }, { ...customer, ...name }, project)).rejects.toMatchObject({ status: 409 });
    }
    await expect(issue({ projectId: project.id, values: office }, { ...customer, first_name: '', last_name: '', company_name: 'Example Homes LLC' }, project))
      .resolves.toBeTruthy();
  });

  test('accepts only the two contract bases', async () => {
    for (const kind of [undefined, 'Signed', 'oral']) {
      const values = { ...office, basis: { kind, date: '09/01/2026' } };
      await expect(issue({ projectId: project.id, values }, customer, project)).rejects.toMatchObject({ status: 400 });
    }
    const signed = { ...office, basis: { kind: 'signed', date: '09/01/2026' } };
    await expect(issue({ projectId: project.id, values: signed }, customer, project))
      .resolves.toMatchObject({ warranty: { contract_basis: 'Signed by the owner or authorized agent before treatment, on 09/01/2026.' } });
  });

  test('needs the owner\'s full mailing address and prints the configured license', async () => {
    for (const gap of [{ address_line1: '' }, { city: null }, { zip: '' }]) {
      await expect(issue({ projectId: project.id, values: office }, { ...customer, ...gap }, project)).rejects.toMatchObject({ status: 409 });
    }
    await expect(issue({ projectId: project.id, values: office }, { ...customer, address_line1: '12 Test Lane, gate code 1234' }, project))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('address_line1') });
    const { WAVES_FDACS_LICENSE_NUMBER } = require('../constants/business');
    await expect(issue({ projectId: project.id, values: office }, customer, project))
      .resolves.toMatchObject({ issuer: { license: WAVES_FDACS_LICENSE_NUMBER } });
  });

  test('prices are exact dollar amounts, printed as $1,250.00; the plan price may be included', async () => {
    const v = await issue({ projectId: project.id, values: office }, customer, project);
    expect(v.warranty).toMatchObject({ treatment_price: '$1,250.00', renewal_fee: '$99.00', plan_price: 'Included in the treatment price' });
    const prepaid = { ...office, warranty: { ...office.warranty, plan_price: '2400.5' } };
    await expect(issue({ projectId: project.id, values: prepaid }, customer, project))
      .resolves.toMatchObject({ warranty: { plan_price: '$2,400.50' } });
    for (const [field, value] of [['treatment_price', 'TBD'], ['treatment_price', '$100-$150'], ['renewal_fee', ''], ['plan_price', 'Included']]) {
      const values = { ...office, warranty: { ...office.warranty, [field]: value } };
      await expect(issue({ projectId: project.id, values }, customer, project)).rejects.toMatchObject({ status: 400 });
    }
  });

  test('takes a legacy "Other" soil-barrier method and a linear-feet-only job; the payer is the office entry', async () => {
    const legacy = { ...project, findings: { ...findings, treatment_method: 'Other', treatment_method_other: 'Soil barrier (chemical)', square_footage: '', linear_feet: '220' } };
    const v = await issue({ projectId: project.id, values: office }, customer, legacy);
    expect(v.treatment).toMatchObject({ sq_ft: 'N/A', linear_ft: '220' });
    const noPayer = { ...office, warranty: { ...office.warranty, payer: '' } };
    await expect(issue({ projectId: project.id, values: noPayer }, customer, project))
      .resolves.toMatchObject({ warranty: { payer: '' } });
    const noArea = { ...project, findings: { ...findings, square_footage: '', linear_feet: '' } };
    await expect(issue({ projectId: project.id, values: office }, customer, noArea)).rejects.toMatchObject({ status: 409 });
  });

  test('refuses blank fields, a missing or foreign project, an ineligible job and late basis dates', async () => {
    await expect(issue({ projectId: project.id, values: office, allowUnresolved: true }, customer, project)).rejects.toMatchObject({ status: 400 });
    await expect(issue({ values: office }, customer, project)).rejects.toMatchObject({ status: 400 });
    for (const override of [{ propertyAddress: 'gate code 1234' }, { recipientName: 'Someone Else' }]) {
      await expect(issue({ projectId: project.id, values: office, ...override }, customer, project)).rejects.toMatchObject({ status: 400 });
    }
    await expect(issue({ projectId: project.id, values: office }, { id: 'someone-else' }, project)).rejects.toMatchObject({ status: 404 });
    const borate = { ...project, findings: { ...findings, treatment_method: 'Wood treatment (borate)' } };
    await expect(issue({ projectId: project.id, values: office }, customer, borate)).rejects.toMatchObject({ status: 409 });
    const lateBasis = { ...office, basis: { kind: 'signed', date: '10/05/2026' } };
    await expect(issue({ projectId: project.id, values: lateBasis }, customer, project)).rejects.toMatchObject({ status: 400 });
    const badNotice = { ...office, warranty: { ...office.warranty, consumer_notice_date: '2026-09-01' } };
    await expect(issue({ projectId: project.id, values: badNotice }, customer, project)).rejects.toMatchObject({ status: 400 });
  });
});

describe('assertConfirmedRender (staff read the exact text)', () => {
  const { assertConfirmedRender, renderHash, NEW_CONSTRUCTION_WARRANTY_KEY } = require('../services/new-construction-warranty');
  test('the warranty issues only with the hash of the text being created', () => {
    const text = 'WARRANTY BODY';
    expect(() => assertConfirmedRender(NEW_CONSTRUCTION_WARRANTY_KEY, { confirmedRenderHash: renderHash(text) }, text)).not.toThrow();
    expect(() => assertConfirmedRender(NEW_CONSTRUCTION_WARRANTY_KEY, {}, text)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => assertConfirmedRender(NEW_CONSTRUCTION_WARRANTY_KEY, { confirmedRenderHash: renderHash(text) }, `${text} changed`))
      .toThrow(expect.objectContaining({ status: 409 }));
    expect(() => assertConfirmedRender('service_agreement.termite_bond_retreatment', {}, text)).not.toThrow();
  });
});

describe('issueDeliveryState (draft until really sent)', () => {
  const { issueDeliveryState, NEW_CONSTRUCTION_WARRANTY_KEY } = require('../services/new-construction-warranty');
  test('the warranty is created as a draft with no link and no sent stamp', () => {
    const state = issueDeliveryState(NEW_CONSTRUCTION_WARRANTY_KEY, 'tok', new Date('2026-11-06T00:00:00Z'));
    expect(state).toEqual({
      fields: { status: 'draft', share_token_hash: null, share_token_expires_at: null, shared_at: null },
      linkCreated: false,
      signingUrl: null,
    });
  });
  test('every other template keeps its created-and-shared row', () => {
    const expiresAt = new Date('2026-11-06T00:00:00Z');
    const now = new Date('2026-10-23T12:00:00Z');
    const state = issueDeliveryState('service_agreement.termite_bond_retreatment', 'tok', expiresAt, now);
    expect(state.fields).toMatchObject({ status: 'sent', share_token_expires_at: expiresAt, shared_at: now });
    expect(state.fields.share_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state).toMatchObject({ linkCreated: true, signingUrl: expect.stringContaining('tok') });
  });
});
