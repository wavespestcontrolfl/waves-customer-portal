jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('This unit test must not access a database'); });
  db.raw = jest.fn(); db.fn = { now: jest.fn() };
  return db;
});
const { normalizeProposal, computeProposalTotals } = require('../services/estimate-proposal');
const { buildProposalFirstInvoice } = require('../services/proposal-win');
const { estimateExpiresAt } = require('../services/admin-estimate-persistence');
const { proposalExpiry, assertBidSendDate, validateBidFields, assertBidScheduleDate, earliestScheduledDelivery, latestReachableSchedule } = require('../services/proposal-bid');
const { roundCents, showsLineBasis } = require('../../shared/proposal-bid.cjs');

const line = (id, quantity, unitPrice, unit = 'acre') => ({ id, description: `Synthetic ${id}`, quantity, unitPrice, unit, frequency: 'one_time' });
const estimate = (lines, extra = {}) => ({ estimate_data: { proposal: { enabled: true, validThrough: '2026-12-21', buildings: [{ name: 'Synthetic property', lineItems: lines }], ...extra } } });
const normalized = (lines, extra) => normalizeProposal(estimate(lines, extra));

describe('bid quantity authority', () => {
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
    // Exactly one reader, and it guards the expired-stub branch.
    expect(src.match(/groupLinkStillViewable\(/g)).toHaveLength(1);
    expect(src).toMatch(/&& !\(estimate\.estimate_group_id && groupLinkStillViewable\(estimate\)\)/);
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
