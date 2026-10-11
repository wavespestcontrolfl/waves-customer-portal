/**
 * send_invoice through the REAL /confirm-action route (PR #6117, Codex round 10). A real Confirm carries confirmed:true and
 * the card's _verified_invoice_send_version into the tool: the route strips them in executeApprovedTool, then
 * executeToolByName re-merges the pins and `confirmed` into the input of every two-step tool before dispatch. The commit
 * must reach the Invoices page's send (sendInvoiceFromBar, the call that runs claimInvoiceForSend) with the approved pins,
 * and a model-supplied `confirmed` must not. The send handler itself is mocked; nothing reaches a provider.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockClaimForConfirm = jest.fn();
const mockRecordResult = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false), fastFailResult: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  createPendingAction: jest.fn(),
  claimForConfirm: (...args) => mockClaimForConfirm(...args),
  recordResult: (...args) => mockRecordResult(...args),
  getActionReceipt: jest.fn(async () => null),
  stepKey: jest.fn(() => 'step-1'),
}));

jest.mock('../services/intelligence-bar/tools', () => ({ TOOLS: [], executeTool: jest.fn() }));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({ COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({ LEADS_TOOLS: [], executeLeadsTool: jest.fn() }));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({
  BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com' },
      otheradmin: { id: 'admin-2', role: 'admin', email: 'virginia@wavespestcontrol.com' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
}));

jest.mock('../routes/admin-invoices', () => ({
  getInvoiceDeliveryRecipients: jest.fn(),
  sendInvoiceFromBar: jest.fn(),
}));
jest.mock('../services/invoice-issued-closeout', () => ({ issuedCloseoutTarget: jest.fn(async () => null) }));
jest.mock('../services/lead-estimate-link', () => ({ invoiceSentConversionTargets: jest.fn(async () => ({ leadIds: [] })) }));
jest.mock('../services/invoice-followups', () => ({
  planFollowupSequence: jest.fn(async () => ({ arms: true, state: 'active', cadence: [3, 7, 14, 30] })),
  activePaymentPlan: jest.fn(async () => null),
}));
jest.mock('../services/collections/collection-hold', () => ({ customerHasActiveMessagingHoldChecked: jest.fn(async () => false) }));
jest.mock('../services/invoice-payer-ownership', () => ({ invoicePayerOwnership: jest.fn(async () => null) }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const intelligenceRouter = require('../routes/admin-intelligence-bar');
const { executeInvoiceActionTool } = require('../services/intelligence-bar/invoice-action-tools');
const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
const gates = require('../services/intelligence-bar/write-gates');

const PENDING_ID = '7e1c2f7a-1111-2222-3333-deadbeef0010';
const INV = '00000000-0000-4000-8000-0000000000a1';
const realFetch = global.fetch;
let rows;

// A small knex stand-in over the seeded rows; any other table reads as empty and swallows writes.
function makeDb() {
  return (table) => {
    const name = String(table).split(' as ')[0];
    const q = { wheres: [], single: false };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (res, rej) => Promise.resolve().then(() => {
            const out = (rows[name] || []).filter((row) => q.wheres.every((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v))));
            return q.single ? out[0] : out;
          }).then(res, rej);
        }
        if (prop === 'where') return (arg) => { if (arg && typeof arg === 'object') q.wheres.push(arg); return b; };
        if (prop === 'first') return () => { q.single = true; return b; };
        if (['insert', 'update', 'del'].includes(prop)) { if (rows[name]) throw new Error(`unexpected ${prop} on ${name}`); return async () => undefined; }
        return () => b;
      },
    });
    return b;
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function confirm() {
  const { server, baseUrl } = appServer();
  try {
    const res = await realFetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_action_id: PENDING_ID }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The card exactly as /query would have stored it: the model's params, the card's _version, and the preview fingerprint.
async function storeCard(extraParams = {}) {
  const card = await executeInvoiceActionTool('send_invoice', { invoice_id: INV, confirmed: false }, { isAdmin: true, technicianId: 'admin-1' });
  expect(card.preview).toBe(true);
  mockClaimForConfirm.mockResolvedValue({
    action: {
      id: PENDING_ID, tool_name: 'send_invoice',
      params: { invoice_id: INV, _verified_invoice_send_version: card._version, _two_step_preview_fingerprint: previewFingerprint(card), ...extraParams },
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_INVOICE_ACTIONS = 'true';
  rows = {
    invoices: [{
      id: INV, invoice_number: 'WPC-2099-0001', customer_id: 'cust-1', status: 'draft', total: '129.00', credit_applied: '0.00',
      payer_id: null, payer_statement_id: null, sent_at: null, updated_at: new Date('2099-01-01T12:00:00Z'),
      line_items: JSON.stringify([{ description: 'Quarterly Pest Control', amount: 129 }]),
    }],
    customers: [{ id: 'cust-1', first_name: 'Robin', last_name: 'Sample' }],
    invoice_attachments: [], scheduled_services: [], service_records: [],
  };
  db.mockImplementation(makeDb());
  Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({
    customerName: 'Robin Sample', payerBilled: false, primaryContact: { phone: '9415550100' }, emailRecipient: { email: 'robin@example.com' },
  });
  Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
});
afterEach(() => { delete process.env.GATE_IB_INVOICE_ACTIONS; delete process.env.GATE_IB_PLATFORM; });

describe('send_invoice through /confirm-action', () => {
  test.each([['the legacy dispatcher', undefined], ['the platform registry (GATE_IB_PLATFORM)', 'true']])('a real Confirm reaches the Invoices page send with the approved pins (%s)', async (_label, platform) => {
    if (platform) process.env.GATE_IB_PLATFORM = platform;
    await storeCard();
    const { status, body } = await confirm();
    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
    expect(Invoices.sendInvoiceFromBar).toHaveBeenCalledTimes(1);
    const call = Invoices.sendInvoiceFromBar.mock.calls[0][0];
    expect(call).toMatchObject({ invoiceId: INV, approvedSend: { version: expect.objectContaining({ digest: expect.any(String), closeoutTarget: 'none' }) } });
    expect(body.success).toBe(true);
  });

  test('a card whose live preview changed before Confirm sends nothing', async () => {
    await storeCard();
    rows.invoices[0].total = '140.00';
    const { status, body } = await confirm();
    expect(status).toBe(409);
    expect(body.preview_changed).toBe(true);
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a stored confirmed:true changes nothing: the route supplies the confirmation, and the same checks run', async () => {
    await storeCard({ confirmed: true });
    rows.invoices[0].status = 'viewed';
    const { status, body } = await confirm();
    expect(status).toBe(409);
    expect(body.preview_changed).toBe(true);
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });
});

describe('source contract: the route re-merges the confirmation and the pins for every two-step tool', () => {
  const route = fs.readFileSync(path.join(__dirname, '../routes/admin-intelligence-bar.js'), 'utf8');

  test('send_invoice is a two-step tool', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('send_invoice')).toBe(true);
  });

  test('executeToolByName merges executionPins and confirmed (from actionContext) into the input before dispatch', () => {
    expect(route).toMatch(/input = \{ \.\.\.input, \.\.\.actionContext\.executionPins,\s*\.\.\.\(WRITE_TWO_STEP_TOOL_NAMES\.has\(toolName\) \? \{ confirmed: actionContext\.confirmed === true \} : \{\}\) \};/);
    // The dispatch to the invoice tool comes after that merge.
    expect(route.indexOf('input = { ...input, ...actionContext.executionPins')).toBeLessThan(route.indexOf('executeInvoiceActionTool(toolName, input, actionContext)'));
  });

  test('executeApprovedTool strips confirmed and the underscore pins into executionPins, and the platform registry re-merges them too', () => {
    const approved = route.slice(route.indexOf('function executeApprovedTool('));
    expect(approved.slice(0, approved.indexOf('\n}\n'))).toMatch(/if \(key\.startsWith\('_'\)\) executionPins\[key\] = value;[\s\S]*key !== 'confirmed'/);
    const registry = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/action-registry.js'), 'utf8');
    expect(registry).toMatch(/WRITE_TWO_STEP_TOOL_NAMES\.has\(name\) \? \{ confirmed: actionContext\.confirmed === true \} : \{\}/);
  });
});
