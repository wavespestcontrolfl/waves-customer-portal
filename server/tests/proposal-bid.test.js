jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('This unit test must not access a database'); });
  db.raw = jest.fn(); db.fn = { now: jest.fn() };
  return db;
});
const { normalizeProposal, computeProposalTotals } = require('../services/estimate-proposal');
const { buildProposalFirstInvoice } = require('../services/proposal-win');
const { estimateExpiresAt } = require('../services/admin-estimate-persistence');
const { proposalExpiry, assertBidSendDate, validateBidFields, normalizeProjectCosting, assertBidScheduleDate, earliestScheduledDelivery, latestReachableSchedule } = require('../services/proposal-bid');
const { computeProjectCosts, costRowOccurrences, roundCents, showsLineBasis, programRevenueIssue, proposalRevenueIssue } = require('../../shared/proposal-bid.cjs');

const line = (id, quantity, unitPrice, unit = 'acre') => ({ id, description: `Synthetic ${id}`, quantity, unitPrice, unit, frequency: 'one_time' });
const estimate = (lines, extra = {}) => ({ estimate_data: { proposal: { enabled: true, validThrough: '2026-12-21', buildings: [{ name: 'Synthetic property', lineItems: lines }], ...extra }, proposalCosting: { privateMarker: 'PRIVATE_COST_DO_NOT_RENDER' } } });
const normalized = (lines, extra) => normalizeProposal(estimate(lines, extra));

describe('bid quantity and costing authority', () => {
  test.each([[1, 10.075, 10.08], [146.5, 0.15, 21.98], [0.5, 2.01, 1.01], [1, 10.0749, 10.07], [1, 10.0751, 10.08], [1999899.9999, 50.0001, 99995199.98], [1999899.9999, 49.9999, 99994800.01]])('rounds %s × %s once to %s through persisted proposal and invoice totals', (quantity, price, expected) => {
    const proposal = normalized([line('half-cent', quantity, price)]);
    expect(proposal.buildings[0].lineItems[0].amount).toBe(expected);
    expect(computeProposalTotals(proposal).oneTime).toBe(expected);
    expect(buildProposalFirstInvoice(proposal).subtotal).toBe(expected);
  });
  test.each([
    [{ quantity: 1, unitPrice: 95 }, false],
    [{ quantity: 1, unitPrice: 10.075 }, true],
    [{ quantity: 1, unitPrice: 0.0755 }, true],
    [{ quantity: 2, unitPrice: 95 }, true],
    [{ quantity: 1, unit: 'each', unitPrice: 95 }, true],
  ])('customer documents show the basis for %o: %s', (line, shown) => {
    expect(showsLineBasis(line)).toBe(shown);
  });
  test('rounds decimal half cents without magnitude-dependent binary drift', () => {
    expect([10.075, -10.075, 1.005, 0.00000001].map(roundCents)).toEqual([10.08, -10.08, 1.01, 0]);
  });
  test('unknown or incomplete costs do not imply a zero-cost project and 100% margin', () => {
    expect(computeProjectCosts({ rows: [] }, { oneTime: 10000 })).toMatchObject({ profit: null, marginPercent: null, costsComplete: false });
    expect(computeProjectCosts({ rows: [{ description: 'Awaiting supplier price', quantity: 1, unitCost: '', occurrences: 1 }] }, { oneTime: 10000 })).toMatchObject({ profit: null, marginPercent: null });
  });
  test('margins are withheld while the quoted itemization would be refused by the save (GH codex P2 r8 on #4270)', () => {
    const rows = [{ description: 'Labor', phase: '', category: 'labor', unit: 'hour', quantity: 10, unitCost: 50, occurrences: 1 }];
    expect(computeProjectCosts({ rows }, { oneTime: 1000 })).toMatchObject({ costsComplete: true, profit: 500 });
    expect(computeProjectCosts({ rows }, { oneTime: 1000 }, { revenueIssue: 'Each program needs a whole-number service frequency between 1 and 52 visits per year.' })).toMatchObject({ costsComplete: false, profit: null, marginPercent: null });
    expect(programRevenueIssue({ frequencyPerYear: 4.5, pricePerApplication: 100 })).toMatch(/whole-number service frequency/);
    expect(programRevenueIssue({ frequencyPerYear: 53, pricePerApplication: 100 })).toMatch(/whole-number service frequency/);
    expect(programRevenueIssue({ frequencyPerYear: 4, pricePerApplication: 0.001 })).toMatch(/at least \$0\.01, in whole cents/);
    expect(programRevenueIssue({ frequencyPerYear: 4, pricePerApplication: 100 })).toBeNull();
    expect(proposalRevenueIssue({ programs: [{ frequencyPerYear: 12, pricePerApplication: 80 }], correctiveWork: [{ amount: 10.005 }] })).toMatch(/whole-cent/);
    expect(proposalRevenueIssue({ buildings: [{ lineItems: [{ quantity: 1, unitPrice: -5 }] }] })).toMatch(/negative/);
    expect(proposalRevenueIssue({ buildings: [{ lineItems: [{ description: 'Monthly', quantity: 1, unitPrice: 5 }] }], programs: [], correctiveWork: [{ amount: 10 }] })).toBeNull();
    // A priced line with a blank description is dropped by the save but
    // summed by the sidebar (GH codex P2 r9 on #4270); a blank default line
    // at $0 is not revenue and stays fine.
    expect(proposalRevenueIssue({ buildings: [{ lineItems: [{ description: 'Quarterly', quantity: 1, unitPrice: 200 }, { description: '  ', quantity: 2, unitPrice: 50 }] }] })).toMatch(/need a description before they count toward revenue/);
    expect(proposalRevenueIssue({ buildings: [{ lineItems: [{ description: 'Quarterly', quantity: 1, unitPrice: 200 }, { description: '', quantity: 1, unitPrice: 0 }] }] })).toBeNull();
  });
  test.each([
    { quantity: '1.00001' }, { quantity: '' }, { quantity: 1000000001 },
    { unitPrice: '1.00001' }, { unitPrice: '' }, { unitPrice: 100000000 }, { unit: 'unsupported' },
  ])('withholds margins when a described building line is unsaveable: %o', (invalid) => {
    const proposal = { buildings: [{ lineItems: [line('valid', 1, 200), { ...line('invalid', 1, 50), ...invalid }] }] };
    const revenueIssue = proposalRevenueIssue(proposal);
    expect(revenueIssue).toBeTruthy();
    expect(validateBidFields(proposal)).toBe(revenueIssue);
    const rows = [{ category: 'labor', description: 'Synthetic cost', quantity: 1, unit: 'hour', unitCost: 10, occurrences: 1 }];
    expect(computeProjectCosts({ rows }, { oneTime: 250 }, { revenueIssue })).toMatchObject({ costsComplete: false, profit: null, marginPercent: null });
  });
  test('accepts saved building precision and omitted legacy quantity/price defaults for margins', () => {
    expect(proposalRevenueIssue({ buildings: [{ lineItems: [line('valid', '1.2345000', '1.2345e2'), { description: 'Legacy defaults' }] }] })).toBeNull();
  });
  test.each(['annualRecurring', 'monthlyEquivalent', 'oneTime'])('withholds margins when the %s aggregate exceeds storage capacity', (key) => {
    const rows = [{ category: 'labor', description: 'Synthetic cost', quantity: 1, unit: 'hour', unitCost: 10, occurrences: 1 }];
    expect(computeProjectCosts({ rows }, { [key]: 99999999.99 })).toMatchObject({ costsComplete: true });
    expect(computeProjectCosts({ rows }, { [key]: 120000000 })).toMatchObject({ costsComplete: false, profit: null, marginPercent: null });
  });
  test.each([
    [99000000, 1000000, 1, 0, false, false, false],
    [95000000, 1000000, 1, 0.07, true, false, false],
    [95000000, 1000000, 1, 0.07, false, true, true],
    [24000000, 1000000, 4, 0.07, true, true, true],
    [98999999.99, 1000000, 1, 0, false, false, true],
  ])('cost margins follow the exact first invoice bound for program %s/corrective %s/cadence %s/tax %s', (price, corrective, frequency, taxRate, programTaxable, workTaxable, saveable) => {
    const proposal = normalizeProposal({ estimate_data: { proposal: { enabled: true, taxRate,
      programs: [{ label: 'Synthetic program', pricePerApplication: price, frequencyPerYear: frequency, taxable: programTaxable }],
      correctiveWork: [{ label: 'Synthetic corrective work', amount: corrective, taxable: workTaxable }],
    } } });
    const invoice = buildProposalFirstInvoice(proposal);
    expect(invoice.subtotal <= 99999999.99 && invoice.total <= 99999999.99).toBe(saveable);
    const issue = proposalRevenueIssue(proposal);
    if (saveable) expect(issue).toBeNull();
    else expect(issue).toMatch(/combined acceptance invoice/);
    const rows = [{ category: 'labor', description: 'Synthetic cost', quantity: 1, unit: 'hour', unitCost: 10, occurrences: 1 }];
    const costs = computeProjectCosts({ rows }, computeProposalTotals(proposal), { revenueIssue: issue });
    expect(costs.costsComplete).toBe(saveable);
    if (!saveable) expect(costs).toMatchObject({ profit: null, marginPercent: null });
  });
  test('individually valid building inputs cannot show margins for an overflowing quote', () => {
    const proposal = normalized([line('large', 2, 60000000)]);
    const rows = [{ category: 'labor', description: 'Synthetic cost', quantity: 1, unit: 'hour', unitCost: 10, occurrences: 1 }];
    expect(validateBidFields(proposal)).toBeNull();
    expect(computeProjectCosts({ rows }, computeProposalTotals(proposal), { revenueIssue: proposalRevenueIssue({ buildings: proposal.buildings }) }))
      .toMatchObject({ costsComplete: false, profit: null, marginPercent: null });
  });
  test.each([['', null], ['abc', null], [0, null], [31, null], [2.5, null], ['3', 3], [undefined, 1]])('a present revenue period of %s never silently compares one year (GH codex P2 on #4270)', (revenueYears, expected) => {
    const rows = [{ category: 'labor', description: 'Synthetic complete cost', quantity: 1, unit: 'hour', unitCost: 10, occurrences: 1 }];
    const result = computeProjectCosts(revenueYears === undefined ? { rows } : { revenueYears, rows }, { oneTime: 100, annualRecurring: 50 });
    expect(result.revenueYears).toBe(expected);
    if (expected == null) expect(result).toMatchObject({ revenue: null, profit: null, marginPercent: null, costsComplete: false, cost: 10 });
    else expect(result).toMatchObject({ revenue: 100 + 50 * expected, profit: 90 + 50 * expected, costsComplete: true });
  });
  test.each([[146.5, 0.15, 1, 21.98], [1, 1.005, 2, 2.01], [2, 1.0075, 5, 10.08]])('rounds the complete project cost %s × %s × %s only once', (quantity, unitCost, occurrences, expected) => {
    const costing = { rows: [{ category: 'labor', description: 'Synthetic fractional cost', quantity, unit: 'hour', unitCost, occurrences }] };
    expect(computeProjectCosts(costing, { oneTime: 100 })).toMatchObject({ cost: expected, profit: roundCents(100 - expected) });
  });
  test.each([
    ['occurrences above 1,000', { occurrences: 1001 }],
    ['a five-decimal quantity', { quantity: 1.00001 }],
    ['a five-decimal unit cost', { unitCost: '0.00001' }],
    ['an extended cost above the cap', { quantity: 1000000, unitCost: 100, occurrences: 1 }],
    ['an unknown category', { category: 'misc' }],
    ['an unknown unit', { unit: 'bag' }],
    ['a blank description', { description: '  ' }],
  ])('a cost sheet with %s is incomplete in the UI exactly as the save would refuse it (GH codex P2 r2 on #4270)', (name, patch) => {
    const row = { category: 'labor', description: 'Synthetic cost', quantity: 1, unit: 'hour', unitCost: 10, occurrences: 1, ...patch };
    const summary = computeProjectCosts({ revenueYears: 1, rows: [row] }, { oneTime: 100 });
    expect(summary.costsComplete).toBe(false);
    expect(summary.profit).toBeNull();
    expect(validateBidFields({ buildings: [] }, { revenueYears: 1, rows: [row] })).toEqual(expect.any(String));
  });
  test('keeps fractional acres, sub-cent square-foot rates, and per-line cent rounding through reload and invoice billing', () => {
    const proposal = normalized([line('acre', 25.8, 100), line('slab', 14768, 0.0755, 'sqft'), line('fraction', 0.125, 1.08, 'gal')]);
    expect(proposal.buildings[0].lineItems.map((row) => row.amount)).toEqual([2580, 1114.98, 0.14]);
    expect(proposal.buildings[0].lineItems[0].quantity).toBe(25.8);
    expect(proposal.buildings[0].lineItems[1].unitPrice).toBe(0.0755);
    const reloaded = normalizeProposal({ estimate_data: JSON.stringify({ proposal }) });
    expect(reloaded).toEqual(proposal);
    expect(computeProposalTotals(reloaded).oneTime).toBe(3695.12);
    const invoice = buildProposalFirstInvoice(reloaded);
    expect(invoice.subtotal).toBe(3695.12);
    expect(invoice.lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)).toBeCloseTo(invoice.subtotal, 2);
    expect(invoice.lineItems[0].description).toContain('25.8 acres × $100.00');
    expect(invoice.lineItems[1].description).toContain('14,768 sq ft × $0.0755');
    expect(JSON.stringify(proposal)).not.toContain('PRIVATE_COST_DO_NOT_RENDER');
  });
  test.each([0, -1, Infinity, NaN, null, true, '', 0.00001, 25.12345, 1.00000001, '1.0000000000000000001', '1e-5'])('rejects invalid quantity %s before normalization', (quantity) => {
    expect(validateBidFields({ buildings: [{ lineItems: [line('a', quantity, 10)] }] })).toMatch(/quantit/i);
  });
  test.each([null, true, Infinity, '', 1.23456, 1.00000001, '0.0000000000000000001'])('rejects invalid unit price %s before normalization', (unitPrice) => {
    expect(validateBidFields({ buildings: [{ lineItems: [line('a', 1, unitPrice)] }] })).toMatch(/Unit prices/);
  });
  test.each([1.2345, 0.1 + 0.2, 99999999.99, '1.2345000', '1000e-5', '.1234', '1.2345e2'])('accepts four-decimal values and minimal numeric roundoff: %s', (value) => {
    expect(validateBidFields({ buildings: [{ lineItems: [line('a', value, value)] }] })).toBeNull();
  });
  test('costs all crew hours, trips, and warranty occurrences without engine caps or invented allowances', () => {
    const costing = { revenueYears: 1, rows: [
      { category: 'labor', phase: 'Phase A', description: 'Crew hours', quantity: 40, unit: 'hour', unitCost: 35, occurrences: 4 },
      { category: 'travel', phase: 'All phases', description: 'Travel', quantity: 1, unit: 'trip', unitCost: 85, occurrences: 4 },
      { category: 'warranty', phase: 'Five-year obligation', description: 'Warranty allowance', quantity: 1, unit: 'each', unitCost: 120, occurrences: 5 },
    ] };
    expect(validateBidFields({}, costing)).toBeNull();
    expect(computeProjectCosts(normalizeProjectCosting(costing), { oneTime: 10000 })).toMatchObject({ cost: 6540, revenue: 10000, profit: 3460, marginPercent: 34.6 });
    expect(computeProjectCosts({ ...costing, revenueYears: 5 }, { oneTime: 10000, annualRecurring: 500 }).revenue).toBe(12500);
    expect(validateBidFields({}, { ...costing, rows: [{ ...costing.rows[0], occurrences: 1.5 }] })).toMatch(/occurrences/);
  });
});

describe('fixed bid validity', () => {
  test.each([
    ['2026-09-22', '2026-09-23T03:59:59.999Z'],
    ['2026-12-21', '2026-12-22T04:59:59.999Z'],
    ['2026-03-07', '2026-03-08T04:59:59.999Z'],
    ['2026-03-08', '2026-03-09T03:59:59.999Z'],
    ['2026-11-01', '2026-11-02T04:59:59.999Z'],
  ])('honors the full Eastern calendar day %s, including DST', (validThrough, expected) => {
    const row = estimate([line('a', 25.8, 100)], { validThrough });
    expect(proposalExpiry(row).toISOString()).toBe(expected);
    expect(estimateExpiresAt(() => new Date('2026-09-01T12:00:00Z'), row).toISOString()).toBe(expected);
    expect(estimateExpiresAt(() => new Date('2026-09-20T12:00:00Z'), row).toISOString()).toBe(expected);
  });
  test('scheduled sends are judged at the first five-minute scheduler tick they can reach', () => {
    expect(earliestScheduledDelivery(new Date('2026-09-23T03:55:00.000Z')).toISOString()).toBe('2026-09-23T03:55:00.000Z');
    expect(earliestScheduledDelivery(new Date('2026-09-23T03:55:00.001Z')).toISOString()).toBe('2026-09-23T04:00:00.000Z');
    expect(earliestScheduledDelivery(new Date('2026-09-23T03:58:30.000Z')).toISOString()).toBe('2026-09-23T04:00:00.000Z');
    expect(latestReachableSchedule(new Date('2026-09-23T03:59:59.999Z')).toISOString()).toBe('2026-09-23T03:55:00.000Z');
    expect(latestReachableSchedule(new Date('2026-09-23T04:00:00.000Z')).toISOString()).toBe('2026-09-23T04:00:00.000Z');
    const row = estimate([line('a', 1, 10)], { validThrough: '2026-09-22' });
    expect(() => assertBidScheduleDate(row, new Date('2026-09-23T03:55:00Z'))).not.toThrow();
    expect(() => assertBidScheduleDate(row, new Date('2026-09-23T03:58:00Z'))).toThrow(/too close to the end of the bid validity day/);
    expect(() => assertBidScheduleDate(row, new Date('2026-09-23T04:00:00Z'))).toThrow(/validity date has passed/);
    expect(() => assertBidScheduleDate(estimate([line('a', 1, 10)]), new Date('2026-09-23T03:58:00Z'))).not.toThrow();
  });
  test('retains the seven-day legacy send window and rejects expired or impossible bid dates', () => {
    expect(estimateExpiresAt(() => new Date('2026-09-01T12:00:00Z')).toISOString()).toBe('2026-09-08T12:00:00.000Z');
    const row = estimate([line('a', 1, 10)], { validThrough: '2026-09-22' });
    expect(() => assertBidSendDate(row, new Date('2026-09-23T04:00:00Z'))).toThrow(/validity date has passed/);
    expect(() => assertBidSendDate(row, new Date('2026-09-23T03:59:59Z'))).not.toThrow();
    expect(validateBidFields({ validThrough: '2026-02-30' })).toMatch(/calendar date/);
  });
});

describe('group-link viewability is separate from the offer deadline (owner ruling on #4309 r7)', () => {
  const { groupLinkViewableThrough, groupLinkStillViewable } = require('../services/proposal-bid');
  const withWindow = (at) => ({ estimate_data: JSON.stringify({ groupLinkViewableThrough: at }) });
  test('reads the stored window, tolerating absent and malformed values', () => {
    expect(groupLinkViewableThrough(withWindow('2030-04-01T03:59:59.999Z'))).toEqual(new Date('2030-04-01T03:59:59.999Z'));
    expect(groupLinkViewableThrough({ estimate_data: '{}' })).toBeNull();
    expect(groupLinkViewableThrough({ estimate_data: JSON.stringify({ groupLinkViewableThrough: 'not-a-date' }) })).toBeNull();
    expect(groupLinkViewableThrough({})).toBeNull();
  });
  test('viewability is a window, open through its instant and closed after', () => {
    const row = withWindow('2030-04-01T03:59:59.999Z');
    expect(groupLinkStillViewable(row, new Date('2030-03-31T00:00:00Z'))).toBe(true);
    expect(groupLinkStillViewable(row, new Date('2030-04-01T03:59:59.999Z'))).toBe(true);
    expect(groupLinkStillViewable(row, new Date('2030-04-01T04:00:00.000Z'))).toBe(false);
    expect(groupLinkStillViewable({ estimate_data: '{}' }, new Date('2030-01-01T00:00:00Z'))).toBe(false);
  });
  test('the narrowing helper is gone and every public deadline reads expires_at directly', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src).not.toMatch(/publicExpiresAt/);
    expect(src.match(/expiresAt: estimate\.expires_at,/g)).toHaveLength(1);
    expect(src.match(/expiresAt: docRenderPin\?\.validThrough \|\| estimate\.expires_at,/g)).toHaveLength(1);
    expect(src).toMatch(/const shownExpiry = estimate\.expires_at;/);
    expect(src).toMatch(/isEstimateAskAnswerable\(estimate\)/);
  });
  test('viewability is consulted ONLY where the delivered link would dead-end, never by an actionable path', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    // Route regressions cover navigation and expired property summaries.
    expect(src).toContain("Only React renders property-group navigation");
    // Nothing that decides an offer may read the navigation window.
    for (const actionable of ['estimate-follow-up.js', 'estimate-engagement-engine.js']) {
      const mod = require('fs').readFileSync(require('path').join(__dirname, '../services/', actionable), 'utf8');
      expect(mod).not.toMatch(/groupLinkViewableThrough|groupLinkStillViewable/);
      expect(mod).not.toMatch(/publicExpiresAt/);
    }
  });
  test('no sibling expiry is rewritten on save, and the shrink-reconstruction floor is gone', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-estimates.js'), 'utf8');
    expect(src).not.toMatch(/groupWidenFloorExpiresAt'\]|'\{groupWidenFloorExpiresAt\}'/);
    expect(src).not.toMatch(/previousAuthoredExpiry/);
    // The anchor's own expiry is what its save writes.
    expect(src).toMatch(/\? \{ expires_at: expiryUpdate \} :/);
  });
});

describe('cost row occurrences (GH codex P2 r11 on #4270)', () => {
  const row = { category: 'labor', phase: '', description: 'Labor', quantity: 10, unit: 'hour', unitCost: 40 };
  test('an absent legacy count means one; a cleared input is the zero the row shows', () => {
    expect(costRowOccurrences(row)).toBe(1);
    expect(costRowOccurrences({ ...row, occurrences: '' })).toBe(0);
    expect(costRowOccurrences({ ...row, occurrences: '3' })).toBe(3);
  });
  test('the entered-costs total agrees with the row extended cost when a count is cleared', () => {
    const totals = { oneTime: 1000, annualRecurring: 0 };
    expect(computeProjectCosts({ revenueYears: 1, rows: [{ ...row, occurrences: 1 }] }, totals)).toMatchObject({ cost: 400, costsComplete: true });
    // A legacy row with no count still totals as one occurrence but stays incomplete until it is entered.
    expect(computeProjectCosts({ revenueYears: 1, rows: [row] }, totals)).toMatchObject({ cost: 400, costsComplete: false });
    const cleared = computeProjectCosts({ revenueYears: 1, rows: [{ ...row, occurrences: '' }, { ...row, description: 'Materials', occurrences: 2 }] }, totals);
    expect(cleared.cost).toBe(800);
    expect(cleared.costsComplete).toBe(false);
    expect(cleared.profit).toBeNull();
  });
});
