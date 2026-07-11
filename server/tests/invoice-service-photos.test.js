// Invoice service-photo snapshots: the snapshot persists the durable s3_key
// and the read path presigns FRESH at view time (presign-first,
// stored-URL-last) — stored presigned URLs expire, and new uploads never
// populate s3_url at all, so serving the snapshot verbatim renders blank.

jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(),
}));
jest.mock('../config', () => ({
  s3: { bucket: 'waves-test-bucket' },
}));

const PhotoService = require('../services/photos');
const {
  _s3KeyFromStoredUrl: s3KeyFromStoredUrl,
  _withFreshServicePhotoUrls: withFreshServicePhotoUrls,
} = require('../services/invoice');

beforeEach(() => {
  jest.clearAllMocks();
  PhotoService.getViewUrl.mockResolvedValue('https://signed.example/fresh');
});

describe('s3KeyFromStoredUrl', () => {
  it('recovers the key from a virtual-hosted-style presigned URL', () => {
    expect(
      s3KeyFromStoredUrl(
        'https://waves-test-bucket.s3.us-east-1.amazonaws.com/service-photos/rec1/123-abc-photo.jpg?X-Amz-Expires=900&X-Amz-Signature=dead',
      ),
    ).toBe('service-photos/rec1/123-abc-photo.jpg');
  });

  it('recovers the key from a path-style URL', () => {
    expect(
      s3KeyFromStoredUrl(
        'https://s3.us-east-1.amazonaws.com/waves-test-bucket/service-photos/rec1/p.jpg',
      ),
    ).toBe('service-photos/rec1/p.jpg');
  });

  it('decodes URL-encoded key segments', () => {
    expect(
      s3KeyFromStoredUrl(
        'https://waves-test-bucket.s3.amazonaws.com/service-photos/rec1/my%20photo.jpg',
      ),
    ).toBe('service-photos/rec1/my photo.jpg');
  });

  it('refuses non-S3 hosts (never guesses a key off a CDN or foreign URL)', () => {
    expect(s3KeyFromStoredUrl('https://cdn.example.com/service-photos/rec1/p.jpg')).toBeNull();
    expect(s3KeyFromStoredUrl('https://evil.amazonaws.com.example.com/x.jpg')).toBeNull();
  });

  it('refuses an S3 host whose path does not match our bucket', () => {
    expect(
      s3KeyFromStoredUrl('https://s3.us-east-1.amazonaws.com/other-bucket/p.jpg'),
    ).toBeNull();
  });

  it('returns null on garbage input', () => {
    expect(s3KeyFromStoredUrl(null)).toBeNull();
    expect(s3KeyFromStoredUrl('')).toBeNull();
    expect(s3KeyFromStoredUrl('not a url')).toBeNull();
    expect(s3KeyFromStoredUrl(42)).toBeNull();
  });
});

describe('withFreshServicePhotoUrls', () => {
  it('presigns from the snapshot s3_key and overwrites the served s3_url', async () => {
    const out = await withFreshServicePhotoUrls([
      { photo_type: 'before', s3_key: 'service-photos/rec1/a.jpg', s3_url: null, caption: 'Before' },
    ]);
    expect(PhotoService.getViewUrl).toHaveBeenCalledWith(
      'service-photos/rec1/a.jpg',
      expect.any(Number),
    );
    expect(out[0].s3_url).toBe('https://signed.example/fresh');
    expect(out[0].url).toBe('https://signed.example/fresh');
    expect(out[0].caption).toBe('Before');
  });

  it('uses a dwell-length TTL (hours, not minutes)', async () => {
    await withFreshServicePhotoUrls([{ s3_key: 'k' }]);
    const ttl = PhotoService.getViewUrl.mock.calls[0][1];
    expect(ttl).toBeGreaterThanOrEqual(60 * 60);
  });

  it('re-signs legacy URL-only snapshots by recovering the key from s3_url', async () => {
    const out = await withFreshServicePhotoUrls([
      {
        photo_type: 'after',
        s3_url:
          'https://waves-test-bucket.s3.us-east-1.amazonaws.com/service-photos/rec1/b.jpg?X-Amz-Expires=900',
      },
    ]);
    expect(PhotoService.getViewUrl).toHaveBeenCalledWith(
      'service-photos/rec1/b.jpg',
      expect.any(Number),
    );
    expect(out[0].s3_url).toBe('https://signed.example/fresh');
  });

  it('falls back to the stored URL when no key is resolvable', async () => {
    const out = await withFreshServicePhotoUrls([
      { photo_type: 'progress', s3_url: 'https://cdn.example.com/p.jpg' },
    ]);
    expect(PhotoService.getViewUrl).not.toHaveBeenCalled();
    expect(out[0].s3_url).toBe('https://cdn.example.com/p.jpg');
    expect(out[0].url).toBe('https://cdn.example.com/p.jpg');
  });

  it('falls back to the stored URL when presigning throws (never drops the photo)', async () => {
    PhotoService.getViewUrl.mockRejectedValue(new Error('s3 down'));
    const out = await withFreshServicePhotoUrls([
      { s3_key: 'service-photos/rec1/c.jpg', s3_url: 'https://old.example/c.jpg', caption: 'x' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].s3_url).toBe('https://old.example/c.jpg');
    expect(out[0].caption).toBe('x');
  });

  it('passes through empty / non-array input untouched', async () => {
    expect(await withFreshServicePhotoUrls([])).toEqual([]);
    expect(await withFreshServicePhotoUrls(null)).toEqual([]);
    expect(PhotoService.getViewUrl).not.toHaveBeenCalled();
  });
});
