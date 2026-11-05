/**
 * IB switch_visit_to_annual_prepay (owner request 2026-11-05): the Schedule on-site annual-prepay switch run in process
 * behind a card, dark behind GATE_IB_PREPAY_SWITCH (needs GATE_IB_PLATFORM). What the card shows (customer, the year's
 * price, the invoice it voids, that the prepay is unpaid until collected, that nothing is sent), a refusal carrying the
 * switch's own reason, pin drift, gate off, admin only, and that the commit runs the switch once with the card's figures
 * as `expected`. The switch itself is mocked here; schedule-prepay-switch.test.js covers the real one (including the
 * in-transaction `expected` check). Synthetic names only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-schedule', () => ({
  computeAnnualPrepayPreview: jest.fn(),
  runPrepaySwitch: jest.fn(),
  prepaySwitchSupersedeKey: (inv) => `${inv.id}:${inv.total}`,
}));

const VISIT = '00000000-0000-4000-8000-0000000000d1';
const CUST = '00000000-0000-4000-8000-0000000000c1';
let mockRows;
jest.mock('../models/db', () => jest.fn((table) => {
  const filters = [];
  const q = {
    where(obj) { filters.push(obj); return q; },
    first() {
      const found = (mockRows[table] || []).find((row) => filters.every((f) => Object.entries(f).every(([k, v]) => String(row[k]) === String(v))));
      return Promise.resolve(found);
    },
    update() { throw new Error(`write to ${table}`); },
    insert() { throw new Error(`write to ${table}`); },
  };
  return q;
}));

const Schedule = require('../routes/admin-schedule');
const { executePrepaySwitchTool, cardLines } = require('../services/intelligence-bar/prepay-switch-tools');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const ADMIN = { isAdmin: true, technicianId: 'staff-1' };
const PREVIEW = {
  eligible: true,
  annualBase: 512,
  discountLabel: null,
  setupFee: { amount: 99, waivedWithPrepay: true },
  supersedes: [{ id: 'inv-1', invoiceNumber: 'WPC-2099-0345', total: 227 }],
  mintPayload: { amount: 512, visitCount: 4, coverageCadence: 'quarterly', serviceType: 'Quarterly Pest Control', termStart: '2099-02-03' },
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_PLATFORM = 'true';
  process.env.GATE_IB_PREPAY_SWITCH = 'true';
  mockRows = {
    scheduled_services: [{ id: VISIT, customer_id: CUST, status: 'on_site', scheduled_date: '2099-02-03', service_type: 'Quarterly Pest Control' }],
    customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample', billing_mode: 'per_application' }],
  };
  Schedule.computeAnnualPrepayPreview.mockResolvedValue(PREVIEW);
  Schedule.runPrepaySwitch.mockResolvedValue({
    invoice: { id: 'inv-prepay', invoice_number: 'WPC-2099-0400', total: 512 },
    voided: [{ id: 'inv-1', invoiceNumber: 'WPC-2099-0345', total: 227 }],
  });
});
afterAll(() => {
  delete process.env.GATE_IB_PLATFORM;
  delete process.env.GATE_IB_PREPAY_SWITCH;
});

async function preview() {
  return executePrepaySwitchTool('switch_visit_to_annual_prepay', { appointment_id: VISIT }, ADMIN);
}

test('the preview shows the year, the invoice it voids, that it stays unpaid until collected, and writes nothing', async () => {
  const p = await preview();
  expect(p).toMatchObject({
    preview: true, customer_name: 'Robin Sample', billing_before: 'per_application', prepay_amount: '$512.00',
    invoice_total: '$512.00', visits_covered: 4, cadence: 'quarterly', term_start: '2099-02-03', sends_to_customer: false,
    voids: [{ invoice_number: 'WPC-2099-0345', amount: '$227.00' }],
  });
  // The switch's own preview, opened for the bar's lane; the switch itself never runs on a preview.
  expect(Schedule.computeAnnualPrepayPreview).toHaveBeenCalledWith({ scheduledServiceId: VISIT }, expect.anything(), { switchLane: true });
  expect(Schedule.runPrepaySwitch).not.toHaveBeenCalled();
  const text = cardLines('switch_visit_to_annual_prepay', p).map((l) => l.text).join('\n');
  expect(text).toMatch(/UNPAID annual prepay invoice/);
  expect(text).toMatch(/Voids the unsent per-application invoice WPC-2099-0345/);
  expect(text).toMatch(/\$99\.00 setup fee on it is waived/);
  expect(text).toMatch(/only when this invoice is paid/);
  expect(text).toMatch(/Nothing is sent/);
  // The card contract renders the curated lines, not the generic dump.
  const contract = buildContract({ toolName: 'switch_visit_to_annual_prepay', params: { appointment_id: VISIT }, preview: p });
  expect(JSON.stringify(contract)).toMatch(/UNPAID annual prepay invoice/);
});

test('an ineligible visit refuses with the switch\'s own reason and proposes nothing', async () => {
  Schedule.computeAnnualPrepayPreview.mockResolvedValue({ eligible: false, blockReason: 'is already closed out' });
  const p = await preview();
  expect(p).toMatchObject({ code: 'not_eligible', reason: 'is already closed out' });
  expect(p.error).toMatch(/can't be switched to annual prepay from this visit: it is already closed out/);
});

test('confirm runs the switch once with the figures the card showed', async () => {
  const p = await preview();
  const out = await executePrepaySwitchTool('switch_visit_to_annual_prepay',
    { appointment_id: VISIT, confirmed: true, _verified_prepay_switch_version: p._version }, ADMIN);
  expect(out).toMatchObject({ success: true, invoice_number: 'WPC-2099-0400', invoice_total: '$512.00', voided: ['WPC-2099-0345'], sent_to_customer: false });
  expect(Schedule.runPrepaySwitch).toHaveBeenCalledTimes(1);
  expect(Schedule.runPrepaySwitch.mock.calls[0][0]).toMatchObject({
    visitId: VISIT, switchLane: true, acknowledgeNoticedAmount: false,
    expected: { amount: 512, setupFeeAmount: 0, visitCount: 4, coverageCadence: 'quarterly', serviceType: 'Quarterly Pest Control', termStart: '2099-02-03', supersedeKeys: ['inv-1:227'] },
  });
});

test('a price that moved after the card refuses as preview_changed and runs nothing', async () => {
  const p = await preview();
  Schedule.computeAnnualPrepayPreview.mockResolvedValue({ ...PREVIEW, mintPayload: { ...PREVIEW.mintPayload, amount: 540 } });
  const out = await executePrepaySwitchTool('switch_visit_to_annual_prepay',
    { appointment_id: VISIT, confirmed: true, _verified_prepay_switch_version: p._version }, ADMIN);
  expect(out).toMatchObject({ code: 'preview_changed', preview_changed: true });
  expect(Schedule.runPrepaySwitch).not.toHaveBeenCalled();
});

test('an edit to the invoice it voids (same id, new amount) refuses as preview_changed', async () => {
  const p = await preview();
  Schedule.computeAnnualPrepayPreview.mockResolvedValue({ ...PREVIEW, supersedes: [{ ...PREVIEW.supersedes[0], total: 237 }] });
  const out = await executePrepaySwitchTool('switch_visit_to_annual_prepay',
    { appointment_id: VISIT, confirmed: true, _verified_prepay_switch_version: p._version }, ADMIN);
  expect(out).toMatchObject({ code: 'preview_changed', preview_changed: true });
  expect(Schedule.runPrepaySwitch).not.toHaveBeenCalled();
});

test('confirm without the card pin is refused', async () => {
  const out = await executePrepaySwitchTool('switch_visit_to_annual_prepay', { appointment_id: VISIT, confirmed: true }, ADMIN);
  expect(out.code).toBe('approval_required');
  expect(Schedule.runPrepaySwitch).not.toHaveBeenCalled();
});

test('the switch\'s refusals pass through; a noticed renewal amount is never overridden from the bar', async () => {
  const p = await preview();
  const confirm = () => executePrepaySwitchTool('switch_visit_to_annual_prepay',
    { appointment_id: VISIT, confirmed: true, _verified_prepay_switch_version: p._version }, ADMIN);
  Schedule.runPrepaySwitch.mockResolvedValueOnce({ httpStatus: 409, httpBody: { error: 'The prepay figures changed after the card was shown — nothing was switched' }, drift: true });
  expect(await confirm()).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
  Schedule.runPrepaySwitch.mockResolvedValueOnce({ httpStatus: 409, httpBody: { error: 'Customer already has an annual prepay term through 2100-01-01.' } });
  expect(await confirm()).toMatchObject({ failed: true, code: 'switch_refused' });
  Schedule.runPrepaySwitch.mockResolvedValueOnce({ httpStatus: 409, httpBody: { error: 'The customer was told $560.00' }, noticedRenewalAmount: true });
  const noticed = await confirm();
  expect(noticed).toMatchObject({ failed: true, code: 'noticed_renewal_amount' });
  expect(noticed.error).toMatch(/Switch to annual prepay sheet/);
});

test('gate off: refuses and reads nothing', async () => {
  delete process.env.GATE_IB_PREPAY_SWITCH;
  const out = await preview();
  expect(out.code).toBe('gate_off');
  expect(Schedule.computeAnnualPrepayPreview).not.toHaveBeenCalled();
});

test('admin only, and the confirmed run needs a positive admin flag', async () => {
  expect((await executePrepaySwitchTool('switch_visit_to_annual_prepay', { appointment_id: VISIT }, { isAdmin: false })).code).toBe('permission_denied');
  expect((await executePrepaySwitchTool('switch_visit_to_annual_prepay', { appointment_id: VISIT, confirmed: true }, {})).code).toBe('permission_denied');
});
