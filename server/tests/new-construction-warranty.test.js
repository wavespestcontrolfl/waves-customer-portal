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

describe('templateIssueWithWarnings (server-built warranty)', () => {
  const { templateIssueWithWarnings } = require('../services/new-construction-warranty');
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
    return templateIssueWithWarnings(KEY, body, cust, conn(row)).then(({ values }) => values);
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
    // An owner contract runs from the initial treatment date; the builder
    // lot (master agreement) cases set their own basis and final date.
    basis: { kind: 'signed', date: '09/01/2026' },
    issuer: { name: 'Pat Office', title: 'Office Manager' },
  };

  test('a builder lot runs from its final treatment date; an owner contract from the initial one', async () => {
    const master = { ...office, basis: { kind: 'master', date: '09/01/2026' } };
    await expect(issue({ projectId: project.id, values: master }, customer, project))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('final exterior treatment') });
    const finished = { ...project, findings: { ...findings, final_exterior_date: '2026-10-20' } };
    const v = await issue({ projectId: project.id, values: master }, customer, finished);
    expect(v.warranty).toMatchObject({ start_basis: 'final', start_date: '10/20/2026', term_end: '10/20/2027', renewal_due: '10/20/2027' });
    expect(v.warranty.contract_basis).toBe('Issued under the master agreement with Example Homes LLC dated 09/01/2026.');
    // The certificate's renewal date must match the term that counts from the final date.
    const initialBased = { ...finished, findings: { ...finished.findings, renewal_due: '2027-10-01' } };
    await expect(issue({ projectId: project.id, values: master }, customer, initialBased)).rejects.toMatchObject({ status: 409 });
    const owner = await issue({ projectId: project.id, values: office }, customer, finished);
    expect(owner.warranty).toMatchObject({ start_basis: 'initial', start_date: '10/01/2026', term_end: '10/01/2027' });
  });

  test('the master agreement caps a builder lot renewal fee at $149.00', async () => {
    const finished = { ...project, findings: { ...findings, final_exterior_date: '2026-10-20' } };
    const at = (renewal_fee, kind = 'master') => ({ ...office, warranty: { ...office.warranty, renewal_fee }, basis: { kind, date: '09/01/2026' } });
    await expect(issue({ projectId: project.id, values: at('$149.00') }, customer, finished)).resolves.toMatchObject({ warranty: { renewal_fee: '$149.00' } });
    await expect(issue({ projectId: project.id, values: at('$149.01') }, customer, finished))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('$149.00') });
    // An owner contract is not under the master agreement.
    await expect(issue({ projectId: project.id, values: at('$175.00', 'signed') }, customer, finished)).resolves.toMatchObject({ warranty: { renewal_fee: '$175.00' } });
  });

  test('other templates keep their own values', async () => {
    const values = { a: 1 };
    const result = await templateIssueWithWarnings('service_agreement.termite_bond_retreatment', { values }, customer, conn(null));
    expect(result).toEqual({ values, warnings: [] });
    expect(result.values).toBe(values);
  });

  test('builds the job fields from the saved certificate and takes only office fields', async () => {
    const v = await issue({ projectId: project.id, values: office }, customer, project);
    expect(v.treatment.product).toBe('Termidor SC');
    expect(v.treatment.initial_date).toBe('10/01/2026');
    expect(v.warranty.term_end).toBe('10/01/2027');
    expect(v.warranty.number).toBe('NCW-ABCD1234-0000-0000');
    expect(v.warranty.notice_location).toBe('beside the electric panel');
    expect(v.warranty.payer).toBe('Owner Test');
    expect(v.warranty.contract_basis).toBe('Signed by the owner or authorized agent before treatment, on 09/01/2026.');
    expect(v.warranty).toMatchObject({ start_basis: 'initial', start_date: '10/01/2026' });
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
    const draft = { ...project, sent_at: null, status: 'draft', pretreat_sent_snapshot: null };
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
    const lateNotice = { ...office, warranty: { ...office.warranty, consumer_notice_date: '09/15/2026' }, basis: { kind: 'signed', date: '09/01/2026' } };
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

  test('the warranty is issued only while the certificate is the version last sent; no sent copy is refused', async () => {
    const sentFindings = { ...findings, product_name: 'Termidor SC', gallons_applied: '180' };
    const sentCopy = JSON.stringify({ findings: sentFindings, project_date: '2026-10-01' });
    // Same content, keys in another order: still the sent version.
    const reordered = { ...project, findings: JSON.stringify(Object.fromEntries(Object.entries(sentFindings).reverse())), pretreat_sent_snapshot: sentCopy };
    await expect(issue({ projectId: project.id, values: office }, customer, reordered)).resolves.toMatchObject({ treatment: { gallons: '180' } });
    // Edited after the send (the owner's link shows the edit): send it again first.
    const editedAfter = { ...project, findings: JSON.stringify({ ...sentFindings, gallons_applied: '999' }), pretreat_sent_snapshot: sentCopy };
    await expect(issue({ projectId: project.id, values: office }, customer, editedAfter))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('changed after it was sent') });
    const redated = { ...project, findings: JSON.stringify(sentFindings), project_date: '2026-10-02', pretreat_sent_snapshot: sentCopy };
    await expect(issue({ projectId: project.id, values: office }, customer, redated)).rejects.toMatchObject({ status: 409 });
    // A legacy delivery (no sent_at) and a partial combined send (report out,
    // payer leg failed, not marked sent) both carry the copy, so both issue.
    for (const sentWithoutStamp of [{ sent_at: null, status: 'closed', delivery_status: 'legacy_sent' }, { sent_at: null, status: 'in_progress', delivery_status: 'partial' }]) {
      await expect(issue({ projectId: project.id, values: office }, customer, { ...project, ...sentWithoutStamp })).resolves.toBeTruthy();
    }
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
    const bait = { ...project, findings: { ...findings, treatment_method: 'Bait system' } };
    await expect(issue({ projectId: project.id, values: office }, customer, bait)).rejects.toMatchObject({ status: 409 });
    const lateBasis = { ...office, basis: { kind: 'signed', date: '10/05/2026' } };
    await expect(issue({ projectId: project.id, values: lateBasis }, customer, project)).rejects.toMatchObject({ status: 400 });
    const badNotice = { ...office, warranty: { ...office.warranty, consumer_notice_date: '2026-09-01' } };
    await expect(issue({ projectId: project.id, values: badNotice }, customer, project)).rejects.toMatchObject({ status: 400 });
  });
});

// Owner 10-24 Q6: the warranty names the job's method. Version 9 prints a
// soil job exactly as version 8 did; Bora-Care alone and soil + Bora-Care
// get their own section 3 paragraph and CONDITIONS lines.
describe('method wording (soil, Bora-Care only, soil + Bora-Care)', () => {
  const { templateIssueWithWarnings } = require('../services/new-construction-warranty');
  const { renderDocumentTemplate, buildCustomerDocumentContext } = require('../services/document-template-library');
  const { BODY_V8 } = require('../models/migrations/20261024211000_new_construction_warranty_start_date');
  const { BODY_V9 } = require('../models/migrations/20261024230000_new_construction_warranty_methods');
  const KEY = 'service_agreement.termite_new_construction_warranty';
  const customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Owner', address_line1: '1 Builder Office Rd', city: 'Sarasota', state: 'FL', zip: '34236' };
  const soil = {
    treatment_method: 'Soil barrier (chemical)', treatment_address: '12 Test Lane, Bradenton, FL 34202', builder_contractor: 'Example Homes LLC',
    product_name: 'Termidor SC', active_ingredient: 'fipronil', concentration_pct: '0.06', gallons_applied: '180', square_footage: '1800',
    applicator_name: 'Sam Tester', applicator_fdacs_id: 'JF000000', warranty_type: 'Builder 1-year, renewable yearly to year 5', wdo_target: ['Subterranean termites'],
  };
  // As the certificate form records Bora-Care: the product picker's chemistry
  // and no concentration or gallons (the form clears both for it).
  const boraCare = {
    ...soil, treatment_method: 'Wood treatment (borate)', product_name: 'Bora-Care', active_ingredient: 'Disodium octaborate tetrahydrate 40.0%',
    epa_registration: '64405-1', concentration_pct: '', gallons_applied: '', square_footage: '2400', wdo_target: ['Formosan subterranean termites'],
    framing_inspection_date: '2026-09-28', wood_base_plate_pct: '85',
  };
  const secondary = { treatment_method: 'Wood treatment (borate)', product_name: 'Bora-Care', epa_registration: '64405-1', active_ingredient: 'Disodium octaborate tetrahydrate 40.0%', concentration_pct: '', gallons_applied: '', square_footage: '1,800' };
  const combined = { ...soil, additional_applications: [secondary], borate_treatment_date: '2026-10-15' };
  const office = {
    warranty: { structures: 'The new home', notice_location: 'beside the electric panel', payer: 'Owner Test', treatment_price: '$1,250.00', plan_price: 'Included in the treatment price', renewal_fee: '99', consumer_notice_date: '09/01/2026' },
    basis: { kind: 'signed', date: '09/01/2026' },
    issuer: { name: 'Pat Office', title: 'Office Manager' },
  };
  const master = { ...office, basis: { kind: 'master', date: '09/01/2026' } };
  const row = (findings) => ({
    id: 'abcd1234-0000-0000', customer_id: 'cust-1', project_date: '2026-10-01', project_type: 'pre_treatment_termite_certificate',
    findings, pretreat_sent_snapshot: { findings, project_date: '2026-10-01' },
  });
  const conn = (project) => (table) => ({
    where() { return this; },
    forUpdate() { return this; },
    first: async () => (table === 'customers' ? customer : project),
  });
  const issue = (findings, values = office) => templateIssueWithWarnings(KEY, { projectId: 'abcd1234-0000-0000', values }, customer, conn(row(findings)))
    .then(({ values: printed }) => printed);
  const render = (body, values) => renderDocumentTemplate({ version: { title: 'Warranty', body }, context: buildCustomerDocumentContext(customer, values) });

  test('a soil job renders version 9 exactly as version 8, on both contract bases', async () => {
    for (const [findings, values] of [[soil, office], [{ ...soil, final_exterior_date: '2026-10-20' }, master]]) {
      const v = await issue(findings, values);
      const v8 = render(BODY_V8, v);
      const v9 = render(BODY_V9, v);
      expect(v9.unresolvedVariables).toEqual([]);
      expect(v9.body).toBe(v8.body);
    }
  });

  test('Bora-Care only prints its own paragraph and conditions, and runs from its one treatment date', async () => {
    const v = await issue(boraCare);
    expect(v.treatment).toMatchObject({ product: 'Bora-Care', active_ingredient: 'Disodium octaborate tetrahydrate 40.0%' });
    expect(v.treatment.description).toBe('A preventive borate wood treatment for subterranean termites during construction, applied to the structural wood as the primary treatment, as its label directs (Florida Building Code 1816.1 / R318.1; Rule 5E-14.106(6), F.A.C.). No termite infestation was known to be present. No soil-applied termiticide barrier was installed under or around the foundation. Product: Bora-Care (disodium octaborate tetrahydrate), EPA Reg. No. 64405-1, mixed as its label directs. Area treated: 2400 sq ft. Treatment date: 10/01/2026, after the final framing inspection on 09/28/2026. Wood base plates: 85% of all base plates. Applicator: Sam Tester, ID card JF000000.');
    expect(v.conditions.first).toMatch(/^Wood added, replaced or exposed after our treatment is not treated\./);
    expect(v.warranty).toMatchObject({ start_basis: 'initial', start_date: '10/01/2026', term_end: '10/01/2027' });
    const body = render(BODY_V9, v);
    expect(body.unresolvedVariables).toEqual([]);
    expect(body.body).toContain('INCLUDING FORMOSAN AND ASIAN SUBTERRANEAN TERMITES');
    expect(body.body).not.toMatch(/final exterior treatment|preventive soil treatment/i);
    // A builder lot has no later visit to wait for: its one treatment is its final one.
    await expect(issue(boraCare, master)).resolves.toMatchObject({ warranty: { start_basis: 'final', start_date: '10/01/2026' } });
    // Version 8's soil paragraph cannot render a Bora-Care job, even one
    // with hand-typed amounts: its final exterior line stays blank.
    expect(render(BODY_V8, v).unresolvedVariables).toContain('treatment.final_exterior_line');
    expect(render(BODY_V8, await issue({ ...boraCare, concentration_pct: '23', gallons_applied: '40' })).unresolvedVariables).toEqual(['treatment.final_exterior_line']);
  });

  test('Bora-Care only refuses what its label does not allow, with no override', async () => {
    for (const ok of [
      { wood_base_plate_pct: '60' }, { wood_base_plate_pct: '100%' }, { framing_inspection_date: '2026-10-01' }, { borate_treatment_date: '2026-10-01' },
      { product_name: 'Other', product_name_other: 'bora-care', active_ingredient: '' },
      // A linear-feet-only record, and a hand-typed amount the form would clear: neither changes the text's product line.
      { square_footage: '', linear_feet: '220 LF' }, { concentration_pct: '23', gallons_applied: '40' },
    ]) {
      const v = await issue({ ...boraCare, ...ok });
      expect(v.treatment.description).toContain('EPA Reg. No. 64405-1, mixed as its label directs. Area treated: ');
    }
    expect((await issue({ ...boraCare, square_footage: '', linear_feet: '220 LF' })).treatment.description).toContain('Area treated: 220 linear ft.');
    for (const [bad, said] of [
      [{ wood_base_plate_pct: '59.9' }, 'under 60%'],
      [{ wood_base_plate_pct: '' }, 'wood base plates'],
      [{ wood_base_plate_pct: 'most of them' }, 'wood base plates'],
      [{ framing_inspection_date: '' }, 'framing inspection'],
      [{ framing_inspection_date: '2026-10-02' }, 'second visit'],
      [{ final_exterior_date: '2026-10-05' }, 'not Bora-Care only'],
      [{ final_exterior_product: 'Termidor SC' }, 'not Bora-Care only'],
      [{ borate_treatment_date: '2026-10-03' }, 'Clear the separate'],
      [{ product_name: 'Termidor SC' }, 'written for Bora-Care'],
      [{ active_ingredient: 'fipronil' }, 'does not match Bora-Care'],
      [{ epa_registration: '7969-210' }, '64405-1'],
      [{ square_footage: '', linear_feet: '' }, 'square_footage or linear_feet'],
      [{ square_footage: 'the whole house' }, 'square_footage'],
    ]) {
      await expect(issue({ ...boraCare, ...bad })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(said) });
    }
  });

  test('soil + Bora-Care prints Bora-Care as the secondary treatment on its own date, with soil conditions', async () => {
    const v = await issue(combined);
    expect(v.treatment.description).toMatch(/^A preventive soil treatment for subterranean termites during construction\./);
    expect(v.treatment.description).toMatch(/ Applicator: Sam Tester, ID card JF000000\. Secondary treatment \(Rule 5E-14\.106\(9\), F\.A\.C\.\): Bora-Care \(disodium octaborate tetrahydrate\), EPA Reg\. No\. 64405-1, mixed as its label directs and applied to the structural wood on 10\/15\/2026\. Area treated: 1,800 sq ft\.$/);
    expect(v.conditions.first).toMatch(/^The final exterior treatment must be completed before the building is occupied\./);
    expect(v.conditions.third).toMatch(/^Call us before work that disturbs treated soil\..*This does not reduce the coverage of the soil barrier\.$/);
    expect(render(BODY_V9, v).unresolvedVariables).toEqual([]);
    // The soil barrier is primary: a builder lot still waits for its final exterior treatment.
    await expect(issue(combined, master)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('final exterior') });
    await expect(issue({ ...combined, final_exterior_date: '2026-10-20' }, master))
      .resolves.toMatchObject({ warranty: { start_basis: 'final', start_date: '10/20/2026' } });
    for (const [bad, said] of [
      [{ borate_treatment_date: '' }, 'date of the Bora-Care application'],
      [{ borate_treatment_date: '2026-09-30' }, 'between the treatment date and today'],
      [{ borate_treatment_date: '2099-01-01' }, 'between the treatment date and today'],
      [{ additional_applications: [{ ...secondary, product_name: 'Termidor SC' }] }, 'written for Bora-Care'],
      [{ additional_applications: [{ ...secondary, square_footage: '' }] }, 'square_footage or linear_feet'],
      [{ additional_applications: [{ ...secondary, concentration_pct: 'full strength' }] }, 'concentration_pct'],
      // The soil barrier is still a liquid: its concentration and gallons stay required.
      [{ gallons_applied: '' }, 'gallons_applied'],
    ]) {
      await expect(issue({ ...combined, ...bad })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(said) });
    }
  });

  test('a method with no wording is refused: bait, a Bora-Care primary with soil, two extra applications', async () => {
    const soilExtra = { ...secondary, treatment_method: 'Soil barrier (chemical)', product_name: 'Termidor SC', epa_registration: '', active_ingredient: 'fipronil' };
    for (const findings of [
      { ...soil, additional_applications: [{ ...secondary, treatment_method: 'Bait system', product_name: 'Trelona ATBB' }] },
      { ...boraCare, additional_applications: [soilExtra] },
      { ...combined, additional_applications: [secondary, secondary] },
    ]) {
      await expect(issue(findings)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('does not qualify') });
    }
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
