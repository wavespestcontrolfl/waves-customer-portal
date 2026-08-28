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

// Splice a raw APP1 segment into a JPEG right after SOI. This is how BOTH
// metadata classes this test locks actually ship: XMP rides an APP1 with
// the Adobe namespace header, and C2PA/JUMBF provenance rides APPn
// segments the same way — sharp's decode/re-encode drops any it doesn't
// re-emit. Building the segment by hand keeps the fixture independent of
// which metadata kinds this sharp version's .withMetadata() can author.
function spliceApp(jpeg, payload, markerByte) {
  const marker = Buffer.from([0xff, markerByte]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  // SOI (2 bytes) | APP1 marker | length | payload | rest of the JPEG.
  return Buffer.concat([jpeg.subarray(0, 2), marker, length, payload, jpeg.subarray(2)]);
}
const spliceApp1 = (jpeg, payload) => spliceApp(jpeg, payload, 0xe1);
// APP11 (0xffeb) is the segment real C2PA manifests ride in: a JUMBF
// superbox ("jumb") wrapping a description box ("jumd") with the c2pa
// manifest-store label — built here as raw bytes to mirror the container
// an actual gpt-image PNG/JPEG carries.
function jumbfPayload() {
  const label = Buffer.from('c2pa\0', 'latin1');
  const jumd = Buffer.concat([Buffer.alloc(4), Buffer.from('jumd', 'latin1'), Buffer.alloc(16), Buffer.from([0x03]), label]);
  jumd.writeUInt32BE(jumd.length, 0);
  const jumb = Buffer.concat([Buffer.alloc(4), Buffer.from('jumb', 'latin1'), jumd]);
  jumb.writeUInt32BE(jumb.length, 0);
  // "JP\0\0" common identifier + box instance/sequence numbers precede the box.
  return Buffer.concat([Buffer.from('JP\0\0', 'latin1'), Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x01]), jumb]);
}
const spliceApp11 = (jpeg) => spliceApp(jpeg, jumbfPayload(), 0xeb);

const XMP_PACKET = Buffer.from(
  'http://ns.adobe.com/xap/1.0/\0<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
  + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description c2pa:manifest="urn:uuid:strip-me"/></rdf:RDF>'
  + '</x:xmpmeta><?xpacket end="w"?>',
  'latin1',
);

async function buildTaggedJpeg() {
  // 32x32 red JPEG carrying EXIF (via withMetadata) + a hand-spliced XMP
  // APP1 packet that also embeds a c2pa manifest marker.
  const base = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).jpeg().toBuffer();
  const withExif = await sharp(base)
    .withMetadata({
      exif: { IFD0: { Copyright: 'strip-me', Software: 'gpt-image-test' } },
    })
    .jpeg()
    .toBuffer();
  return spliceApp11(spliceApp1(withExif, XMP_PACKET));
}

describe('compressToWebp provenance strip', () => {
  test('input fixture really carries EXIF + XMP + a c2pa marker (guards the test itself)', async () => {
    const tagged = await buildTaggedJpeg();
    const s = tagged.toString('latin1');
    expect(s).toContain('Exif');
    expect(s).toContain('x:xmpmeta');
    expect(s).toContain('c2pa');
    expect(s).toContain('urn:uuid');
    // Real C2PA container bytes: JUMBF superbox + description box in APP11.
    expect(s).toContain('jumb');
    expect(s).toContain('jumd');
    // And it is still a decodable JPEG despite the hand-spliced segment.
    const meta = await sharp(tagged).metadata();
    expect(meta.format).toBe('jpeg');
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
