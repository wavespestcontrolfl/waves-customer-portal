#!/usr/bin/env node
/**
 * Writes client/public/audio/voicemail-tone.wav: the tone a caller hears after "Please leave a message after the
 * tone" when the star-key hold sends the call to voicemail (GATE_CALL_HOLD, routes/twilio-voice-webhook.js
 * holdVoicemailTwiml). 1000 Hz, 0.5 s, 8 kHz, 16-bit mono PCM. Modeled on generate-ringback-wav.js.
 * Run: node scripts/generate-voicemail-tone-wav.js
 */
const fs = require('fs');
const path = require('path');

const RATE = 8000;
const TONE_HZ = 1000;
const TONE_SEC = 0.5;
const AMPLITUDE = 0.16; // about -16 dBFS, like the ringback tone's two-tone peak

function tonePcm() {
  const samples = new Int16Array(Math.round(RATE * TONE_SEC));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(AMPLITUDE * Math.sin(2 * Math.PI * TONE_HZ * (i / RATE)) * 32767);
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

const out = path.join(__dirname, '..', 'client', 'public', 'audio', 'voicemail-tone.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, wav(tonePcm()));
console.log(`wrote ${path.relative(process.cwd(), out)}`);
