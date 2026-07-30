/**
 * Office-triggered secure-card / Auto Pay setup link (admin schedule).
 *
 * Two thin routes + one booking hook, all policy delegated to
 * services/appointment-card-request (payer exemption, saved-card
 * auto-secure, one-text-ever claim, gate + template levers):
 *   - GET  /admin/schedule/:id/card-request  — read-only rollup for the
 *     editor's Cards on file panel (request row + one-text stamp + live
 *     Auto Pay state).
 *   - POST /admin/schedule/:id/card-request  — trigger 'admin' send for an
 *     existing appointment; outcome reported verbatim so the UI can say
 *     WHY nothing was sent.
 *   - POST /admin/schedule (booking) — sendCardOnFileLink checkbox, OFF by
 *     default, parent visit only (a recurring series must never fan the
 *     link out per occurrence; a multi-group submit must not text twice).
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  // Role switchable per request so the tech-scoping path is testable.
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = req.headers['x-test-role'] || 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockRequestCard = jest.fn();
const mockLaneReady = jest.fn(async () => true);
jest.mock('../services/appointment-card-request', () => ({
  requestCardForAppointment: (...args) => mockRequestCard(...args),
  isSecureCardLaneReady: (...args) => mockLaneReady(...args),
}));
const mockOnAutopay = jest.fn(async () => false);
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: (...args) => mockOnAutopay(...args),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');

function stubTables(rows, { ownsVisit = true } = {}) {
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    // The tech-ownership probe selects exactly 'scheduled_services.id';
    // the data reads select plain column lists — distinguish so a test
    // can present a visit that EXISTS but is not the tech's.
    q.first = jest.fn(async (...cols) => (
      cols[0] === 'scheduled_services.id'
        ? (ownsVisit ? { id: 'svc-1' } : undefined)
        : rows[table]
    ));
    return q;
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', router);
   
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GET /admin/schedule/:id/card-request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLaneReady.mockResolvedValue(true);
    mockOnAutopay.mockResolvedValue(false);
  });

  test('returns the rollup: request row + one-text stamp + live Auto Pay state', async () => {
    stubTables({
      scheduled_services: { id: 'svc-1', customer_id: 'cust-1', card_link_sent_at: '2026-07-20T10:00:00Z' },
      appointment_card_requests: { status: 'completed', sent_at: '2026-07-20T10:00:05Z', completed_at: '2026-07-20T10:31:00Z' },
      customers: { id: 'cust-1' },
    });
    mockOnAutopay.mockResolvedValue(true);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/svc-1/card-request`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        enabled: true,
        autopayActive: true,
        cardLinkSentAt: '2026-07-20T10:00:00Z',
        request: {
          status: 'completed',
          sentAt: '2026-07-20T10:00:05Z',
          completedAt: '2026-07-20T10:31:00Z',
          // Plan-choice lane (GATE_SECURE_PLAN_CHOICE): NULL until the
          // customer picks a plan on the /secure page.
          selectedPlan: null,
          prepayInvoiceId: null,
        },
      });
    });
  });

  test('no request row and no stamp → nulls, enabled reflects the lane (gate + template)', async () => {
    stubTables({
      scheduled_services: { id: 'svc-1', customer_id: 'cust-1', card_link_sent_at: null },
      appointment_card_requests: undefined,
      customers: { id: 'cust-1' },
    });
    mockLaneReady.mockResolvedValue(false);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/svc-1/card-request`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        enabled: false,
        autopayActive: false,
        cardLinkSentAt: null,
        request: null,
      });
    });
  });

  test('404 on an unknown visit', async () => {
    stubTables({ scheduled_services: undefined });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/nope/card-request`);
      expect(response.status).toBe(404);
    });
  });

  test("404 for a technician on a visit that exists but is not theirs (Codex #2921 P1)", async () => {
    stubTables({
      scheduled_services: { id: 'svc-1', customer_id: 'cust-1', card_link_sent_at: null },
      appointment_card_requests: undefined,
      customers: { id: 'cust-1' },
    }, { ownsVisit: false });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/svc-1/card-request`, {
        headers: { 'x-test-role': 'technician' },
      });
      expect(response.status).toBe(404);
    });
  });

  test('a technician CAN read their own visit', async () => {
    stubTables({
      scheduled_services: { id: 'svc-1', customer_id: 'cust-1', card_link_sent_at: null },
      appointment_card_requests: undefined,
      customers: { id: 'cust-1' },
    }, { ownsVisit: true });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/svc-1/card-request`, {
        headers: { 'x-test-role': 'technician' },
      });
      expect(response.status).toBe(200);
    });
  });

  test('an autopay-eligibility failure degrades to autopayActive false, never a 500', async () => {
    stubTables({
      scheduled_services: { id: 'svc-1', customer_id: 'cust-1', card_link_sent_at: null },
      appointment_card_requests: undefined,
      customers: { id: 'cust-1' },
    });
    mockOnAutopay.mockRejectedValue(new Error('autopay lookup down'));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/svc-1/card-request`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ autopayActive: false });
    });
  });
});

describe('GET /admin/schedule/card-request-availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLaneReady.mockResolvedValue(true);
  });

  test('reflects both dark levers via isSecureCardLaneReady', async () => {
    stubTables({});
    await withServer(async (baseUrl) => {
      let response = await fetch(`${baseUrl}/admin/schedule/card-request-availability`);
      await expect(response.json()).resolves.toEqual({ enabled: true });
      mockLaneReady.mockResolvedValue(false);
      response = await fetch(`${baseUrl}/admin/schedule/card-request-availability`);
      await expect(response.json()).resolves.toEqual({ enabled: false });
    });
  });
});

describe('POST /admin/schedule/:id/card-request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLaneReady.mockResolvedValue(true);
    mockOnAutopay.mockResolvedValue(false);
  });

  test("delegates to the funnel with trigger 'admin' and reports the outcome verbatim", async () => {
    stubTables({ scheduled_services: { id: 'svc-1' } });
    mockRequestCard.mockResolvedValue({ requested: true, action: 'sent', reason: 'sent' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/svc-1/card-request`, { method: 'POST' });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ requested: true, action: 'sent', reason: 'sent' });
    });

    expect(mockRequestCard).toHaveBeenCalledTimes(1);
    expect(mockRequestCard).toHaveBeenCalledWith({ scheduledServiceId: 'svc-1', trigger: 'admin' });
  });

  test('skip outcomes pass through so the UI can say why nothing was sent', async () => {
    stubTables({ scheduled_services: { id: 'svc-1' } });
    mockRequestCard.mockResolvedValue({ requested: false, action: 'skipped', reason: 'payer_billed' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/svc-1/card-request`, { method: 'POST' });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ requested: false, action: 'skipped', reason: 'payer_billed' });
    });
  });

  test('404 on an unknown visit — the funnel is never invoked', async () => {
    stubTables({ scheduled_services: undefined });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/schedule/nope/card-request`, { method: 'POST' });
      expect(response.status).toBe(404);
    });
    expect(mockRequestCard).not.toHaveBeenCalled();
  });
});

describe('source guards — booking hook and client defaults', () => {
  const scheduleSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const createModalSrc = fs.readFileSync(
    path.join(__dirname, '../../client/src/components/schedule/CreateAppointmentModal.jsx'),
    'utf8',
  );

  test('POST /admin/schedule fires the funnel only on explicit opt-in, parent visit only', () => {
    expect(scheduleSrc).toContain('sendCardOnFileLink === true');
    expect(scheduleSrc).toContain("requestCardForAppointment({ scheduledServiceId: svc.id, trigger: 'admin' })");
  });

  test('the card-request GET is tech-scoped like its per-visit neighbors (Codex #2921 P1)', () => {
    const getRoute = scheduleSrc.slice(scheduleSrc.indexOf("router.get('/:id/card-request'"));
    expect(getRoute.slice(0, 800)).toContain('technicianOwnsScheduledService(req, req.params.id)');
  });

  test('the booking checkbox is OFF by default and only the first created group carries the flag', () => {
    expect(createModalSrc).toContain('const [sendCardLink, setSendCardLink] = useState(false);');
    expect(createModalSrc).toContain(
      'sendCardOnFileLink: cardLinkAvailable && sendCardLink && results.length === 0 && createdGroupKeysRef.current.size === 0 ? true : undefined,',
    );
    // The checkbox must not render while the lane is dark (Codex #2921 P2).
    expect(createModalSrc).toContain("adminFetch('/admin/schedule/card-request-availability')");
    expect(createModalSrc).toContain('{cardLinkAvailable && (');
  });
});
