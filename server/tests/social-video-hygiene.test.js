const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripVideoMetadata } = require('../services/social-media');

// Reel MP4s are metadata-stripped before hosting (the video counterpart of
// the JPEG hygiene): provider tags, chapters, and XMP/udta provenance never
// reach a published Reel, and a missing/failing ffmpeg fails CLOSED.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const haveFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0
  && spawnSync(FFPROBE, ['-version']).status === 0;

function makeTaggedMp4() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-video-test-'));
  const file = path.join(dir, 'tagged.mp4');
  const r = spawnSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.5:r=10',
    '-metadata', 'title=strip-me-title', '-metadata', 'comment=c2pa-ai-generated',
    '-metadata:s:v:0', 'handler_name=strip-me-handler',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ]);
  if (r.status !== 0) throw new Error(`fixture ffmpeg failed: ${String(r.stderr).slice(-300)}`);
  const buffer = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return buffer;
}

function probeTags(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-video-probe-'));
  const file = path.join(dir, 'probe.mp4');
  fs.writeFileSync(file, buffer);
  const r = spawnSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
  fs.rmSync(dir, { recursive: true, force: true });
  const json = JSON.parse(String(r.stdout || '{}'));
  return {
    format: json.format?.tags || {},
    streams: (json.streams || []).map((s) => s.tags || {}),
    codec: json.streams?.[0]?.codec_name,
  };
}

const describeIf = haveFfmpeg ? describe : describe.skip;

describeIf('stripVideoMetadata (Reel MP4 hygiene)', () => {
  test('removes container and stream tags without re-encoding', async () => {
    const tagged = makeTaggedMp4();
    const before = probeTags(tagged);
    expect(before.format.title).toBe('strip-me-title'); // fixture sanity
    expect(tagged.includes('strip-me-title')).toBe(true);

    const clean = await stripVideoMetadata(tagged);
    expect(clean.length).toBeGreaterThan(0);
    expect(clean.includes('strip-me')).toBe(false);
    expect(clean.includes('c2pa')).toBe(false);
    const after = probeTags(clean);
    expect(after.format.title).toBeUndefined();
    expect(after.format.comment).toBeUndefined();
    expect(after.streams.every((t) => !String(t.handler_name || '').includes('strip-me'))).toBe(true);
    expect(after.codec).toBe(before.codec); // stream copy, not a transcode
  });
});

describe('stripVideoMetadata failure policy', () => {
  test('rejects (fail closed) when ffmpeg is unavailable', async () => {
    const prev = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = path.join(os.tmpdir(), 'definitely-not-ffmpeg');
    try {
      await expect(stripVideoMetadata(Buffer.from('not a video'))).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prev;
    }
  });
});
