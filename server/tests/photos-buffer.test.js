// server/services/photos.js is THE S3 reader for a private photo object's
// bytes (Codex round-4 P2 on PR #4725: admin-photo-assessments.js used to
// carry its own second S3Client + stream-reader for the message_photos
// path; removed in favor of this one). getPhotoBuffer is the shared
// primitive; getPhotoBase64 is refactored to call it so there is exactly
// one reader. This file exercises the REAL module against a mocked
// @aws-sdk/client-s3 — other suites (vision-delta.test.js etc.) mock
// '../services/photos' wholesale and never touch this implementation.

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input) => ({ __put: input })),
  GetObjectCommand: jest.fn((input) => ({ __get: input })),
  DeleteObjectCommand: jest.fn((input) => ({ __delete: input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/photo.jpg'),
}));
jest.mock('../config', () => ({
  s3: { region: 'us-east-1', accessKeyId: 'test-key', secretAccessKey: 'test-secret', bucket: 'test-bucket', photoPrefix: 'service-photos/' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const PhotoService = require('../services/photos');

beforeEach(() => {
  mockS3Send.mockReset();
});

describe('getPhotoBuffer', () => {
  test('fetches the object and returns { buffer, contentType }', async () => {
    mockS3Send.mockResolvedValue({
      Body: { transformToByteArray: async () => Uint8Array.from(Buffer.from('raw-bytes')) },
      ContentType: 'image/png',
    });
    const result = await PhotoService.getPhotoBuffer('some/key.png');
    expect(result.buffer).toEqual(Buffer.from('raw-bytes'));
    expect(result.contentType).toBe('image/png');
    expect(mockS3Send).toHaveBeenCalledWith({ __get: { Bucket: 'test-bucket', Key: 'some/key.png' } });
  });

  test('defaults contentType to image/jpeg when S3 supplies none', async () => {
    mockS3Send.mockResolvedValue({
      Body: { transformToByteArray: async () => Uint8Array.from(Buffer.from('x')) },
      ContentType: null,
    });
    const result = await PhotoService.getPhotoBuffer('some/key');
    expect(result.contentType).toBe('image/jpeg');
  });

  test('propagates an S3 failure (no swallowing — callers decide how to respond)', async () => {
    mockS3Send.mockRejectedValue(new Error('NoSuchKey'));
    await expect(PhotoService.getPhotoBuffer('missing/key')).rejects.toThrow('NoSuchKey');
  });
});

describe('getPhotoBase64 (refactored to call getPhotoBuffer)', () => {
  test('returns the same bytes base64-encoded with the object\'s content type as mimeType', async () => {
    mockS3Send.mockResolvedValue({
      Body: { transformToByteArray: async () => Uint8Array.from(Buffer.from('hello')) },
      ContentType: 'image/webp',
    });
    const result = await PhotoService.getPhotoBase64('some/key.webp');
    expect(result).toEqual({ data: Buffer.from('hello').toString('base64'), mimeType: 'image/webp' });
  });

  test('propagates a failure from the underlying getPhotoBuffer read', async () => {
    mockS3Send.mockRejectedValue(new Error('AccessDenied'));
    await expect(PhotoService.getPhotoBase64('some/key')).rejects.toThrow('AccessDenied');
  });
});
