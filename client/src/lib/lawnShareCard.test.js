import { describe, expect, it, vi } from 'vitest';
import { CARD_HEIGHT, CARD_WIDTH, bareLink, coverRect, drawLawnShareCard } from './lawnShareCard';

// A recording 2D context: every fillText string and drawImage source is captured.
function recordingCtx() {
  const texts = [];
  const images = [];
  const ctx = {
    measureText: (t) => ({ width: String(t).length * 20 }),
    fillText: vi.fn((t) => texts.push(String(t))),
    drawImage: vi.fn((img) => images.push(img)),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), arcTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
  };
  return { ctx, texts, images };
}

const photo = { width: 4000, height: 3000, tag: 'photo' };
const logo = { width: 512, height: 512, tag: 'logo' };
const qr = { width: 250, height: 250, tag: 'qr' };

describe('lawn share card drawing', () => {
  it('draws the photo, the logo and the QR code, and the score and link as text', () => {
    const { ctx, texts, images } = recordingCtx();
    drawLawnShareCard(ctx, { photo, logo, qr, score: 88.4, link: 'https://wavespestcontrol.com/r/ABC123/' });
    expect(images.map((i) => i.tag)).toEqual(['photo', 'logo', 'qr']);
    expect(texts).toContain('88');
    expect(texts).toContain('wavespestcontrol.com/r/ABC123');
  });

  it('draws only fixed words, the score and the link: no address, name or date can appear', () => {
    const { ctx, texts } = recordingCtx();
    drawLawnShareCard(ctx, { photo, logo, qr, score: 91, link: 'https://wavespestcontrol.com/r/XYZ' });
    expect(texts.sort()).toEqual([
      '/ 100',
      '91',
      'LAWN HEALTH SCORE',
      'SCAN OR TYPE MY LINK',
      'Want a lawn like this?',
      'Waves Pest Control',
      'wavespestcontrol.com/r/XYZ',
    ].sort());
  });

  it('has a 4:5 canvas size', () => {
    expect(CARD_WIDTH / CARD_HEIGHT).toBeCloseTo(0.8, 5);
  });
});

describe('helpers', () => {
  it('bareLink drops the scheme and trailing slashes', () => {
    expect(bareLink('https://wavespestcontrol.com/r/ABC/')).toBe('wavespestcontrol.com/r/ABC');
    expect(bareLink(' http://x.test/r/1 ')).toBe('x.test/r/1');
    expect(bareLink(null)).toBe('');
  });

  it('coverRect crops the long side and centres it', () => {
    expect(coverRect(4000, 3000, 1080, 900)).toEqual({ sx: 200, sy: 0, sw: 3600, sh: 3000 });
    const tall = coverRect(1000, 3000, 1080, 900);
    expect(tall.sw).toBeCloseTo(1000, 6);
    expect(tall.sh).toBeCloseTo(1000 * (900 / 1080), 6);
    expect(tall.sy).toBeCloseTo((3000 - tall.sh) / 2, 6);
  });
});
