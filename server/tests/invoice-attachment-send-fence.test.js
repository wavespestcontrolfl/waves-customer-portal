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
const { attachmentsFingerprintDigest } = require('../services/invoice-helpers');

const INV = 'inv-1';
const pdf = (overrides = {}) => ({ originalname: 'a.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n', 'ascii'), size: 9, ...overrides });

let invoiceStatus;
let attachmentRows;
let deleted;
let inserted;
// The invoice row (locked FOR UPDATE in a transaction) and its attachment rows.
function fakeTrx(table) {
  if (table === 'invoices') {
    return { where: () => ({ forUpdate: () => ({ first: async () => ({ id: INV, customer_id: 'cust-1', status: invoiceStatus }) }) }) };
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
    // The object it had already stored is cleaned up.
    expect(mockS3Send).toHaveBeenCalledTimes(2);
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
    expect(source.match(/forUpdate\(\)\.first\('id', 'customer_id', 'status'\)/g)).toHaveLength(1);
    expect(source).toMatch(/forUpdate\(\)\.first\('id', 'status'\)/);
    expect(source.match(/assertNotBeingSent\(lockedInvoice\);/g)).toHaveLength(2);
  });
});

describe('the email leg re-checks the approved attachment list before the provider call', () => {
  const rows = [{ id: 'att-1', file_name: 'a.pdf', file_size_bytes: 9, updated_at: '2099-01-01T00:00:00Z' }];
  function wire(currentRows) {
    const chain = (result) => {
      const c = { where: () => c, whereIn: () => c, whereRaw: () => c, orderBy: () => c, select: () => c, first: async () => result, update: async () => 1, catch: (h) => Promise.resolve(result).catch(h) };
      return c;
    };
    db.mockImplementation((table) => {
      if (table === 'invoices') return chain({ id: 'inv-1', customer_id: 'cust-1', invoice_number: 'INV-1', token: 't', total: 100, line_items: [] });
      if (table === 'customers') return chain({ id: 'cust-1', first_name: 'Lana', email: 'lana@example.com' });
      if (table === 'notification_prefs') return chain({ billing_email: 'billing@example.com', billing_contact_name: 'Billing' });
      if (table === 'invoice_attachments') {
        const c = chain(null);
        c.select = () => Promise.resolve(currentRows);
        return c;
      }
      return chain(null);
    });
  }

  test('the same list goes on; a swapped, added or removed file aborts with approved_version_changed', async () => {
    const approved = attachmentsFingerprintDigest(rows);
    wire(rows);
    const same = await sendInvoiceEmail('inv-1', { expectedAttachments: approved });
    expect(same.code).not.toBe('approved_version_changed');
    for (const changed of [[{ ...rows[0], id: 'att-9' }], [...rows, { id: 'att-2', file_name: 'b.pdf', file_size_bytes: 1, updated_at: null }], []]) {
      sendTemplate.mockClear();
      wire(changed);
      await expect(sendInvoiceEmail('inv-1', { expectedAttachments: approved })).resolves.toMatchObject({ ok: false, blocked: true, code: 'approved_version_changed' });
      expect(sendTemplate).not.toHaveBeenCalled();
    }
  });

  test('a page send (no approved list) is not checked', async () => {
    wire([{ ...rows[0], id: 'whatever' }]);
    const result = await sendInvoiceEmail('inv-1', {});
    expect(result.code).not.toBe('approved_version_changed');
  });
});
