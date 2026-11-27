/**
 * Regression suite for Estimates & Bids security & safety audit (PR 1):
 * - Technician tokens receive 403 on GET /api/admin/estimates/:id/schedule-source
 *   and GET /api/admin/estimates/:id/slot-debug (even with GATE_STAFF_DEFAULT_DENY off).
 * - POST /api/admin/estimates/:id/send-booking-link fails closed (500, no SMS)
 *   when the scheduled_services collision query throws, and refuses expired
 *   sent/viewed offers with 400.
 * - Malformed UUIDs return 404 on admin-estimates (22P02), admin-estimate-slots,
 *   admin-agent-estimate, and admin-email attachment download; 500s scrub raw messages.
 * - admin-email attachment download sets Cache-Control: private, no-store.
 * - admin-bid-desk scrubs DB errors before forwarding to errorHandler.
 */
const express = require('express');

jest.setTimeout(15000);

async function withApp(mountPath, router, fn, { errorHandler } = {}) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  app.use(errorHandler || ((err, _req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.message })));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

describe('Estimates & Bids security hardening (PR 1)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('technician role is denied (403) on GET /api/admin/estimates/:id/schedule-source and slot-debug', async () => {
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; req.techRole = 'technician'; next(); },
      requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    const estimatesRouter = require('../routes/admin-estimates');
    const slotsRouter = require('../routes/admin-estimate-slots');

    await withApp('/api/admin/estimates', estimatesRouter, async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/estimates/11111111-1111-4111-8111-111111111111/schedule-source`);
      expect(r.status).toBe(403);
    });
    await withApp('/api/admin/estimates', slotsRouter, async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/estimates/11111111-1111-4111-8111-111111111111/slot-debug`);
      expect(r.status).toBe(403);
    });
  });

  test('admin-estimates translates PG 22P02 only for malformed :id UUIDs, not valid-UUID DB errors', async () => {
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "bad"'), { code: '22P02' });
    jest.doMock('../models/db', () => jest.fn(() => ({
      where: () => ({ first: jest.fn().mockRejectedValue(pgErr) }),
    })));
    const router = require('../routes/admin-estimates');
    await withApp('/api/admin/estimates', router, async (baseUrl) => {
      const rBad = await fetch(`${baseUrl}/api/admin/estimates/not-a-uuid/edit-source`);
      expect(rBad.status).toBe(404);
      expect(await rBad.json()).toEqual({ error: 'Estimate not found' });

      const rValid = await fetch(`${baseUrl}/api/admin/estimates/11111111-1111-4111-8111-111111111111/edit-source`);
      expect(rValid.status).toBe(500);
    });
  });

  test('send-booking-link refuses expired sent/viewed offers (400) and fails closed on DB collision error (500, no SMS)', async () => {
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
    jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
    jest.doMock('../routes/estimate-public', () => ({
      acceptanceServiceLists: jest.fn(() => ({ oneTimeList: [{ name: 'One-Time Pest' }], recurringList: [] })),
      bookingServiceFor: jest.fn(() => ({ id: 'pest', label: 'Pest Control' })),
    }));
    jest.doMock('../services/estimate-delivery-options', () => ({
      estimateDataHasQuoteRequirement: jest.fn(() => false),
      estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
      commercialRiskTypeReviewNeeded: jest.fn(() => false),
      validateEstimateDeliveryOptions: jest.fn(),
    }));
    let currentEstimate;
    let scheduledErr = null;
    jest.doMock('../models/db', () => jest.fn((table) => {
      if (table === 'estimates') {
        return { where: () => ({ first: jest.fn().mockResolvedValue(currentEstimate) }) };
      }
      if (table === 'scheduled_services') {
        const b = {};
        for (const m of ['where', 'orWhere', 'whereNotIn', 'andWhere', 'whereNotNull', 'orWhereNull', 'orWhereRaw']) {
          b[m] = jest.fn((arg) => { if (typeof arg === 'function') arg(b); return b; });
        }
        b.first = jest.fn().mockRejectedValue(scheduledErr);
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    }));
    const router = require('../routes/admin-estimates');

    currentEstimate = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'viewed',
      expires_at: '2020-01-01T00:00:00.000Z',
      customer_phone: '+19415550101',
      monthly_total: 0,
      onetime_total: 250,
      estimate_data: {},
    };
    await withApp('/api/admin/estimates', router, async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/estimates/${currentEstimate.id}/send-booking-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/expired/i);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    currentEstimate = {
      ...currentEstimate,
      status: 'accepted',
      expires_at: '2020-01-01T00:00:00.000Z',
    };
    scheduledErr = new Error('connection reset by peer');
    await withApp('/api/admin/estimates', router, async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/estimates/${currentEstimate.id}/send-booking-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(r.status).toBe(500);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  test('admin-estimate-slots rejects non-UUID with 404 and scrubs internal 500 messages', async () => {
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
    }));
    jest.doMock('../services/estimate-slot-availability', () => ({
      getSlotDebug: jest.fn().mockRejectedValue(Object.assign(new Error('secret query detail 9415551234'), { code: '57014' })),
    }));
    const router = require('../routes/admin-estimate-slots');
    await withApp('/api/admin/estimates', router, async (baseUrl) => {
      const r404 = await fetch(`${baseUrl}/api/admin/estimates/not-a-uuid/slot-debug`);
      expect(r404.status).toBe(404);
      const r500 = await fetch(`${baseUrl}/api/admin/estimates/11111111-1111-4111-8111-111111111111/slot-debug`);
      expect(r500.status).toBe(500);
      const body = await r500.json();
      expect(body.error).not.toContain('9415551234');
      expect(body.error).toMatch(/Could not load slot debug/i);
    });
  });

  test('admin-agent-estimate validates UUIDs on leadId, memory id, and source_lead_id', async () => {
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
    }));
    jest.doMock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => true) }));
    const router = require('../routes/admin-agent-estimate');
    await withApp('/api/admin/agent-estimate', router, async (baseUrl) => {
      expect((await fetch(`${baseUrl}/api/admin/agent-estimate/lead/not-a-uuid`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/admin/agent-estimate/memory/not-a-uuid`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }),
      })).status).toBe(404);
      const badLead = await fetch(`${baseUrl}/api/admin/agent-estimate/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_text: 'Always verify lot size before quoting lawn.', source_lead_id: 'not-a-uuid' }),
      });
      expect(badLead.status).toBe(400);
    });
  });

  test('admin-email attachment download enforces UUID, private no-store header, and scrubbed 500s', async () => {
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
    }));
    let throwOnGet = false;
    let attachmentFilename = '../rfp\r\n"2026".pdf';
    jest.doMock('../services/email/gmail-client', () => ({
      getAttachment: jest.fn(async () => {
        if (throwOnGet) throw Object.assign(new Error('raw token leak'), { code: 'ECONNRESET' });
        return Buffer.from('%PDF-1.4');
      }),
    }));
    jest.doMock('../models/db', () => jest.fn((table) => {
      if (table === 'emails') {
        return { where: () => ({ first: jest.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', gmail_id: 'gm-1' }) }) };
      }
      if (table === 'email_attachments') {
        return { where: () => ({ first: jest.fn().mockResolvedValue({ filename: attachmentFilename, mime_type: 'application/pdf' }) }) };
      }
      return { where: () => ({ first: jest.fn().mockResolvedValue(null) }) };
    }));
    const router = require('../routes/admin-email');
    await withApp('/api/admin/email', router, async (baseUrl) => {
      expect((await fetch(`${baseUrl}/api/admin/email/message/not-a-uuid/attachment/att1`)).status).toBe(404);
      const ok = await fetch(`${baseUrl}/api/admin/email/message/11111111-1111-4111-8111-111111111111/attachment/att1`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('private, no-store');
      expect(ok.headers.get('content-disposition')).toBe('attachment; filename=".._rfp___2026_.pdf"');
      expect(ok.headers.get('content-type')).toMatch(/^application\/pdf/);

      attachmentFilename = 'RFP – 2026.pdf';
      const unicode = await fetch(`${baseUrl}/api/admin/email/message/11111111-1111-4111-8111-111111111111/attachment/att1`);
      expect(unicode.status).toBe(200);
      expect(unicode.headers.get('content-disposition')).toContain("filename*=UTF-8''RFP%20%E2%80%93%202026.pdf");
      expect(unicode.headers.get('content-type')).toMatch(/^application\/pdf/);

      throwOnGet = true;
      const errRes = await fetch(`${baseUrl}/api/admin/email/message/11111111-1111-4111-8111-111111111111/attachment/att1`);
      expect(errRes.status).toBe(500);
      expect((await errRes.json()).error).not.toContain('raw token leak');
    });
  });

  test('admin-bid-desk scrubs raw DB errors before passing to errorHandler', async () => {
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
    }));
    jest.doMock('../models/db', () => jest.fn(() => {
      const b = {};
      for (const m of ['leftJoin', 'select', 'whereRaw', 'count', 'as', 'orderByRaw']) {
        b[m] = jest.fn(() => b);
      }
      b.limit = jest.fn().mockRejectedValue(Object.assign(new Error('sensitive buyer@example.com binding'), { code: '42P01' }));
      return b;
    }));
    const router = require('../routes/admin-bid-desk');
    let caught = null;
    await withApp('/api/admin/bid-desk', router, async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/bid-desk`);
      expect(r.status).toBe(500);
    }, {
      errorHandler: (err, _req, res, _next) => { caught = err; res.status(500).json({ error: err.message }); },
    });
    expect(caught.message).toContain('42P01');
    expect(caught.message).not.toContain('buyer@example.com');
  });
});
