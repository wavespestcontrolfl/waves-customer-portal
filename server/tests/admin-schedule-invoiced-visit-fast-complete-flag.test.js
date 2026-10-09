/**
 * Schedule payload flag `invoicedVisitFastCompleteEnabled`
 * (GATE_FAST_COMPLETE_INVOICED_VISITS, owner 2026-10-09): true only while the
 * gate is exactly 'true', read at call time. With it, admin Dispatch opens a
 * visit that is already invoiced (or returning from the payment flow) in its
 * Fast Complete sheet, which then posts the full form's own invoiceAlreadySent
 * field to the same POST /admin/dispatch/:id/complete. Off, the full form, as
 * before.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({ serviceKey: 'pest_general_quarterly' })),
}));

const fs = require('fs');
const path = require('path');
const gates = require('../config/feature-gates');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const flag = async () => {
  const map = await loadProjectCompletionContextByServiceId([{ id: 'svc-1', service_type: 'Quarterly Pest Control' }]);
  return map.get('svc-1').invoicedVisitFastCompleteEnabled;
};

describe('invoicedVisitFastCompleteEnabled', () => {
  const saved = process.env.GATE_FAST_COMPLETE_INVOICED_VISITS;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_FAST_COMPLETE_INVOICED_VISITS; else process.env.GATE_FAST_COMPLETE_INVOICED_VISITS = saved;
  });

  test('gate exactly "true": on', async () => {
    process.env.GATE_FAST_COMPLETE_INVOICED_VISITS = 'true';
    expect(gates.fastCompleteInvoicedVisitsLive()).toBe(true);
    expect(await flag()).toBe(true);
  });

  test.each([undefined, '', 'false', '1', 'TRUE', 'yes'])('gate %p: off', async (value) => {
    if (value === undefined) delete process.env.GATE_FAST_COMPLETE_INVOICED_VISITS; else process.env.GATE_FAST_COMPLETE_INVOICED_VISITS = value;
    expect(gates.fastCompleteInvoicedVisitsLive()).toBe(false);
    expect(await flag()).toBe(false);
  });

  test('is read at call time: a flip needs no restart', async () => {
    delete process.env.GATE_FAST_COMPLETE_INVOICED_VISITS;
    expect(await flag()).toBe(false);
    process.env.GATE_FAST_COMPLETE_INVOICED_VISITS = 'true';
    expect(await flag()).toBe(true);
    process.env.GATE_FAST_COMPLETE_INVOICED_VISITS = 'false';
    expect(await flag()).toBe(false);
  });

  test('the day and the week payload both carry the context flag, strictly true', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src.match(/invoicedVisitFastCompleteEnabled: projectCompletionContext\.invoicedVisitFastCompleteEnabled === true/g)).toHaveLength(2);
    expect(src).toMatch(/invoicedVisitFastCompleteEnabled: projectCompletionContext\.invoicedVisitFastCompleteEnabled === true/);
    expect(src).toMatch(/invoicedVisitFastCompleteEnabled: require\('\.\.\/config\/feature-gates'\)\.fastCompleteInvoicedVisitsLive\(\)/);
  });

  test('the sheets and the full form post to one route, so the server takes one branch', () => {
    // The Fast Complete submit hook posts to `${base}/complete` and Dispatch's
    // full form to `/admin/dispatch/${id}/complete`: the same route, the same
    // completeScheduledService, the same invoiceAlreadySent reader.
    const root = path.join(__dirname, '..', '..', 'client', 'src');
    const hook = fs.readFileSync(path.join(root, 'hooks', 'useFastCompleteSubmit.js'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'pages', 'admin', 'DispatchPageV2.jsx'), 'utf8');
    expect(hook).toContain('request(`${base}/complete`, { method: \'POST\'');
    expect(page).toContain('adminFetch(`/admin/dispatch/${serviceId}/complete`');
    for (const sheet of ['FastCompleteSheet', 'FastCompleteLawnSheet', 'FastCompleteLawnReserviceSheet', 'FastCompleteTreeShrubSheet']) {
      const text = fs.readFileSync(path.join(root, 'components', 'tech', `${sheet}.jsx`), 'utf8');
      expect(text).toMatch(/const base = `\/admin\/dispatch\/\$\{[^}]+\}`/);
    }
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-dispatch.js'), 'utf8');
    expect(route).toMatch(/router\.post\('\/:serviceId\/complete'/);
  });
});
