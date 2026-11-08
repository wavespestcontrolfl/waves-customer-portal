/**
 * Sweep #7765 B2: the document request/reminder email and the signed-copy email call sendgrid.sendOne directly, so
 * the local email_suppressions rows (do_not_email, a manual unsubscribe) never stopped them. Both now read the list
 * through the template library's own rules before they send. Runs the real activeSuppressionFor against a fake
 * table. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const mockWrites = [];
let mockRequestRow;
let mockSignedRow;
let mockSuppressions;
let mockSuppressionReadError;
jest.mock('../models/db', () => {
  const builder = (table) => {
    const q = {};
    for (const m of ['leftJoin', 'where', 'whereNull', 'whereIn', 'whereRaw', 'orWhereRaw', 'select', 'orderBy', 'forUpdate']) {
      q[m] = () => q;
    }
    q.first = async () => {
      if (table === 'customer_contracts as cc') return mockSignedRow || mockRequestRow;
      if (table === 'customer_contracts') return { ...mockRequestRow };
      if (table === 'customers') return { first_name: 'Pat', last_name: 'Sample', email: 'pat@example.com' };
      return null;
    };
    q.then = (resolve, reject) => {
      if (table !== 'email_suppressions') return Promise.resolve([]).then(resolve, reject);
      if (mockSuppressionReadError) return Promise.reject(mockSuppressionReadError).then(resolve, reject);
      return Promise.resolve(mockSuppressions).then(resolve, reject);
    };
    q.update = async (payload) => { mockWrites.push({ table, op: 'update', payload }); return 1; };
    q.insert = async (payload) => { mockWrites.push({ table, op: 'insert', payload }); return [1]; };
    q.del = async () => 1;
    return q;
  };
  const db = jest.fn((table) => builder(table));
  db.transaction = async (cb) => cb(db);
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: () => new Date() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-1' })) }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendOne: jest.fn().mockResolvedValue({ messageId: 'sg-1' }),
  serviceGroupId: () => 101,
  newsletterGroupId: () => 202,
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true, providerMessageId: 'tw-1' }),
}));
jest.mock('../services/pdf/contract-pdf', () => ({ buildContractPDFBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) }));

const sendgrid = require('../services/sendgrid-mail');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { deliverDocumentRequestChannels } = require('../services/document-contract-delivery');
const { sendSignedContractCopy } = require('../services/contract-signed-email');

const EMAIL = 'pat@example.com';
const PHONE = '+19415550100';

function suppression(type, groupKey = null) {
  return { id: `s-${type}`, email: EMAIL, suppression_type: type, group_key: groupKey, status: 'active' };
}

const failedEvents = () => mockWrites.filter((w) => w.table === 'customer_contract_events' && w.op === 'insert'
  && w.payload.event_type === 'delivery_failed');

beforeEach(() => {
  jest.clearAllMocks();
  mockWrites.length = 0;
  mockSuppressions = [];
  mockSuppressionReadError = null;
  mockSignedRow = null;
  mockRequestRow = {
    id: 'contract-1', customer_id: 'cust-1', contract_type: 'document_template', status: 'sent',
    document_template_key: 'sample_document', title: 'Sample Agreement', requires_signature_snapshot: true,
    customer_first_name: 'Pat', customer_last_name: 'Sample', customer_email: EMAIL, customer_phone: PHONE,
    template_expire_after_days: 14,
  };
});

describe('document request and reminder email', () => {
  test('a do_not_email row refuses the email, raises the blocked-send alert, and the text still goes out', async () => {
    mockSuppressions = [suppression('do_not_email')];
    const result = await deliverDocumentRequestChannels('contract-1', { actorType: 'system' }, { channels: ['email', 'sms'] });

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.deliveries.find((d) => d.channel === 'email')).toMatchObject({ ok: false, code: 'EMAIL_SUPPRESSED' });
    expect(failedEvents().map((w) => JSON.parse(w.payload.metadata).code)).toEqual(['EMAIL_SUPPRESSED']);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][1]).toBe('Email blocked by suppression');
  });

  test('a manual unsubscribe with no group refuses it too (the service stream)', async () => {
    mockSuppressions = [suppression('unsubscribe')];
    const result = await deliverDocumentRequestChannels('contract-1', { actorType: 'admin' }, { channels: ['email'] });

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.deliveries).toEqual([expect.objectContaining({ channel: 'email', code: 'EMAIL_SUPPRESSED' })]);
  });

  test('a marketing-only unsubscribe does not stop a document email', async () => {
    mockSuppressions = [suppression('unsubscribe', 'marketing_newsletter')];
    const result = await deliverDocumentRequestChannels('contract-1', { actorType: 'admin' }, { channels: ['email'] });

    expect(result.ok).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed suppression read sends nothing and names the reason', async () => {
    mockSuppressionReadError = new Error(`select * from email_suppressions where LOWER(email) = '${EMAIL}'`);
    const result = await deliverDocumentRequestChannels('contract-1', { actorType: 'admin' }, { channels: ['email'] });

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.deliveries).toEqual([expect.objectContaining({ code: 'EMAIL_PREFLIGHT_UNAVAILABLE' })]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(EMAIL);
  });
});

describe('signed-copy email', () => {
  beforeEach(() => {
    mockSignedRow = { id: 'contract-2', customer_id: 'cust-1', status: 'signed', contract_type: 'document_template', title: 'Sample Agreement' };
  });

  test('a do_not_email row stops the signed copy and raises the alert', async () => {
    mockSuppressions = [suppression('do_not_email')];
    const result = await sendSignedContractCopy('contract-2');

    expect(result).toEqual({ ok: false, skipped: 'recipient_suppressed' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a service unsubscribe does not stop the signer\'s only signed copy', async () => {
    mockSuppressions = [suppression('unsubscribe'), suppression('unsubscribe', 'service_operational')];
    const result = await sendSignedContractCopy('contract-2');

    expect(result.ok).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne.mock.calls[0][0].asmGroupId).toBe(0);
  });

  test('a failed suppression read sends nothing', async () => {
    mockSuppressionReadError = new Error(`select * from email_suppressions where LOWER(email) = '${EMAIL}'`);
    const result = await sendSignedContractCopy('contract-2');

    expect(result).toEqual({ ok: false, error: 'suppression_check_failed' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(EMAIL);
  });
});
