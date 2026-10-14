/**
 * Attachments and a live send claim (PR #6117 round 6). The send's email counts and points to the invoice's
 * attachments at the provider handoff, and the Intelligence Bar approved a fixed list. Two halves:
 *   1. the attachment upload and delete refuse (409 invoice_sending) while the invoice carries a send claim
 *      (status 'sending'), decided on the invoice row locked FOR UPDATE, so it serializes with the claim;
 *   2. the email leg re-reads the list right before the provider call and refuses a different one.
 * Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ s3: { region: 'us-east-1', bucket: 'test-bucket' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => true) }));
const mockS3Send = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: (...args) => mockS3Send(...args) })),
  PutObjectCommand: jest.fn((input) => ({ input })),
  GetObjectCommand: jest.fn((input) => ({ input })),
  DeleteObjectCommand: jest.fn((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../services/pdf/invoice-pdf', () => ({ buildInvoicePDFBuffer: jest.fn(async () => Buffer.from('pdf')), buildReceiptPDFBuffer: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async () => 'https://portal.example.com/l/x'), invoiceShortCodePrefix: jest.fn() }));

const db = require('../models/db');
const InvoiceAttachments = require('../services/invoice-attachments');
const { sendInvoiceEmail } = require('../services/invoice-email');
const { sendTemplate } = require('../services/email-template-library');
const { attachmentsFingerprintDigest, attachmentUploadInFlight } = require('../services/invoice-helpers');
const { recordAuditEvent } = require('../services/audit-log');

const INV = 'inv-1';
const pdf = (overrides = {}) => ({ originalname: 'a.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n', 'ascii'), size: 9, ...overrides });

let invoiceStatus;
let invoiceStamps;
let attachmentRows;
let deleted;
let inserted;
// The invoice row (locked FOR UPDATE in a transaction) and its attachment rows.
function fakeTrx(table) {
  if (table === 'invoices') {
    return { where: () => ({ forUpdate: () => ({ first: async () => ({ id: INV, customer_id: 'cust-1', status: invoiceStatus, ...invoiceStamps }) }) }) };
  }
  return {
    where: () => ({
      first: async () => attachmentRows[0] || null,
      del: async () => { deleted.push('row'); return 1; },
      count: () => ({ sum: () => ({ first: async () => ({ count: attachmentRows.length, total_bytes: 0 }) }) }),
    }),
    insert: () => ({ returning: async () => { inserted.push('row'); return [{ id: 'new' }]; } }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  invoiceStatus = 'draft';
  invoiceStamps = { sent_at: null, sms_sent_at: null, email_sent_at: null };
  attachmentRows = [{ id: 'att-1', invoice_id: INV, file_name: 'a.pdf', s3_key: 'k1', file_size_bytes: 9, updated_at: '2099-01-01T00:00:00Z' }];
  deleted = [];
  inserted = [];
  db.mockImplementation(fakeTrx);
  db.transaction = jest.fn(async (callback) => callback(fakeTrx));
});

describe('attachment upload and delete during a send claim', () => {
  test('upload refuses with 409 invoice_sending while the invoice is being sent, and writes nothing', async () => {
    invoiceStatus = 'sending';
    await expect(InvoiceAttachments.upload({ id: INV }, [pdf()])).rejects.toMatchObject({
      statusCode: 409, code: 'invoice_sending', message: 'This invoice is being sent right now; try again in a minute',
    });
    expect(inserted).toEqual([]);
    // Refused at the reservation, before any storage write (round 8).
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('delete refuses with 409 invoice_sending while the invoice is being sent, and removes neither the file nor the row', async () => {
    invoiceStatus = 'sending';
    await expect(InvoiceAttachments.remove(INV, 'att-1')).rejects.toMatchObject({ statusCode: 409, code: 'invoice_sending' });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  test('outside a send claim both still work', async () => {
    await expect(InvoiceAttachments.upload({ id: INV }, [pdf()])).resolves.toEqual([{ id: 'new' }]);
    expect(inserted).toEqual(['row']);
    await expect(InvoiceAttachments.remove(INV, 'att-1')).resolves.toMatchObject({ id: 'att-1' });
    expect(deleted).toEqual(['row']);
  });

  test('both read the status on the row locked FOR UPDATE (source contract), so the claim UPDATE waits behind them', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../services/invoice-attachments.js'), 'utf8');
    // upload: the reservation transaction and the insert transaction; delete: the removal transaction.
    expect(source.match(/forUpdate\(\)\s*\.first\('id', 'customer_id', 'status', 'sent_at', 'sms_sent_at', 'email_sent_at'\)/g)).toHaveLength(1);
    expect(source).toMatch(/forUpdate\(\)\s*\.first\('id', 'status', 'sent_at', 'sms_sent_at', 'email_sent_at'\)/);
    expect(source).toMatch(/forUpdate\(\)\.first\('id', 'status'\)/);
    expect(source.match(/assertNotBeingSent\((lockedInvoice|locked)\);/g)).toHaveLength(3);
  });
});

describe('round 8: an upload reserves the invoice before its first storage write, and its insert refuses when a send moved the invoice', () => {
  const reservations = () => recordAuditEvent.mock.calls.map(([event]) => event.action);

  test('the reservation is durable before any PutObject, and is released with the insert', async () => {
    const order = [];
    recordAuditEvent.mockImplementation(async (event) => { order.push(event.action); return true; });
    mockS3Send.mockImplementation(async () => { order.push('s3'); return {}; });
    await InvoiceAttachments.upload({ id: INV }, [pdf(), pdf()]);
    expect(order).toEqual(['invoice.attachment_upload_reserved', 's3', 's3', 'invoice.attachment_upload_released']);
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({ resource_type: 'invoices', resource_id: INV, critical: true });
    mockS3Send.mockImplementation(async () => ({}));
  });

  test('a send that finalized while the files were being stored: nothing is inserted, the stored files are removed, the reservation is released', async () => {
    // The send delivers (stamps the invoice) between the first storage write and the insert.
    mockS3Send.mockImplementation(async (command) => {
      if (command.input.Body) { invoiceStatus = 'sent'; invoiceStamps = { sent_at: new Date('2099-01-01T12:00:00Z'), sms_sent_at: null, email_sent_at: null }; }
      return {};
    });
    await expect(InvoiceAttachments.upload({ id: INV }, [pdf()])).rejects.toMatchObject({ statusCode: 409, code: 'invoice_sent_during_upload' });
    expect(inserted).toEqual([]);
    expect(mockS3Send).toHaveBeenCalledTimes(2); // the put, then the cleanup delete
    expect(reservations()).toEqual(['invoice.attachment_upload_reserved', 'invoice.attachment_upload_released']);
    mockS3Send.mockImplementation(async () => ({}));
  });

  test('a send claim that began and ended without delivering does not block the insert (the episode did not move)', async () => {
    mockS3Send.mockImplementation(async (command) => { if (command.input.Body) invoiceStatus = 'draft'; return {}; });
    await expect(InvoiceAttachments.upload({ id: INV }, [pdf()])).resolves.toEqual([{ id: 'new' }]);
    mockS3Send.mockImplementation(async () => ({}));
  });

  test('a reservation that ran out before the insert does not insert', async () => {
    const real = Date.now;
    let calls = 0;
    mockS3Send.mockImplementation(async () => { calls += 1; Date.now = () => real() + 11 * 60 * 1000; return {}; });
    try {
      await expect(InvoiceAttachments.upload({ id: INV }, [pdf()])).rejects.toMatchObject({ code: 'invoice_sent_during_upload' });
    } finally { Date.now = real; mockS3Send.mockImplementation(async () => ({})); }
    expect(calls).toBeGreaterThan(0);
    expect(inserted).toEqual([]);
  });

  test('an upload that finds the invoice already being sent never reserves or stores anything', async () => {
    invoiceStatus = 'sending';
    await expect(InvoiceAttachments.upload({ id: INV }, [pdf()])).rejects.toMatchObject({ code: 'invoice_sending' });
    expect(reservations()).toEqual([]);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('attachmentUploadInFlight: true while a reserved upload has no release row and has not expired', async () => {
    const seen = {};
    const builder = (row) => {
      const b = new Proxy({}, { get: (_t, prop) => {
        if (prop === 'first') return async () => row;
        if (prop === 'where') return (arg, ...rest) => { if (arg && typeof arg === 'object') seen.where = arg; if (rest.length) seen.window = rest; return b; };
        return () => b;
      } });
      return b;
    };
    const asFn = (row) => Object.assign((table) => { seen.table = table; return builder(row); }, { raw: (sql) => sql });
    await expect(attachmentUploadInFlight(asFn({ id: 'r1' }), INV)).resolves.toBe(true);
    expect(seen.where).toMatchObject({ 'r.resource_id': INV, 'r.action': 'invoice.attachment_upload_reserved' });
    await expect(attachmentUploadInFlight(asFn(null), INV)).resolves.toBe(false);
  });
});
