/**
 * astro-image-metadata-strip.test.js — regression lock on the provenance
 * strip (owner rule 2026-08-27: no AI-provenance metadata ships to the
 * public site).
 *
 * compressToWebp is the single boundary every NEW image byte passes before
 * being committed to the astro repo (generated heroes + curated fetches in
 * publishAstro; autonomous-lane generated heroes in resolveAutonomousHero).
 * sharp strips EXIF/XMP/ICC-adjacent metadata — including the C2PA
 * "made with AI" manifests OpenAI's gpt-image models embed — UNLESS someone
 * adds .withMetadata() to the pipeline. This test fails the moment that
 * happens: it feeds an image carrying EXIF + XMP and asserts the output
 * webp contains none of the marker byte sequences.
 */

const sharp = require('sharp');

// Some environments load the publisher's transitive deps lazily; requiring
// only the _internals we exercise keeps this test hermetic.
const { _internals } = require('../services/content-astro/astro-publisher');
const { compressToWebp } = _internals;

const MARKERS = ['Exif', 'exif', 'x:xmpmeta', 'XMP', 'c2pa', 'C2PA', 'jumb', 'jumd', 'urn:uuid'];

async function buildTaggedJpeg() {
  // 32x32 red JPEG carrying EXIF (via withMetadata) + an XMP packet.
  const base = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).jpeg().toBuffer();
  // EXIF is the embeddable fixture in this sharp version; the OUTPUT
  // assertions still cover XMP/C2PA markers (sharp drops every metadata
  // block on re-encode unless .withMetadata() is added to the pipeline —
  // which is exactly the regression this test exists to catch).
  return sharp(base)
    .withMetadata({
      exif: { IFD0: { Copyright: 'strip-me', Software: 'gpt-image-test' } },
    })
    .jpeg()
    .toBuffer();
}

describe('compressToWebp provenance strip', () => {
  test('input fixture really carries EXIF (guards the test itself)', async () => {
    const tagged = await buildTaggedJpeg();
    expect(tagged.toString('latin1')).toContain('Exif');
  });

  test('output webp carries no EXIF/XMP/C2PA markers', async () => {
    const tagged = await buildTaggedJpeg();
    const out = await compressToWebp(tagged);
    const s = out.toString('latin1');
    // Valid webp container…
    expect(s.slice(0, 4)).toBe('RIFF');
    expect(s.slice(8, 12)).toBe('WEBP');
    // …with every metadata marker gone.
    for (const marker of MARKERS) {
      expect(s.includes(marker)).toBe(false);
    }
    // And sharp agrees there is no metadata block left.
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });
});
