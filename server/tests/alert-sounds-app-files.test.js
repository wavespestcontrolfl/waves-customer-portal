// The sound files the push builders name must ship in the Waves Admin app.
// iOS looks the aps.sound name up in the app bundle; a missing file plays the
// default sound, and a file over 30 seconds is ignored.
const fs = require('fs');
const path = require('path');
const { ALERT_SOUNDS } = require('../services/alert-sounds');

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'ios', 'WavesPay', 'Resources', 'Sounds');
const MAX_SECONDS = 30;

// Seconds of audio in a CAF file, from its audio description + data chunks.
function cafSeconds(buf) {
  expect(buf.toString('latin1', 0, 4)).toBe('caff');
  let pos = 8;
  let desc = null;
  let dataBytes = null;
  let validFrames = null;
  while (pos + 12 <= buf.length) {
    const type = buf.toString('latin1', pos, pos + 4);
    let size = Number(buf.readBigInt64BE(pos + 4));
    const body = pos + 12;
    // A data chunk of size -1 runs to the end of the file.
    if (size < 0) size = buf.length - body;
    if (type === 'desc') {
      desc = {
        sampleRate: buf.readDoubleBE(body),
        bytesPerPacket: buf.readUInt32BE(body + 12),
        framesPerPacket: buf.readUInt32BE(body + 16),
      };
    } else if (type === 'data') {
      dataBytes = size - 4; // the first 4 bytes are the edit count
    } else if (type === 'pakt') {
      validFrames = Number(buf.readBigInt64BE(body + 8));
    }
    pos = body + size;
  }
  expect(desc).not.toBeNull();
  expect(dataBytes).not.toBeNull();
  const frames = desc.bytesPerPacket > 0 ? (dataBytes / desc.bytesPerPacket) * desc.framesPerPacket : validFrames;
  expect(frames).toBeGreaterThan(0);
  return frames / desc.sampleRate;
}

describe('alert sound files in the Waves Admin app', () => {
  const onDisk = fs.readdirSync(SOUNDS_DIR).filter((f) => f.endsWith('.caf'));

  test('every sound the map names has a file in the app Sounds folder', () => {
    for (const name of new Set(Object.values(ALERT_SOUNDS))) expect(onDisk).toContain(name);
  });

  test('every .caf in the Sounds folder is used by the map', () => {
    const used = new Set(Object.values(ALERT_SOUNDS));
    for (const f of onDisk) expect(used.has(f)).toBe(true);
  });

  test.each([...new Set(Object.values(ALERT_SOUNDS))])('%s is a CAF file under 30 seconds', (name) => {
    const seconds = cafSeconds(fs.readFileSync(path.join(SOUNDS_DIR, name)));
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(MAX_SECONDS);
  });
});
