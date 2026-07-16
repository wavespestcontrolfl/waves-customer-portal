const {
  MAX_PHOTO_BYTES,
  decodedBase64Bytes,
  validateRequestPhoto,
  validateRequestPhotos,
} = require('../utils/request-photo-validation');

const dataUrl = (type, bytes) => `data:image/${type};base64,${bytes.toString('base64')}`;

describe('customer service-request photo validation', () => {
  test('accepts supported images and keeps their original data URLs', () => {
    const photo = dataUrl('png', Buffer.from('valid image bytes'));

    expect(validateRequestPhotos([photo])).toEqual({ ok: true, photos: [photo] });
  });

  test('rejects an oversized image instead of silently dropping it', () => {
    const base64 = 'A'.repeat(Math.ceil(((MAX_PHOTO_BYTES + 1) * 4) / 3 / 4) * 4);
    const result = validateRequestPhotos([`data:image/jpeg;base64,${base64}`]);

    expect(decodedBase64Bytes(base64)).toBeGreaterThan(MAX_PHOTO_BYTES);
    expect(result).toMatchObject({
      ok: false,
      status: 413,
      error: 'Each photo must be 5 MB or smaller.',
      photoIndex: 0,
    });
  });

  test('rejects unsupported media and malformed base64 with actionable errors', () => {
    expect(validateRequestPhoto('data:image/gif;base64,R0lGODlh')).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(validateRequestPhoto('data:image/png;base64,not-base64!')).toMatchObject({
      ok: false,
      status: 400,
      error: 'One of the attached photos could not be read.',
    });
  });

  test('rejects more than three photos as one explicit validation failure', () => {
    const photo = dataUrl('webp', Buffer.from('valid image bytes'));
    expect(validateRequestPhotos([photo, photo, photo, photo])).toEqual({
      ok: false,
      status: 400,
      error: 'Attach no more than 3 photos.',
    });
  });
});
