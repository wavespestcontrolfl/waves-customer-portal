// Email Reclassify with a staff-picked label (GATE_EMAIL_RECLASSIFY_PICK).
// Route-level: no network, no real DB. The auto-action, the quarantine cancel
// and the sender unblock are mocked so the test can name exactly which run.
const mockState = { emails: [], inserts: [], insertError: null, blocked: null };
jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    const builder = {
      where() { return builder; },
      whereRaw() { return builder; },
      first: async () => {
        if (table === 'emails') return mockState.emails[0] ? { ...mockState.emails[0] } : undefined;
        if (table === 'blocked_email_senders') return mockState.blocked;
        return undefined;
      },
      update: jest.fn(async (patch) => { mockState.updates.push({ table, patch }); return 1; }),
      insert: jest.fn(async (row) => {
        if (mockState.insertError) throw mockState.insertError;
        mockState.inserts.push({ table, row });
      }),
    };
    return builder;
  });
  return dbFn;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.technicianId = 'staff-1'; req.techRole = 'admin'; next(); },
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn(), getMessageLabels: jest.fn(async () => []) }));
jest.mock('../services/email/email-sync', () => ({ syncEmails: jest.fn() }));
jest.mock('../services/email/email-classifier', () => ({
  ...jest.requireActual('../services/email/email-classifier'),
  classifyEmailContent: jest.fn(),
  classifyEmail: jest.fn(),
}));
jest.mock('../services/email/email-actions', () => ({ executeAutoAction: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/email/spam-blocker', () => ({ unblockSender: jest.fn(async () => ({ success: true })), manualBlockSender: jest.fn() }));
jest.mock('../services/email/inbox-hygiene', () => ({ cancelQuarantine: jest.fn(async () => {}), settleDeferredBlock: jest.fn() }));
jest.mock('../services/staff-oauth-state', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const logger = require('../services/logger');
const { EMAIL_CATEGORIES, classifyEmailContent } = require('../services/email/email-classifier');
const { executeAutoAction } = require('../services/email/email-actions');
const { unblockSender } = require('../services/email/spam-blocker');
const { cancelQuarantine } = require('../services/email/inbox-hygiene');

const app = express();
app.use(express.json());
app.use('/api/admin/email', require('../routes/admin-email'));
let server;
beforeAll((done) => { server = app.listen(0, '127.0.0.1', done); });
afterAll((done) => { server.close(done); });

const EMAIL_ID = '11111111-1111-4111-8111-111111111111';
const aiResult = { category: 'other', confidence: 0.4, summary: 'Synthetic summary', extracted: { person_name: 'Fixture Person' } };
const quarantinedSpam = () => ({
  id: EMAIL_ID, gmail_id: 'g1', from_address: 'sender@example.invalid', subject: 'Fixture',
  classification: 'spam', classification_confidence: 0.91, extracted_data: aiResult,
  auto_action: 'spam_quarantined', quarantined_at: new Date(), received_at: new Date('2026-11-01T12:00:00Z'),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockState.emails = [quarantinedSpam()];
  mockState.inserts = [];
  mockState.updates = [];
  mockState.insertError = null;
  mockState.blocked = { id: 'block-1' };
  classifyEmailContent.mockResolvedValue({ ...aiResult, category: 'customer_request', confidence: 0.8 });
});
afterEach(() => { delete process.env.GATE_EMAIL_RECLASSIFY_PICK; });

const post = async (body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/email/message/${EMAIL_ID}/reclassify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/email${path}`);
  return { status: res.status, body: await res.json() };
};
const emailUpdate = () => mockState.updates.filter((u) => u.table === 'emails' && u.patch.classification).map((u) => u.patch);

it('keeps every failure_mode inside the ai_incidents column (60 chars)', () => {
  const longest = Math.max(...EMAIL_CATEGORIES.flatMap((a) => EMAIL_CATEGORIES.map((b) => `${a}_should_be_${b}`.length)));
  expect(longest).toBeLessThanOrEqual(60);
  expect(`email:${EMAIL_ID}:classification`.length).toBeLessThanOrEqual(64);
});

describe('gate off', () => {
  it('ignores a label in the body: the AI runs, no incident is stored', async () => {
    const res = await post({ classification: 'lead_inquiry' });
    expect(res.status).toBe(200);
    expect(res.body.classification).toMatchObject({ category: 'customer_request', confidence: 0.8 });
    expect(classifyEmailContent).toHaveBeenCalledTimes(1);
    expect(emailUpdate()).toHaveLength(1);
    expect(emailUpdate()[0]).toMatchObject({ classification: 'customer_request', classification_confidence: 0.8 });
    expect(JSON.parse(emailUpdate()[0].extracted_data)).toEqual({ ...aiResult, category: 'customer_request', confidence: 0.8 });
    expect(mockState.inserts).toEqual([]);
  });

  it('gives the picker nothing to show', async () => {
    expect(await get('/reclassify-options')).toEqual({ status: 200, body: { enabled: false } });
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_EMAIL_RECLASSIFY_PICK = 'true'; });

  it('offers the classifier label list', async () => {
    expect(await get('/reclassify-options')).toEqual({ status: 200, body: { enabled: true, categories: EMAIL_CATEGORIES } });
  });

  it('without a label still runs the AI, as today', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(classifyEmailContent).toHaveBeenCalledTimes(1);
    expect(mockState.inserts).toEqual([]);
  });

  it('sets the picked label, runs the same post-label steps, and stores one incident', async () => {
    const res = await post({ classification: 'lead_inquiry' });
    expect(res.status).toBe(200);
    expect(res.body.classification).toMatchObject({ category: 'lead_inquiry', confidence: 1, staff_label: true, ai_label: 'spam', ai_confidence: 0.91 });
    expect(classifyEmailContent).not.toHaveBeenCalled();
    expect(emailUpdate()).toHaveLength(1);
    expect(emailUpdate()[0]).toMatchObject({ classification: 'lead_inquiry', classification_confidence: 1 });
    // The AI's extracted entities are kept for the lead handler.
    expect(JSON.parse(emailUpdate()[0].extracted_data).extracted).toEqual(aiResult.extracted);

    // Same steps as an AI relabel to a non-spam label.
    expect(executeAutoAction).toHaveBeenCalledTimes(1);
    expect(executeAutoAction.mock.calls[0][1]).toMatchObject({ category: 'lead_inquiry' });
    expect(unblockSender).toHaveBeenCalledWith('block-1');
    expect(cancelQuarantine).toHaveBeenCalledTimes(1);

    expect(mockState.inserts).toHaveLength(1);
    const { table, row } = mockState.inserts[0];
    expect(table).toBe('ai_incidents');
    expect(row).toMatchObject({
      area: 'email',
      evidence_type: 'staff_reclassify',
      incident_key: `email:${EMAIL_ID}:classification`,
      disposition: 'confirmed_mistake',
      surface: 'email_classify',
      failure_mode: 'spam_should_be_lead_inquiry',
      intent: null,
      prompt_version: null,
      model: null,
      produced_at: new Date('2026-11-01T12:00:00Z'),
      summary: 'email_classify: the AI said spam, staff picked lead_inquiry.',
      schema_version: 'ai-incidents.v1',
    });
    expect(row.evidence_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(row.adjudication)).toEqual({
      rule: 'staff_label', ai_label: 'spam', staff_label: 'lead_inquiry', ai_confidence: 0.91, staff_user_id: 'staff-1',
    });
  });

  it('gives each pick its own evidence id', async () => {
    await post({ classification: 'lead_inquiry' });
    await post({ classification: 'complaint' });
    const ids = mockState.inserts.map((i) => i.row.evidence_id);
    expect(new Set(ids).size).toBe(2);
  });

  it.each([['an unknown label', 'not_a_label'], ['a non-string', 7], ['an object', { category: 'spam' }]])('refuses %s with 400 and changes nothing', async (_n, value) => {
    const res = await post({ classification: value });
    expect(res).toEqual({ status: 400, body: { error: 'Unknown email label' } });
    expect(mockState.updates).toEqual([]);
    expect(mockState.inserts).toEqual([]);
    expect(classifyEmailContent).not.toHaveBeenCalled();
    expect(executeAutoAction).not.toHaveBeenCalled();
  });

  it('stores no incident when the pick equals the AI label', async () => {
    mockState.emails = [{ ...quarantinedSpam(), classification: 'complaint' }];
    const res = await post({ classification: 'complaint' });
    expect(res.status).toBe(200);
    expect(mockState.inserts).toEqual([]);
    expect(executeAutoAction).toHaveBeenCalledTimes(1);
  });

  it('reads the AI label from the kept ai_label after an earlier pick', async () => {
    mockState.emails = [{
      ...quarantinedSpam(), classification: 'lead_inquiry', classification_confidence: 1,
      extracted_data: { ...aiResult, category: 'lead_inquiry', staff_label: true, ai_label: 'spam', ai_confidence: 0.91 },
    }];
    await post({ classification: 'spam' });
    expect(mockState.inserts).toEqual([]);
    await post({ classification: 'complaint' });
    expect(mockState.inserts[0].row.failure_mode).toBe('spam_should_be_complaint');
  });

  it('stores no incident when the email has no AI label (known-vendor stamp)', async () => {
    mockState.emails = [{ ...quarantinedSpam(), classification: 'vendor', extracted_data: null, auto_action: null, quarantined_at: null }];
    const res = await post({ classification: 'vendor_invoice' });
    expect(res.status).toBe(200);
    expect(mockState.inserts).toEqual([]);
  });

  it('still reclassifies when the incident insert fails', async () => {
    mockState.insertError = Object.assign(new Error('boom'), { code: '23505' });
    const res = await post({ classification: 'lead_inquiry' });
    expect(res.status).toBe(200);
    expect(res.body.classification.category).toBe('lead_inquiry');
    expect(executeAutoAction).toHaveBeenCalledTimes(1);
    expect(cancelQuarantine).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('incident not stored'));
  });
});
