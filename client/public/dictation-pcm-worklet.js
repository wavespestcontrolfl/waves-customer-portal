/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Live words (GATE_DICTATION_LIVE_WORDS): turns the microphone into 24 kHz mono 16-bit PCM for the
// server's live transcription. Loaded by client/src/hooks/liveDictation.js with audioWorklet.addModule.
// A plain file under /public (not bundled) so the page's CSP `script-src 'self'` covers it.
//
// The browser hands over audio at its own rate (44.1 or 48 kHz); each output sample is the average of the
// input samples it spans. Every 100 ms (2400 samples, 4800 bytes) the processor posts one Int16Array buffer.
const TARGET_RATE = 24000;
const FRAME_SAMPLES = 2400;

class DictationPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.position = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.sum += channel[i];
      this.count += 1;
      this.position += 1;
      if (this.position >= this.ratio) {
        this.position -= this.ratio;
        const mean = Math.max(-1, Math.min(1, this.sum / this.count));
        this.frame[this.filled] = mean < 0 ? mean * 0x8000 : mean * 0x7fff;
        this.sum = 0;
        this.count = 0;
        this.filled += 1;
        if (this.filled === FRAME_SAMPLES) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(FRAME_SAMPLES);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("dictation-pcm", DictationPcmProcessor);
