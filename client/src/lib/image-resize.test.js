// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataUrlToFile, fileToDataUrl, mimeFromName, resizeDataUrl, resizeImageFile } from './image-resize';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mimeFromName', () => {
  it('resolves the known extensions, case-insensitively', () => {
    expect(mimeFromName('photo.HEIC')).toBe('image/heic');
    expect(mimeFromName('photo.jpg')).toBe('image/jpeg');
    expect(mimeFromName('photo.jpeg')).toBe('image/jpeg');
    expect(mimeFromName('photo.png')).toBe('image/png');
    expect(mimeFromName('photo.webp')).toBe('image/webp');
    expect(mimeFromName('photo.heif')).toBe('image/heif');
  });

  it('returns null for an unrecognized or missing extension', () => {
    expect(mimeFromName('photo.pdf')).toBeNull();
    expect(mimeFromName('')).toBeNull();
    expect(mimeFromName(undefined)).toBeNull();
  });
});

describe('fileToDataUrl', () => {
  it('rebuilds a blank mime prefix from the filename extension', async () => {
    const file = new File(['bytes'], 'photo.heic', { type: '' });
    const url = await fileToDataUrl(file);
    expect(url).toMatch(/^data:image\/heic;base64,/);
  });

  it('keeps a declared mime as-is', async () => {
    const file = new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' });
    const url = await fileToDataUrl(file);
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('resolves null when neither the type nor the extension is recoverable', async () => {
    // FileReader still reads it, but with no mime to rebuild a blank
    // prefix from, this is unusable as an image.
    class BlankFileReader {
      readAsDataURL() { this.onload({ target: { result: 'data:;base64,eA==' } }); }
    }
    vi.stubGlobal('FileReader', BlankFileReader);
    const file = new File(['bytes'], 'photo', { type: '' });
    expect(await fileToDataUrl(file)).toBeNull();
  });
});

describe('resizeDataUrl', () => {
  class SmallImage {
    set src(_value) { this.width = 800; this.height = 600; this.onload(); }
  }
  class LargeImage {
    set src(_value) { this.width = 3200; this.height = 2400; this.onload(); }
  }
  class UndecodableImage {
    set src(_value) { this.onerror(); }
  }

  beforeEach(() => {
    vi.stubGlobal('Image', SmallImage);
  });

  it('returns the original data URL unchanged when already within maxEdge', async () => {
    vi.stubGlobal('Image', SmallImage);
    const original = 'data:image/heic;base64,eA==';
    expect(await resizeDataUrl(original, 1600, 0.85)).toBe(original);
  });

  it('downscales to a JPEG data URL when over maxEdge', async () => {
    vi.stubGlobal('Image', LargeImage);
    const resizedUrl = 'data:image/jpeg;base64,c21hbGw=';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(resizedUrl);

    const out = await resizeDataUrl('data:image/jpeg;base64,eA==', 1600, 0.85);
    expect(out).toBe(resizedUrl);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('resolves null when the browser cannot decode the image', async () => {
    vi.stubGlobal('Image', UndecodableImage);
    expect(await resizeDataUrl('data:image/heic;base64,eA==', 1600, 0.85)).toBeNull();
  });
});

describe('dataUrlToFile', () => {
  it('round-trips a data URL into a correctly-typed File', () => {
    const file = dataUrlToFile('data:image/jpeg;base64,aGVsbG8=', 'a.jpg');
    expect(file.name).toBe('a.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBe(5); // "hello"
  });

  it('falls back to the given mime when the data URL carries none', () => {
    const file = dataUrlToFile('data:;base64,aGVsbG8=', 'a.heic', 'image/heic');
    expect(file.type).toBe('image/heic');
  });

  it('returns null for a non-data-URL input', () => {
    expect(dataUrlToFile('not-a-data-url', 'a.jpg')).toBeNull();
  });
});

describe('resizeImageFile', () => {
  it('corrects an empty declared type from the extension even when no resize is needed', async () => {
    vi.stubGlobal('Image', class { set src(_value) { this.width = 800; this.height = 600; this.onload(); } });
    const file = new File(['bytes'], 'photo.heic', { type: '' });
    const out = await resizeImageFile(file);
    expect(out.type).toBe('image/heic');
    expect(out.name).toBe('photo.heic');
  });

  it('resolves null when the image cannot be decoded at all', async () => {
    vi.stubGlobal('Image', class { set src(_value) { this.onerror(); } });
    const file = new File(['bytes'], 'photo.heic', { type: '' });
    expect(await resizeImageFile(file)).toBeNull();
  });
});
