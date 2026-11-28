'use strict';

/**
 * Pure unit tests (no loopback socket required) for PR 1:
 *   C2-01 Part A — visit-level technician ownership on call-reschedule proposals
 *   C2-01 Part B — /api/admin/sms-templates/issues excluded from technician allow-list + requireAdmin
 *   C2-01 Part C — admin-only middleware on office Communications, AI Assistant, Requests & Triage routes
 *   C2-08        — assertInternalEmailRecipient guard on POST /api/admin/automations/templates/:key/test
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const { technicianMayReach } = require('../middleware/technician-scope');
const { requireAdmin } = require('../middleware/admin-auth');

describe('C2-01 Part B: technician allow-list excludes /api/admin/sms-templates/issues', () => {
  test('denies GET /api/admin/sms-templates/issues while keeping template reads reachable', () => {
    expect(technicianMayReach('GET', '/api/admin/sms-templates/issues')).toBe(false);
    expect(technicianMayReach('GET', '/api/admin/sms-templates')).toBe(true);
    expect(technicianMayReach('GET', '/api/admin/sms-templates/tpl-123')).toBe(true);
    expect(technicianMayReach('GET', '/api/admin/sms-templates/appointment_confirmation/variants')).toBe(true);
  });

  test('admin-sms-templates GET /issues carries requireAdmin middleware', () => {
    const router = require('../routes/admin-sms-templates');
    const layer = router.stack.find((l) => l.route?.path === '/issues' && l.route.methods.get);
    expect(layer).toBeDefined();
    expect(layer.route.stack.some((s) => s.handle === requireAdmin)).toBe(true);
  });
});

describe('C2-01 Part C: office-only comms routes enforce requireAdmin directly', () => {
  test('admin-communications office-only routes carry requireAdmin', () => {
    const router = require('../routes/admin-communications');
    const expected = [
      ['post', '/call'],
      ['get', '/scheduled'],
      ['delete', '/scheduled/:id'],
      ['get', '/compliance-export'],
      ['get', '/template-performance'],
      ['post', '/contact-compliance-checks'],
      ['get', '/collections-voice-status'],
    ];
    for (const [method, routePath] of expected) {
      const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
      expect(layer).toBeDefined();
      expect(layer.route.stack.some((s) => s.handle === requireAdmin)).toBe(true);
    }
  });

  test('ai-assistant /admin/* Portal Inbox routes carry requireAdmin', () => {
    const router = require('../routes/ai-assistant');
    const expected = [
      ['get', '/admin/escalations'],
      ['put', '/admin/escalations/:id'],
      ['get', '/admin/conversations'],
      ['get', '/admin/conversations/:id/messages'],
      ['post', '/admin/conversations/:id/reply'],
    ];
    for (const [method, routePath] of expected) {
      const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
      expect(layer).toBeDefined();
      expect(layer.route.stack.some((s) => s.handle === requireAdmin)).toBe(true);
    }
  });

  test('admin-requests and admin-triage routers mount requireAdmin at router level', () => {
    const requestsRouter = require('../routes/admin-requests');
    const triageRouter = require('../routes/admin-triage');
    expect(requestsRouter.stack.some((l) => !l.route && l.handle === requireAdmin)).toBe(true);
    expect(triageRouter.stack.some((l) => !l.route && l.handle === requireAdmin)).toBe(true);
  });
});

describe('C2-08: POST /api/admin/automations/templates/:key/test enforces internal recipient allowlist', () => {
  test('rejects an external customer email with 400 before calling AutomationRunner.testSequence', async () => {
    const AutomationRunner = require('../services/automation-runner');
    const spy = jest.spyOn(AutomationRunner, 'testSequence').mockResolvedValue({ results: [] });
    try {
      const router = require('../routes/admin-automations');
      const layer = router.stack.find((l) => l.route?.path === '/templates/:key/test' && l.route.methods.post);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await handler({ params: { key: 'welcome_series' }, body: { toEmail: 'real.customer@gmail.com' }, technician: { email: 'owner@wavespestcontrol.com' } }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/internal/i);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('allows an internal @wavespestcontrol.com recipient and forwards normalized email', async () => {
    const AutomationRunner = require('../services/automation-runner');
    const spy = jest.spyOn(AutomationRunner, 'testSequence').mockResolvedValue({ template: 'welcome_series', to: 'contact@wavespestcontrol.com', results: [] });
    try {
      const router = require('../routes/admin-automations');
      const layer = router.stack.find((l) => l.route?.path === '/templates/:key/test' && l.route.methods.post);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await handler({ params: { key: 'welcome_series' }, body: { toEmail: '  Contact@WavesPestControl.com ' }, technician: { email: 'owner@wavespestcontrol.com' } }, res);
      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith({ templateKey: 'welcome_series', toEmail: 'contact@wavespestcontrol.com' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('C2-01 Part A: call-reschedule-apply rejects cross-technician and collective series moves', () => {
  test('technician actor is refused (403 service_not_assigned) when locked visit belongs to another technician', async () => {
    const { applyReviewedCallReschedule } = require('../services/call-reschedule-apply');
    const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');
    const tomorrow = etDateString(addETDays(new Date(), 1));
    const nextWeek = etDateString(addETDays(new Date(), 5));

    const otherTechVisit = {
      id: 'visit-other-tech',
      customer_id: 'cust-1',
      property_id: 'prop-1',
      technician_id: 'tech-OTHER',
      service_id: 'svc-1',
      service_type: 'pest_control',
      scheduled_date: tomorrow,
      window_start: '09:00',
      window_end: '11:00',
      estimated_duration_minutes: 45,
      status: 'confirmed',
      visit_id: null,
      source_action: null,
      customer_confirmed: false,
      self_booking_id: null,
      is_recurring: false,
      service_address_line1: '100 Main St',
      service_address_line2: null,
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34202',
    };

    const makeTrx = () => {
      const trx = (table) => {
        const q = {};
        ['where', 'whereIn', 'orderBy', 'forUpdate', 'forShare'].forEach((m) => { q[m] = () => q; });
        q.first = async () => ({ id: 'cust-1' });
        q.select = async () => (table === 'scheduled_services' ? [otherTechVisit] : [{ id: 'prop-1' }]);
        return q;
      };
      trx.raw = async () => ({ rows: [] });
      return trx;
    };

    const guard = jest.fn();
    const rebooker = {
      reschedule: jest.fn(async (_id, _d, _w, _r, _a, opts) => {
        const trx = makeTrx();
        await opts.moveGuard({ trx });
        return { outcome: 'moved' };
      }),
    };

    const call = {
      id: 'call-1',
      customer_id: 'cust-1',
      from_phone: '+19415550100',
      created_at: new Date().toISOString(),
      transcription: 'Caller: Can we move it to next week at 10am?',
    };
    const v2 = {
      scheduling: {
        status: 'reschedule_requested',
        proposed_start_at: parseETDateTime(`${nextWeek}T10:00`).toISOString(),
      },
    };
    const customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', phone: '+19415550100' };

    await expect(applyReviewedCallReschedule({
      conn: {},
      call,
      v2,
      customer,
      candidates: [otherTechVisit],
      visitId: otherTechVisit.id,
      actorId: 'tech-SELF',
      actor: { techRole: 'technician', technicianId: 'tech-SELF' },
      operationKey: 'op-1',
      guard,
      rebooker,
    })).rejects.toMatchObject({ status: 403, code: 'service_not_assigned' });
    expect(guard).not.toHaveBeenCalled();
  });

  test('technician actor is refused (403 series_move_admin_only) on a collective series move even when owning every occurrence', async () => {
    const { applyReviewedCallReschedule } = require('../services/call-reschedule-apply');
    const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');
    const tomorrow = etDateString(addETDays(new Date(), 1));
    const nextWeek = etDateString(addETDays(new Date(), 5));
    const nextMonth = etDateString(addETDays(new Date(), 35));

    const ownOcc1 = {
      id: 'visit-own-1',
      customer_id: 'cust-1',
      property_id: 'prop-1',
      technician_id: 'tech-SELF',
      service_id: 'svc-1',
      service_type: 'pest_control',
      scheduled_date: tomorrow,
      window_start: '09:00',
      window_end: '11:00',
      estimated_duration_minutes: 45,
      status: 'confirmed',
      visit_id: null,
      source_action: null,
      customer_confirmed: false,
      self_booking_id: null,
      is_recurring: true,
      recurring_pattern: 'monthly',
      service_address_line1: '100 Main St',
      service_address_line2: null,
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34202',
    };
    const ownOcc2 = { ...ownOcc1, id: 'visit-own-2', scheduled_date: nextMonth };

    const makeTrx = () => {
      const trx = (table) => {
        const q = {};
        ['where', 'whereIn', 'orderBy', 'forUpdate', 'forShare'].forEach((m) => { q[m] = () => q; });
        q.first = async () => ({ id: 'cust-1' });
        q.select = async () => (table === 'scheduled_services' ? [ownOcc1, ownOcc2] : [{ id: 'prop-1' }]);
        return q;
      };
      trx.raw = async () => ({ rows: [] });
      return trx;
    };

    const guard = jest.fn();
    const rebooker = {
      reschedule: jest.fn(async (_id, _d, _w, _r, _a, opts) => {
        const trx = makeTrx();
        await opts.moveGuard({ trx });
        return { outcome: 'moved' };
      }),
    };

    const call = {
      id: 'call-2',
      customer_id: 'cust-1',
      from_phone: '+19415550100',
      created_at: new Date().toISOString(),
      transcription: 'Caller: Can we move my recurring service to next week at 10am?',
    };
    const v2 = {
      scheduling: {
        status: 'reschedule_requested',
        proposed_start_at: parseETDateTime(`${nextWeek}T10:00`).toISOString(),
      },
    };
    const customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', phone: '+19415550100' };

    await expect(applyReviewedCallReschedule({
      conn: {},
      call,
      v2,
      customer,
      candidates: [ownOcc1],
      visitId: ownOcc1.id,
      actorId: 'tech-SELF',
      actor: { techRole: 'technician', technicianId: 'tech-SELF' },
      operationKey: 'op-2',
      occurrenceIds: [ownOcc1.id, ownOcc2.id],
      guard,
      rebooker,
    })).rejects.toMatchObject({ status: 403, code: 'series_move_admin_only' });
    expect(guard).not.toHaveBeenCalled();
  });
});
