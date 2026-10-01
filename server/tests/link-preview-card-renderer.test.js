/**
 * Link-preview card renderer — text is drawn as vector outlines from the
 * shipped brand fonts (the server has none installed, so an SVG <text> node
 * silently falls back to a generic face in production), and the JPEG comes
 * out at the 1200x630 size link-preview crawlers expect.
 */
const sharp = require('sharp');
const {
  HEADLINE_MAX_WIDTH, renderLinkPreviewSvg, renderLinkPreviewJpeg, _test: { fitHeadline, fitSubline, outline, loadFonts },
} = require('../services/link-preview-card-renderer');

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

  test.each([
    'WAVES ASSESSMENT',
    'QUARTERLY PEST CONTROL SERVICE',
    'SCHEDULE YOUR INTERVIEW',
    'SUPERCALIFRAGILISTICEXPIALIDOCIOUSLYLONG TREATMENT',
    'A'.repeat(60),
  ])('every headline line fits the text column: %s', (text) => {
    const { headline } = loadFonts();
    const { size, lines } = fitHeadline(headline, text, HEADLINE_MAX_WIDTH);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) expect(outline(headline, line, size).width).toBeLessThanOrEqual(HEADLINE_MAX_WIDTH);
  });

  test('a long subline and a long label still fit their columns', () => {
    const { subline } = loadFonts();
    const { size, lines } = fitSubline(subline, 'Wednesday, September 30, 2026 · between 10:00 AM and 12:00 PM, plus a very long tail', HEADLINE_MAX_WIDTH + 40);
    for (const line of lines) expect(outline(subline, line, size).width).toBeLessThanOrEqual(HEADLINE_MAX_WIDTH + 40);
    const svg = renderLinkPreviewSvg({ eyebrow: 'A VERY LONG LABEL THAT GOES ON AND ON', headline: 'X', subline: 'y' });
    const pillW = Number(/<rect x="80" y="\d+" width="(\d+)"/.exec(svg)[1]);
    expect(pillW).toBeLessThanOrEqual(HEADLINE_MAX_WIDTH);
  });
});
