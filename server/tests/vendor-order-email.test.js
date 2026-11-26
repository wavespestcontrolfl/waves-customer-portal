/**
 * "Email the SiteOne order" (GATE_SITEONE_EMAIL_ORDER), the parts that need no
 * database: the email text and PO, both payment variants, the routes' auth and
 * gate. The claim, stamp and refusal paths run against Postgres in
 * vendor-order-email-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => ({ sql }));
  db.schema = { hasTable: jest.fn(async () => true) };
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Role comes from a header so one router instance can be hit as either role.
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.techRole = req.headers['x-test-role'];
      req.technicianId = 'tech-1';
      req.technician = { id: 'tech-1', name: 'Test Admin' };
      next();
    },
  };
});
jest.mock('../services/procurement/vendor-order-email', () => {
  const actual = jest.requireActual('../services/procurement/vendor-order-email');
  return { ...actual, previewOrderEmail: jest.fn(), sendOrderEmail: jest.fn() };
});

const express = require('express');
const emailSvc = require('../services/procurement/vendor-order-email');
const inventoryRouter = require('../routes/admin-inventory');

const { buildSiteOneOrderEmail, purchaseOrderFor } = emailSvc;
const REQUEST_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const FACTS = {
  requestId: REQUEST_ID, accountNumber: '123456', packages: 6, itemNumber: '098604',
  productName: 'Sample Granular Fertilizer', packSize: '50 lb', unitPrice: '24.50',
};

describe('buildSiteOneOrderEmail', () => {
  test('subject, PO, item line, pickup payment and the close', () => {
    const out = buildSiteOneOrderEmail(FACTS, {});
    expect(out.po).toBe('WAVES-A1B2C3D4');
    expect(purchaseOrderFor(REQUEST_ID)).toBe('WAVES-A1B2C3D4');
    expect(out.subject).toBe('Pickup order: Waves Pest Control, account 123456, PO WAVES-A1B2C3D4');
    expect(out.packages).toBe(6);
    expect(out.itemNumber).toBe('098604');
    expect(out.text).toContain('Please prepare this order for pickup at Lakewood Ranch #238, 5115 Lena Rd.');
    expect(out.text).toContain('Account: 123456');
    expect(out.text).toContain('PO: WAVES-A1B2C3D4');
    expect(out.text).toContain('6 x 098604 Sample Granular Fertilizer (50 lb)');
    expect(out.text).toContain('We will pay at pickup.');
    expect(out.text).toContain('Please reply to confirm and tell us when it is ready.');
    expect(out.text).toContain('Waves Pest Control');
    expect(out.text).toContain('(941) 297-5749');
    expect(out.html).toContain('6 x 098604 Sample Granular Fertilizer (50 lb)');
  });

  test('the estimate is packages x price in cents and is not in the email', () => {
    const out = buildSiteOneOrderEmail(FACTS, {});
    expect(out.estimateCents).toBe(14700);
    expect(out.text).not.toMatch(/147|24\.50|estimate/i);
    expect(out.html).not.toMatch(/147|24\.50|estimate/i);
    expect(buildSiteOneOrderEmail({ ...FACTS, unitPrice: null }, {}).estimateCents).toBeNull();
  });

  test('SITEONE_ORDER_BRANCH replaces the default branch', () => {
    const out = buildSiteOneOrderEmail(FACTS, { SITEONE_ORDER_BRANCH: 'Sample Branch #1, 1 Example Rd' });
    expect(out.text).toContain('pickup at Sample Branch #1, 1 Example Rd.');
    expect(out.text).not.toContain('Lena Rd');
  });

  test('card_on_file names the last four digits', () => {
    const out = buildSiteOneOrderEmail(FACTS, { SITEONE_ORDER_PAYMENT: 'card_on_file', SITEONE_ORDER_CARD_LAST4: '4242' });
    expect(out.text).toContain('Please charge the card on file ending 4242.');
    expect(out.text).not.toContain('We will pay at pickup.');
  });

  test.each([undefined, '', '42', '42424', 'abcd', '42 42'])('card_on_file with last4 %p refuses', (last4) => {
    expect(() => buildSiteOneOrderEmail(FACTS, { SITEONE_ORDER_PAYMENT: 'card_on_file', SITEONE_ORDER_CARD_LAST4: last4 }))
      .toThrow(expect.objectContaining({ statusCode: 409, code: 'card_last4_required' }));
  });

  test('an unknown payment setting refuses instead of guessing', () => {
    expect(() => buildSiteOneOrderEmail(FACTS, { SITEONE_ORDER_PAYMENT: 'invoice' }))
      .toThrow(expect.objectContaining({ statusCode: 409, code: 'payment_setting_invalid' }));
  });

  test('a product name cannot break the subject or inject markup', () => {
    const out = buildSiteOneOrderEmail({ ...FACTS, accountNumber: '12\r\nBcc: x@example.com', productName: '<b>Bold</b>\nName' }, {});
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.html).toContain('&lt;b&gt;Bold&lt;/b&gt; Name');
    expect(out.html).not.toContain('<b>Bold');
  });
});

describe('siteone-email routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/admin/inventory', inventoryRouter);
  app.use((err, _req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.message }));
  let server;
  let base;
  beforeAll(() => new Promise((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); }));
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  beforeEach(() => {
    delete process.env.GATE_SITEONE_EMAIL_ORDER;
    emailSvc.previewOrderEmail.mockReset();
    emailSvc.sendOrderEmail.mockReset();
  });
  afterAll(() => { delete process.env.GATE_SITEONE_EMAIL_ORDER; });

  const call = (method, role, body = '{}') => fetch(`${base}/admin/inventory/restock-requests/${REQUEST_ID}/siteone-email`, {
    method, headers: { 'x-test-role': role, 'content-type': 'application/json' }, ...(method === 'POST' ? { body } : {}),
  });

  test.each(['GET', 'POST'])('a technician gets 403 on %s, even with the gate on', async (method) => {
    process.env.GATE_SITEONE_EMAIL_ORDER = 'true';
    const res = await call(method, 'technician');
    expect(res.status).toBe(403);
    expect(emailSvc.previewOrderEmail).not.toHaveBeenCalled();
    expect(emailSvc.sendOrderEmail).not.toHaveBeenCalled();
  });

  test.each(['GET', 'POST'])('the gate off answers 404 on %s, before any work', async (method) => {
    const res = await call(method, 'admin');
    expect(res.status).toBe(404);
    expect(emailSvc.previewOrderEmail).not.toHaveBeenCalled();
    expect(emailSvc.sendOrderEmail).not.toHaveBeenCalled();
  });

  test('an admin gets the preview', async () => {
    process.env.GATE_SITEONE_EMAIL_ORDER = 'true';
    emailSvc.previewOrderEmail.mockResolvedValue({ po: 'WAVES-A1B2C3D4', packages: 6 });
    const res = await call('GET', 'admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preview: { po: 'WAVES-A1B2C3D4', packages: 6 } });
    expect(emailSvc.previewOrderEmail).toHaveBeenCalledWith(REQUEST_ID);
  });

  test('an admin send passes the actor and returns the result', async () => {
    process.env.GATE_SITEONE_EMAIL_ORDER = 'true';
    emailSvc.sendOrderEmail.mockResolvedValue({ ok: true, email: { id: 'e1', po: 'WAVES-A1B2C3D4' }, messageId: 'm1', requestMarked: true });
    const res = await call('POST', 'admin', JSON.stringify({ version: 'v-abc123' }));
    expect(res.status).toBe(200);
    expect((await res.json()).email.po).toBe('WAVES-A1B2C3D4');
    expect(emailSvc.sendOrderEmail).toHaveBeenCalledWith(REQUEST_ID, { actor: 'Test Admin', actorId: 'tech-1', version: 'v-abc123' });
  });

  test('a refusal answers its status with the message and code', async () => {
    process.env.GATE_SITEONE_EMAIL_ORDER = 'true';
    emailSvc.previewOrderEmail.mockRejectedValue(Object.assign(new Error('Only an open request can be emailed to SiteOne (this one is ordered).'), { statusCode: 409, code: 'request_not_open' }));
    const res = await call('GET', 'admin');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Only an open request can be emailed to SiteOne (this one is ordered).', code: 'request_not_open' });
  });
});
