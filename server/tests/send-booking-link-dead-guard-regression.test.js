// Regression test for AUDIT r1-estimates-2.
//
// Before the fix, POST /:id/send-booking-link's collision guard read only
// estimate_data.scheduled_service_id, so an estimate whose visit is linked
// via scheduled_services.source_estimate_id (every admin/public booking
// path) still got a fresh /book SMS. The guard now ORs both keys and
// matches any live (not cancelled/rescheduled/completed) status.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn(async () => null) }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(), buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(), saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({ createOrReuseAdminEstimate: jest.fn(), estimateViewUrl: jest.fn() }));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(() => ({ oneTimeList: [{ name: 'One-Time Pest Control' }], recurringList: [] })),
  bookingServiceFor: jest.fn(() => ({ id: 'pest_control', label: 'Pest Control' })),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn(), renderTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(), isDefiniteRejection: jest.fn(() => false) }));

const router = require('../routes/admin-estimates');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

function routeHandler(path, method = 'post') {
  const layer = router.stack.find((e) => e.route?.path === path && e.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const ESTIMATE_ID = '11111111-1111-4111-8111-111111111111';
const VISIT_ID = '22222222-2222-4222-8222-222222222222';

describe('r1-estimates-2 send-booking-link duplicate-appointment guard', () => {
  let scheduledServicesWheres;
  let estimateUpdates;
  beforeEach(() => {
    jest.clearAllMocks();
    scheduledServicesWheres = [];
    estimateUpdates = [];
    const estimate = {
      id: ESTIMATE_ID, customer_id: 'cust-1', customer_name: 'Pat Doe', customer_phone: '+15555550123',
      status: 'accepted', accepted_at: '2026-09-20T12:00:00.000Z', archived_at: null, bill_by_invoice: false,
      monthly_total: 0, onetime_total: 250,
      estimate_data: { result: { oneTime: { items: [{ service: 'pest_control', name: 'One-Time Pest Control', price: 250 }] } } },
    };
    // Live visit linked the way admin-schedule.js / booking.js / slot-reservation.js link it.
    const visit = { id: VISIT_ID, customer_id: 'cust-1', source_estimate_id: ESTIMATE_ID, status: 'confirmed', scheduled_date: '2026-09-25' };
    db.mockImplementation((table) => {
      if (table === 'estimates') {
        const q = {
          where: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue(estimate),
          update: jest.fn(async (patch) => { estimateUpdates.push(patch); return 1; }),
        };
        return q;
      }
      if (table === 'scheduled_services') {
        // Supports both a plain-object .where({...}) and the callback style
        // the fixed guard uses: .where((q) => { q.where(...); q.orWhere(...); }).
        const q = {
          _conds: [],
          where: jest.fn(function (w) {
            if (typeof w === 'function') { w.call(this, this); return this; }
            this._conds.push(w);
            scheduledServicesWheres.push(w);
            return this;
          }),
          orWhere: jest.fn(function (w) { this._conds.push(w); scheduledServicesWheres.push(w); return this; }),
          whereNotIn: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          first: jest.fn(async function () {
            const matches = this._conds.some((w) => (
              (w && String(w.source_estimate_id || '') === ESTIMATE_ID)
              || (w && String(w.id || '') === VISIT_ID)
            ));
            return matches ? visit : undefined;
          }),
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    });
    db.raw = jest.fn((s) => s);
    db.fn = { now: jest.fn(() => 'now()') };
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });

  test('estimate already linked via scheduled_services.source_estimate_id: 409, no SMS', async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await routeHandler('/:id/send-booking-link')({ params: { id: ESTIMATE_ID }, body: { message: 'Book here: {{booking_url}}' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    // The guard now consults scheduled_services by source_estimate_id, not
    // just the legacy estimate_data key.
    expect(scheduledServicesWheres.length).toBeGreaterThan(0);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/already has .*appointment/i) }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(estimateUpdates).toHaveLength(0);
  });

  test('control: the guard DOES fire when estimate_data.scheduled_service_id is stamped (call-agent predraft path only)', async () => {
    // Re-point the estimate at a stamped id to prove the guard code is reachable.
    const stamped = {
      id: ESTIMATE_ID, customer_id: 'cust-1', customer_name: 'Pat Doe', customer_phone: '+15555550123',
      status: 'accepted', archived_at: null, bill_by_invoice: false, monthly_total: 0, onetime_total: 250,
      estimate_data: { scheduled_service_id: VISIT_ID, result: { oneTime: { items: [{ service: 'pest_control', name: 'One-Time Pest Control', price: 250 }] } } },
    };
    const prevImpl = db.getMockImplementation();
    db.mockImplementation((table) => {
      if (table === 'estimates') {
        return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(stamped), update: jest.fn() };
      }
      return prevImpl(table);
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await routeHandler('/:id/send-booking-link')({ params: { id: ESTIMATE_ID }, body: { message: 'x' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
