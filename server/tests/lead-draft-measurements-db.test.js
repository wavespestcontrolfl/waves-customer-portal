/**
 * The lead draft background re-price (GATE_LEAD_DRAFT_PROPERTY_LOOKUP)
 * against a real estimates row: one live lookup for a draft still on the
 * default size, then a re-price through the real draft builder, written only
 * while the row is exactly as the webhook created it. The lookup is stubbed
 * (no network); the rows are this suite's own, removed after. It refuses any
 * database but a private QA one or CI's.
 */
process.env.GATE_LEAD_ESTIMATE_AUTOMATION = 'true'; // read once, when feature-gates loads
jest.mock('../routes/property-lookup-v2', () => ({ performPropertyLookup: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('lead draft background re-price (live Postgres)', () => {
  let db;
  let performPropertyLookup;
  let runLeadDraftPropertyLookup;
  let scheduleLeadDraftPropertyLookup;
  let buildAutomatedLeadDraftEstimate;
  let evaluateLeadEstimateAutomationReadiness;
  let estimateEditVersion;
  const ids = [];
  const ADDRESS = '4521 Synthetic Palm Dr, Venice, FL 34285';

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    ({ performPropertyLookup } = require('../routes/property-lookup-v2'));
    ({ runLeadDraftPropertyLookup, scheduleLeadDraftPropertyLookup } = require('../services/lead-draft-measurements'));
    ({ buildAutomatedLeadDraftEstimate, evaluateLeadEstimateAutomationReadiness } = require('../services/lead-estimate-automation'));
    ({ estimateEditVersion } = require('../services/admin-estimate-persistence'));
  });
  beforeEach(() => { process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP = 'true'; });
  afterEach(() => {
    delete process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP;
    performPropertyLookup.mockReset();
  });
  afterAll(async () => {
    if (db && ids.length) await db('estimates').whereIn('id', ids).del();
  });

  const countyLookup = () => ({
    propertyRecord: {
      propertyType: 'Single Family',
      squareFootage: 1850,
      yearBuilt: 1998,
      _source: 'county',
      _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 9200, landUseDescription: 'SINGLE FAMILY DETACHED' },
      _fieldEvidence: { squareFootage: { sourceType: 'county' } },
    },
    enriched: {},
  });
  const lead = () => {
    const intake = {
      serviceInterest: 'Quarterly Pest Control',
      email: 'lead@example.com',
      fullAddress: ADDRESS,
      normalizedAddress: { line1: '4521 Synthetic Palm Dr', city: 'Venice', state: 'FL', zip: '34285', fullAddress: ADDRESS },
    };
    return { intake, customer: {}, body: {}, readiness: evaluateLeadEstimateAutomationReadiness({ intake, phone: '+19415550142' }) };
  };
  const rebuildFor = (inputs) => jest.fn((measurements) => buildAutomatedLeadDraftEstimate({ ...inputs, measurements }));

  // The row the webhook inserts for a draft priced on the defaults (the real
  // builder, gate off, so it reads no cache).
  async function webhookDraft() {
    const inputs = lead();
    delete process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP;
    const draft = await buildAutomatedLeadDraftEstimate(inputs);
    process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP = 'true';
    expect(draft.automation.sizeSource).toBe('default');
    const [row] = await db('estimates').insert({
      customer_name: 'Pat Synthetic',
      customer_phone: '+19415550142',
      address: ADDRESS,
      monthly_total: draft.monthly || null,
      annual_total: draft.annual || null,
      onetime_total: draft.oneTimeTotal || null,
      status: 'draft',
      source: 'lead_webhook',
      pricing_authority: draft.automation.status === 'generated' ? 'SERVER' : null,
      service_interest: 'Quarterly Pest Control',
      estimate_data: JSON.stringify(draft.estimateData),
      notes: 'Form: synthetic lead draft test.',
    }).returning('*');
    ids.push(row.id);
    return { row, inputs, draft };
  }
  const reread = (id) => db('estimates').where({ id }).first();
  const automationOf = (row) => (typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data).automation;

  test('an untouched default-size draft is re-priced on the county size, through the same builder', async () => {
    const { row, inputs, draft: original } = await webhookDraft();
    performPropertyLookup.mockResolvedValue(countyLookup());
    const rebuild = rebuildFor(inputs);

    expect(await runLeadDraftPropertyLookup({ estimateId: row.id, address: ADDRESS, rebuild })).toEqual({ outcome: 'repriced' });
    // One live lookup under the lead draft caller: persisted, so the triage
    // rebuild and the estimate tool reuse it from the cache.
    expect(performPropertyLookup).toHaveBeenCalledTimes(1);
    expect(performPropertyLookup).toHaveBeenCalledWith(ADDRESS, {});
    expect(rebuild).toHaveBeenCalledWith({ homeSqFt: 1850, lotSqFt: 9200, source: 'county_assessed' });

    const after = await reread(row.id);
    const automation = automationOf(after);
    expect(automation.draftEstimateAutomation).toMatchObject({
      sizeSource: 'county_assessed',
      measurements: { source: 'county_assessed', homeSqFt: 1850, lotSqFt: 9200 },
      engineInput: expect.objectContaining({ homeSqFt: 1850, lotSqFt: 9200, lotSizeMeasured: true }),
    });
    expect(automation.leadEstimateAutomation.review).toContain('property_measurements_from_county');
    expect(automation.leadEstimateAutomation.review).not.toContain('property_measurements_defaulted');
    const repriced = await rebuildFor(inputs)({ homeSqFt: 1850, lotSqFt: 9200, source: 'county_assessed' });
    expect(Number(after.monthly_total || 0)).toBe(Number(repriced.monthly || 0));
    expect(after.pricing_authority).toBe(repriced.automation.status === 'generated' ? 'SERVER' : null);
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(after.created_at).getTime());
    // Only the price and its record change.
    expect(after).toMatchObject({ status: 'draft', source: 'lead_webhook', address: ADDRESS, notes: row.notes, service_interest: row.service_interest });
    expect(original.automation.engineInput).toMatchObject({ homeSqFt: 2000, lotSqFt: 8000 });

    // Done once: the re-priced row is no longer a default-size draft.
    performPropertyLookup.mockClear();
    expect(await runLeadDraftPropertyLookup({ estimateId: row.id, address: ADDRESS, rebuild })).toEqual({ skipped: 'not_eligible' });
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });

  test('a write during the lookup wins, even one that does not stamp updated_at', async () => {
    for (const stampsUpdatedAt of [false, true]) {
      const { row, inputs } = await webhookDraft();
      performPropertyLookup.mockImplementation(async () => {
        await db('estimates').where({ id: row.id }).update({ monthly_total: 99, ...(stampsUpdatedAt ? { updated_at: db.fn.now() } : {}) });
        return countyLookup();
      });
      expect(await runLeadDraftPropertyLookup({ estimateId: row.id, address: ADDRESS, rebuild: rebuildFor(inputs) })).toEqual({ outcome: 'changed' });
      const after = await reread(row.id);
      expect(Number(after.monthly_total)).toBe(99);
      expect(automationOf(after).draftEstimateAutomation.sizeSource).toBe('default');
    }
  });

  test('a draft written before the step starts is left alone, with no lookup spent', async () => {
    const { row, inputs } = await webhookDraft();
    await db('estimates').where({ id: row.id }).update({ updated_at: db.raw("created_at + interval '1 second'") });
    expect(await runLeadDraftPropertyLookup({ estimateId: row.id, address: ADDRESS, rebuild: rebuildFor(inputs) })).toEqual({ skipped: 'not_eligible' });
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });

  test('no trusted county size, a failed lookup, or a rebuild that did not use it leaves the row as it was', async () => {
    const cases = [
      [() => performPropertyLookup.mockResolvedValue({ propertyRecord: { ...countyLookup().propertyRecord, propertyType: 'Condo' }, enriched: {} }), (inputs) => rebuildFor(inputs), 'no_trusted_size'],
      [() => performPropertyLookup.mockRejectedValue(Object.assign(new Error('provider down'), { code: 'ETIMEDOUT' })), (inputs) => rebuildFor(inputs), 'lookup_failed'],
      // A lead that stated a size (here the rebuild's own body) never takes the county's.
      [() => performPropertyLookup.mockResolvedValue(countyLookup()), (inputs) => rebuildFor({ ...inputs, body: { homeSqFt: 2400 } }), 'not_rebuilt'],
    ];
    for (const [arrange, rebuild, outcome] of cases) {
      const { row, inputs } = await webhookDraft();
      arrange();
      const before = estimateEditVersion(await reread(row.id));
      expect(await runLeadDraftPropertyLookup({ estimateId: row.id, address: ADDRESS, rebuild: rebuild(inputs) })).toEqual({ outcome });
      expect(estimateEditVersion(await reread(row.id))).toBe(before);
      performPropertyLookup.mockReset();
    }
  });

  test('gate off: nothing is scheduled, read or spent', async () => {
    const { row, inputs } = await webhookDraft();
    delete process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP;
    const rebuild = rebuildFor(inputs);
    expect(await runLeadDraftPropertyLookup({ estimateId: row.id, address: ADDRESS, rebuild })).toEqual({ skipped: 'disabled' });
    scheduleLeadDraftPropertyLookup({ estimateId: row.id, address: ADDRESS, rebuild });
    await new Promise((resolve) => setImmediate(resolve));
    expect(performPropertyLookup).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
  });

  test('the webhook\'s scheduled call re-prices in the background', async () => {
    const { row, inputs } = await webhookDraft();
    performPropertyLookup.mockResolvedValue(countyLookup());
    scheduleLeadDraftPropertyLookup({ estimateId: row.id, address: ADDRESS, rebuild: rebuildFor(inputs) });
    let sizeSource = 'default';
    for (let i = 0; i < 40 && sizeSource === 'default'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sizeSource = automationOf(await reread(row.id)).draftEstimateAutomation.sizeSource;
    }
    expect(sizeSource).toBe('county_assessed');
  });
});
