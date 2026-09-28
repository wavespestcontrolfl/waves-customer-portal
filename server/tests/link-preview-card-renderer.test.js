/**
 * Link-preview card renderer — text is drawn as vector outlines from the
 * shipped brand fonts (the server has none installed, so an SVG <text> node
 * silently falls back to a generic face in production), and the JPEG comes
 * out at the 1200x630 size link-preview crawlers expect.
 */
const sharp = require('sharp');
const { renderLinkPreviewSvg, renderLinkPreviewJpeg } = require('../services/link-preview-card-renderer');

describe('link-preview card renderer', () => {
  test('draws every word as outlines — no <text> left for a fallback font', () => {
    const svg = renderLinkPreviewSvg({ eyebrow: 'Service report', headline: 'Quarterly Pest Control Service', subline: 'September 22, 2026' });
    expect(svg).not.toMatch(/<text\b/);
    expect(svg).not.toMatch(/Quarterly|September/i);
    expect((svg.match(/<path transform=/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  test('renders a 1200x630 JPEG, including for an over-long headline', async () => {
    const jpeg = await renderLinkPreviewJpeg({ eyebrow: 'Prep guide', headline: 'A'.repeat(20) + ' ' + 'B'.repeat(20) + ' ' + 'C'.repeat(20), subline: 'x' });
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([1200, 630]);
  });
});
