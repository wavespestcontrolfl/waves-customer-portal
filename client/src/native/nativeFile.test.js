// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { safeFileName, saveBlobNative, saveUrlNative } from './nativeFile';

describe('nativeFile', () => {
  it('safeFileName strips path separators and reserved characters', () => {
    expect(safeFileName('../../etc/passwd')/*, path traversal */).toBe('.._.._etc_passwd');
    expect(safeFileName('WDO Report: 7/14?.pdf')).toBe('WDO Report_ 7_14_.pdf');
    expect(safeFileName('  ')).toBe('Waves_Document.pdf');
    expect(safeFileName(null, 'Waves_Receipt.pdf')).toBe('Waves_Receipt.pdf');
  });

  it('saveBlobNative is a false no-op on web so callers keep the browser path', async () => {
    await expect(saveBlobNative(new Blob(['x']), 'a.pdf')).resolves.toBe(false);
  });

  it('saveUrlNative is a false no-op on web without fetching', async () => {
    // No fetch mock installed — a network attempt would throw, a no-op won't.
    await expect(saveUrlNative('/api/reports/tok', 'a.pdf')).resolves.toBe(false);
  });
});
