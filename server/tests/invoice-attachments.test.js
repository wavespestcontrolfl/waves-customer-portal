jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({
  s3: {
    region: 'us-east-1',
    bucket: 'test-bucket',
  },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const InvoiceAttachments = require('../services/invoice-attachments');

const {
  assertAttachmentBudget,
  detectedMimeFromBuffer,
  validateAttachmentFile,
} = InvoiceAttachments._private;

describe('invoice attachment validation', () => {
  const pdfBuffer = Buffer.from('%PDF-1.4\n', 'ascii');
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const uploadFile = ({ originalname = 'invoice.pdf', mimetype = 'application/pdf', buffer = pdfBuffer, size = buffer.length } = {}) => ({
    originalname,
    mimetype,
    buffer,
    size,
  });

  test('detects the supported invoice attachment signatures', () => {
    expect(detectedMimeFromBuffer(jpegBuffer)).toBe('image/jpeg');
    expect(detectedMimeFromBuffer(pngBuffer)).toBe('image/png');
    expect(detectedMimeFromBuffer(Buffer.from('GIF89a0000', 'ascii'))).toBe('image/gif');
    expect(detectedMimeFromBuffer(Buffer.from('BM0000', 'ascii'))).toBe('image/bmp');
    expect(detectedMimeFromBuffer(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('image/tiff');
    expect(detectedMimeFromBuffer(pdfBuffer)).toBe('application/pdf');
  });

  test('requires a supported declared type and supported file content', () => {
    expect(validateAttachmentFile(uploadFile())).toBe('application/pdf');
    expect(validateAttachmentFile(uploadFile({
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      buffer: jpegBuffer,
    }))).toBe('image/jpeg');

    expect(() => validateAttachmentFile(uploadFile({
      originalname: 'malware.exe',
      mimetype: 'application/octet-stream',
      buffer: pdfBuffer,
    }))).toThrow('Supported attachment types are JPG, PNG, GIF, TIFF, BMP, and PDF');

    expect(() => validateAttachmentFile(uploadFile({
      originalname: 'invoice.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('not a real PDF', 'ascii'),
    }))).toThrow('Attachment content is not a supported file type');
  });

  test('enforces count and aggregate size budgets', () => {
    const oneBytePdf = uploadFile({ size: 1 });
    expect(() => assertAttachmentBudget({ count: 9, totalBytes: 0 }, [oneBytePdf])).not.toThrow();
    expect(() => assertAttachmentBudget({ count: 9, totalBytes: 0 }, [oneBytePdf, oneBytePdf]))
      .toThrow('Invoices can have at most 10 attachments');

    expect(() => assertAttachmentBudget(
      { count: 0, totalBytes: InvoiceAttachments.MAX_ATTACHMENT_TOTAL_BYTES - 100 },
      [uploadFile({ size: 100 })],
    )).not.toThrow();
    expect(() => assertAttachmentBudget(
      { count: 0, totalBytes: InvoiceAttachments.MAX_ATTACHMENT_TOTAL_BYTES - 100 },
      [uploadFile({ size: 101 })],
    )).toThrow('Invoice attachments cannot total more than 25 MB');
  });
});
