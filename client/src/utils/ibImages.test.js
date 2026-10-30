// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { filesToImageParts, MAX_ATTACHMENTS } from './ibImages';

// jsdom has no canvas: a file named broken* does not decode, any other does.
vi.mock('./imageCompression', () => ({
  encodeJpegDataUrl: vi.fn(async (file) => (file.name.startsWith('broken') ? null : 'data:image/jpeg;base64,QUJD')),
}));

const file = (name, type = 'image/png') => new File(['x'], name, { type });

describe('filesToImageParts', () => {
  it('attaches what decodes and reports the rest: unreadable files by name, images past the limit by count', async () => {
    const result = await filesToImageParts([
      file('notes.pdf', 'application/pdf'), file('broken.png'), file('a.png'), file('b.png'), file('c.png'), file('d.png'),
    ]);
    // A non-image never takes one of the four places.
    expect(result.parts.map((part) => part.name)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(result.failed).toEqual(['notes.pdf', 'broken.png']);
    expect(result.skipped).toBe(1);
  });

  it('counts photos already attached against the limit', async () => {
    const result = await filesToImageParts([file('a.png'), file('b.png')], MAX_ATTACHMENTS - 1);
    expect(result.parts.map((part) => part.name)).toEqual(['a.png']);
    expect(result).toMatchObject({ failed: [], skipped: 1 });
  });
});
