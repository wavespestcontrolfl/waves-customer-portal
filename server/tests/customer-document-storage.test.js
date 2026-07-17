process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client, command) => `https://signed.example/${command.input.Key}`),
}));

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const PhotoService = require('../services/photos');
const documentsRouter = require('../routes/documents');

describe('customer document object storage', () => {
  test('only advertises a stored document when it has a durable object key', () => {
    const { storedDocumentHasFile } = documentsRouter._test;

    expect(storedDocumentHasFile({ s3_key: 'customer-documents/cust-1/agreement.pdf' })).toBe(true);
    expect(storedDocumentHasFile({ s3_key: '   ' })).toBe(false);
    expect(storedDocumentHasFile({ s3_key: null })).toBe(false);
  });

  test('presigns the private object with an attachment filename', async () => {
    const url = await PhotoService.getDownloadUrl(
      'customer-documents/cust-1/agreement.pdf',
      'Agreement\r\nmalicious.pdf',
      600,
    );

    expect(url).toBe('https://signed.example/customer-documents/cust-1/agreement.pdf');
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, options] = getSignedUrl.mock.calls[0];
    expect(command.input).toMatchObject({
      Key: 'customer-documents/cust-1/agreement.pdf',
      ResponseContentDisposition: 'attachment; filename="Agreement__malicious.pdf"',
    });
    expect(options).toEqual({ expiresIn: 600 });
  });
});
