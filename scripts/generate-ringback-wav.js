#!/usr/bin/env node
/**
 * Writes client/public/audio/ringback-us.wav: the US ringback tone a caller hears while the staff
 * phones ring on the conference path (GATE_CALL_CONFERENCE_PATH, services/call-conference-path.js).
 * 440 Hz + 480 Hz, 2 s on, 4 s off (the North American ringback cadence), two cycles; 8 kHz, 16-bit
 * mono PCM. Twilio plays the room's waitUrl audio again each time it ends.
 * Run: node scripts/generate-ringback-wav.js
 */
const fs = require('fs');
const path = require('path');

const RATE = 8000;
const CYCLES = 2;
const ON_SEC = 2;
const OFF_SEC = 4;
const AMPLITUDE = 0.08; // each tone; about -16 dBFS at the peak of the sum

function ringbackPcm() {
  const cycle = (ON_SEC + OFF_SEC) * RATE;
  const samples = new Int16Array(cycle * CYCLES);
  for (let i = 0; i < samples.length; i += 1) {
    if (i % cycle >= ON_SEC * RATE) continue;
    const t = i / RATE;
    const value = AMPLITUDE * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t));
    samples[i] = Math.round(value * 32767);
  }
  return Buffer.from(samples.buffer);
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const out = path.join(__dirname, '..', 'client', 'public', 'audio', 'ringback-us.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, wav(ringbackPcm()));
console.log(`wrote ${path.relative(process.cwd(), out)}`);
