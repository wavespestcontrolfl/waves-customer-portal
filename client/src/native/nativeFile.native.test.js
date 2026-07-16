// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  fetchRaw: vi.fn(),
  writeFile: vi.fn(),
  share: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: vi.fn(() => true) },
}));
vi.mock('./platform', () => ({ isNativeApp: () => true }));
vi.mock('../utils/api', () => ({ default: { fetchRaw: nativeMocks.fetchRaw } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { writeFile: nativeMocks.writeFile },
}));
vi.mock('@capacitor/share', () => ({
  Share: { share: nativeMocks.share },
}));

import { saveUrlNative } from './nativeFile';

beforeEach(() => {
  vi.clearAllMocks();
  nativeMocks.fetchRaw.mockResolvedValue({
    ok: true,
    status: 200,
    blob: async () => new Blob(['pdf bytes'], { type: 'application/pdf' }),
  });
  nativeMocks.writeFile.mockResolvedValue({ uri: 'file:///cache/report.pdf' });
  nativeMocks.share.mockResolvedValue(undefined);
});

describe('nativeFile native download path', () => {
  it('lazily uses the refresh-aware raw client before writing and sharing the PDF', async () => {
    const expectedUrl = new URL('/api/documents/report.pdf', window.location.origin).toString();

    await expect(saveUrlNative('/api/documents/report.pdf', 'report.pdf')).resolves.toBe(true);

    expect(nativeMocks.fetchRaw).toHaveBeenCalledWith(expectedUrl);
    expect(nativeMocks.writeFile).toHaveBeenCalledWith({
      path: 'report.pdf',
      data: expect.any(String),
      directory: 'CACHE',
    });
    expect(nativeMocks.share).toHaveBeenCalledWith({
      title: 'report.pdf',
      url: 'file:///cache/report.pdf',
    });
  });
});
