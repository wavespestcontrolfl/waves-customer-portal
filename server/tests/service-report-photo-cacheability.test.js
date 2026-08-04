/**
 * countUnreachableReportPhotos — the store-time probe that keeps a PDF
 * rendered with placeholder photos out of the healthy cache (codex P2
 * #3176 r18). Ranged GETs because presigned S3 URLs are method-specific.
 */
const { countUnreachableReportPhotos } = require('../services/service-report/pdf');

describe('countUnreachableReportPhotos', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('0 with no photos, and never calls fetch', async () => {
    global.fetch = jest.fn();
    expect(await countUnreachableReportPhotos({ photos: [] })).toBe(0);
    expect(await countUnreachableReportPhotos({})).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips non-absolute URLs — only http(s) photos are probed', async () => {
    global.fetch = jest.fn();
    expect(await countUnreachableReportPhotos({ photos: [{ url: '/api/photos/1' }, { url: null }] })).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('probes with a ranged GET, not HEAD — presigned GETs 403 a HEAD', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 206 });
    await countUnreachableReportPhotos({ photos: [{ url: 'https://s3.example.com/a.jpg?sig=x' }] });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('GET');
    expect(opts.headers.Range).toBe('bytes=0-0');
  });

  it('counts a non-OK response and a network error as unreachable', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ ok: true, status: 206 });
    const n = await countUnreachableReportPhotos({ photos: [
      { url: 'https://s3.example.com/a.jpg' },
      { url: 'https://s3.example.com/b.jpg' },
      { url: 'https://s3.example.com/c.jpg' },
    ] });
    expect(n).toBe(2);
  });
});
