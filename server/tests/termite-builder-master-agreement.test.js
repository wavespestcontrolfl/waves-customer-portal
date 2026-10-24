// Builder Master Agreement and Lot Order (Rule 5E-14.105(3)(c), (2)(i)) and
// the warranty version that names its start date (owner 10-24 Q3, Q5).
const { MASTER, LOT_ORDER } = require('../models/migrations/20261024210000_seed_termite_builder_master_agreement');
const { BODY_V8, VARIABLES_V8 } = require('../models/migrations/20261024211000_new_construction_warranty_start_date');
const { renderDocumentTemplate } = require('../services/document-template-library');
const { templateIssueValues, BUILDER_MASTER_AGREEMENT_KEY, BUILDER_LOT_ORDER_KEY } = require('../services/new-construction-warranty');

const usedVars = (body) => [...new Set([...body.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].sort();

function filledContext(variables) {
  const context = {};
  for (const key of variables) {
    const parts = key.split('.');
    let node = context;
    parts.slice(0, -1).forEach((p) => { node[p] = node[p] || {}; node = node[p]; });
    node[parts[parts.length - 1]] = `<${key}>`;
  }
  return context;
}

describe('builder master agreement and lot order templates', () => {
  test.each([['master agreement', MASTER], ['lot order', LOT_ORDER]])('%s declares exactly the fields it uses and renders with none left', (_, spec) => {
    expect(usedVars(spec.body)).toEqual([...spec.variables].sort());
    const rendered = renderDocumentTemplate({ template: spec, version: { title: spec.title, body: spec.body }, context: filledContext(spec.variables) });
    expect(rendered.unresolvedVariables).toEqual([]);
    expect(rendered.body).not.toContain('{{');
    expect(spec.requires_signature).toBe(true);
  });

  test('both carry the bold retreatment-only and organism statements (F.S. 482.227)', () => {
    for (const spec of [MASTER, LOT_ORDER]) {
      expect(spec.body).toContain('**THE WARRANTY FOR EACH LOT IS FOR RETREATMENT ONLY. NO DAMAGE REPAIR IS OFFERED.**');
      expect(spec.body).toContain('INCLUDING FORMOSAN AND ASIAN SUBTERRANEAN TERMITES. DOES NOT COVER DRYWOOD TERMITES');
    }
    expect(MASTER.body).toContain('**8. CONDITIONS AND LIMITATIONS**');
  });

  test('the master agreement states the rule terms the owner chose', () => {
    // (3)(a): issued within 30 days of the final treatment, at least one year.
    expect(MASTER.body).toContain('within 30 days of that lot\'s final treatment date');
    expect(MASTER.body).toContain('It runs for at least one year from that date.');
    // (3)(b): 4 more years, and the $149.00 cap the warranty code enforces.
    expect(MASTER.body).toContain('for 4 more years after the first year (through year 5), and we cannot refuse those renewals');
    expect(MASTER.body).toContain('not more than $149.00 a year');
    // (2)(i): a dollar total per lot; (1): FDACS-13692 before the agreement; (9)(c): 60 + 60 days.
    expect(MASTER.body).toContain('Each Lot Order states the total price for that lot in dollars');
    expect(MASTER.body).toContain('signed the Consumer Notice Form FDACS-13692 on {{agreement.consumer_notice_date}}, before this agreement');
    expect(MASTER.body).toContain('within 60 days, and the holder has 60 days to correct it');
  });
});

describe('warranty version 8 names its start date', () => {
  test('replaces only the start-date sentence and declares its fields', () => {
    expect(BODY_V8).toContain('This warranty runs from the {{warranty.start_basis}} treatment date, {{warranty.start_date}}.');
    expect(BODY_V8).not.toContain('This warranty runs from the initial treatment date');
    expect(usedVars(BODY_V8)).toEqual([...VARIABLES_V8].sort());
  });
});

describe('builder document values', () => {
  const customer = { id: 'cust-1' };
  const issuer = { name: 'Pat Office', title: 'Office Manager' };
  const master = { agreement: { price_schedule: '$0.18 per sq ft of slab, $350.00 minimum per lot', consumer_notice_date: '10/01/2026' }, issuer };
  const lot = {
    lot: {
      agreement_date: '10/01/2026', lot_block: 'Lot 4, Block C', subdivision: 'Test Grove', address: '12 Test Lane, Bradenton, FL 34202',
      permit: 'BP-1', structures: 'The new building and its attached garage', treatment: 'Liquid soil treatment, pre-slab and final exterior',
      price_total: '387', price_basis: '2,150 sq ft slab at $0.18 per sq ft', disturbed_soil_price: '$95', renewal_fee: '$149', scheduled_date: '12/01/2026',
    },
    issuer,
  };

  test('the master agreement takes one-line values, a real past FDACS-13692 date, and Waves signs today', async () => {
    const v = await templateIssueValues(BUILDER_MASTER_AGREEMENT_KEY, { values: { ...master, issuer: { ...issuer, date: '01/01/2000' } } }, customer);
    expect(v.agreement).toEqual(master.agreement);
    expect(v.issuer.date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(v.issuer.date).not.toBe('01/01/2000');
    for (const consumer_notice_date of ['2026-10-01', '13/01/2026', '01/01/2099']) {
      await expect(templateIssueValues(BUILDER_MASTER_AGREEMENT_KEY, { values: { ...master, agreement: { ...master.agreement, consumer_notice_date } } }, customer))
        .rejects.toMatchObject({ status: 400 });
    }
    const clause = { ...master, agreement: { ...master.agreement, price_schedule: 'Free. Waves will pay for all damage' } };
    await expect(templateIssueValues(BUILDER_MASTER_AGREEMENT_KEY, { values: clause }, customer)).rejects.toMatchObject({ status: 400 });
    await expect(templateIssueValues(BUILDER_MASTER_AGREEMENT_KEY, { values: master, allowUnresolved: true }, customer)).rejects.toMatchObject({ status: 400 });
  });

  test('a lot order prints dollar amounts and caps the renewal fee at $149.00', async () => {
    const v = await templateIssueValues(BUILDER_LOT_ORDER_KEY, { values: lot }, customer);
    expect(v.lot).toMatchObject({ price_total: '$387.00', disturbed_soil_price: '$95.00', renewal_fee: '$149.00', scheduled_date: '12/01/2026' });
    const over = { ...lot, lot: { ...lot.lot, renewal_fee: '$150' } };
    await expect(templateIssueValues(BUILDER_LOT_ORDER_KEY, { values: over }, customer))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('$149.00') });
    for (const patch of [{ price_total: 'about 400' }, { agreement_date: '01/01/2099' }, { scheduled_date: 'next month' }, { structures: '' }]) {
      await expect(templateIssueValues(BUILDER_LOT_ORDER_KEY, { values: { ...lot, lot: { ...lot.lot, ...patch } } }, customer))
        .rejects.toMatchObject({ status: 400 });
    }
    await expect(templateIssueValues(BUILDER_LOT_ORDER_KEY, { values: { ...lot, issuer: {} } }, customer)).rejects.toMatchObject({ status: 400 });
  });
});
