// Live words (GATE_DICTATION_LIVE_WORDS): while the mic records, the SAME microphone stream is also sent over
// the staff socket to our server, which relays it to a live transcriber and sends the words back. The words are
// a preview; the recorded clip still makes the final words (useSpeechDictation.js clears the preview when they
// land). A live session that fails for any reason only ends the preview: the recording is never touched.
import { io } from "socket.io-client";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// A static file under /public, so the page's CSP script-src 'self' covers it.
const WORKLET_URL = "/dictation-pcm-worklet.js";
const START_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 6000;
// Audio that arrives while the session is still opening waits here (100 ms a frame: 10 seconds).
const MAX_QUEUED_FRAMES = 100;
// Server reasons that are the end of a good session; the preview text stays up until the final words land.
const GOOD_ENDS = new Set(["stopped", "max_time", "max_bytes", "idle"]);

// Same shape as the other staff socket hooks: a relative API base means same origin.
function socketOrigin() {
  if (!API_BASE || API_BASE.startsWith("/")) return undefined;
  try {
    return new URL(API_BASE).origin;
  } catch {
    return undefined;
  }
}

/**
 * Starts a live session for one recording. `stream` is the recording's own getUserMedia stream (read, never
 * stopped here), `context` its { customerId, serviceId }, `onText(text)` gets the words so far, and
 * `onEnd(failed)` fires once when the session is over (`failed` true when the preview should be dropped).
 * Every callback runs asynchronously. Returns { stop, abort }: `stop()` ends the audio and lets the last words
 * arrive; `abort()` ends everything now, silently.
 */
export function startLiveWords({ stream, context, token, onText, onEnd }) {
  const state = { socket: null, audioCtx: null, nodes: [], ready: false, ended: false, stopping: false, quiet: false, queue: [], timers: [] };

  const closeAudio = () => {
    state.nodes.forEach((node) => {
      try {
        node.disconnect();
      } catch { /* already disconnected */ }
    });
    state.nodes = [];
    try {
      state.audioCtx?.close();
    } catch { /* already closed */ }
    state.audioCtx = null;
  };

  const finish = (failed) => {
    if (state.ended) return;
    state.ended = true;
    state.timers.forEach(clearTimeout);
    closeAudio();
    try {
      state.socket?.disconnect();
    } catch { /* already closed */ }
    state.queue = [];
    if (!state.quiet) onEnd?.(failed);
  };
  const failLater = () => Promise.resolve().then(() => finish(true));

  const sendFrame = (frame) => {
    if (state.ended || state.stopping) return;
    if (state.ready) {
      state.socket.emit("dictation:live:audio", frame);
    } else if (state.queue.length < MAX_QUEUED_FRAMES) {
      state.queue.push(frame);
    }
  };

  const startAudio = async () => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor || typeof AudioWorkletNode !== "function") throw new Error("no audio worklet");
    // The browser's own rate; the worklet downsamples to 24 kHz.
    const audioCtx = new AudioContextCtor();
    state.audioCtx = audioCtx;
    await audioCtx.audioWorklet.addModule(WORKLET_URL);
    if (state.ended) return;
    const source = audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioCtx, "dictation-pcm", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (event) => sendFrame(event.data);
    // A silent path to the speakers keeps the processor running in every browser.
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(audioCtx.destination);
    state.nodes = [source, node, mute];
    // A tap long ago can leave the context suspended (iOS); a refusal just means no preview.
    await audioCtx.resume?.().catch(() => {});
  };

  try {
    const socket = io(socketOrigin(), { auth: { token }, transports: ["websocket"], reconnection: false });
    state.socket = socket;
    socket.on("connect", () => {
      state.timers.push(setTimeout(() => finish(true), START_TIMEOUT_MS));
      socket.emit("dictation:live:start", { customerId: context?.customerId || undefined, serviceId: context?.serviceId || undefined }, (answer) => {
        if (state.ended) return;
        if (!answer?.ok) {
          finish(true);
          return;
        }
        // The open timer above only guards the start.
        state.timers.forEach(clearTimeout);
        state.timers = [];
        state.ready = true;
        const queued = state.queue;
        state.queue = [];
        queued.forEach((frame) => socket.emit("dictation:live:audio", frame));
      });
    });
    socket.on("dictation:live:text", (message) => {
      if (!state.ended && typeof message?.text === "string") onText?.(message.text);
    });
    socket.on("dictation:live:ended", (message) => finish(!GOOD_ENDS.has(message?.reason)));
    socket.on("connect_error", () => finish(true));
    socket.on("disconnect", () => finish(!state.stopping));
    startAudio().catch(() => finish(true));
  } catch {
    failLater();
  }

  return {
    stop() {
      if (state.ended || state.stopping) return;
      state.stopping = true;
      closeAudio();
      if (!state.ready) {
        // Nothing was accepted yet (or the socket never opened): there is nothing to wait for.
        finish(false);
        return;
      }
      state.timers.push(setTimeout(() => finish(false), STOP_TIMEOUT_MS));
      state.socket.emit("dictation:live:stop", () => finish(false));
    },
    abort() {
      state.quiet = true;
      finish(false);
    },
  };
}
