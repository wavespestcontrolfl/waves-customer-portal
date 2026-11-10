// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The live session: a fake staff socket and a fake audio graph.
class FakeSocket {
  constructor() { this.handlers = {}; this.emitted = []; this.disconnected = false; FakeSocket.last = this; FakeSocket.all.push(this); }
  on(name, fn) { this.handlers[name] = fn; }
  emit(name, ...args) { this.emitted.push([name, ...args]); }
  disconnect() { this.disconnected = true; }
  fire(name, ...args) { this.handlers[name]?.(...args); }
  sent(name) { return this.emitted.filter(([n]) => n === name); }
}
FakeSocket.all = [];
const ioMock = vi.fn(() => new FakeSocket());
vi.mock("socket.io-client", () => ({ io: (...a) => ioMock(...a) }));

let nodes;
class FakeNode { constructor() { nodes.push(this); this.connect = vi.fn(); this.disconnect = vi.fn(); this.gain = { value: 1 }; } }
class FakeAudioContext {
  constructor() {
    FakeAudioContext.last = this;
    this.destination = {};
    this.audioWorklet = { addModule: vi.fn(async () => {}) };
    this.close = vi.fn();
    this.resume = vi.fn(async () => {});
  }
  createMediaStreamSource(stream) { const n = new FakeNode(); n.stream = stream; return n; }
  createGain() { return new FakeNode(); }
}
class FakeWorkletNode extends FakeNode {
  constructor(ctx, name, opts) { super(); this.ctx = ctx; this.name = name; this.opts = opts; this.port = {}; FakeWorkletNode.last = this; }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const frame = (n = 4800) => new ArrayBuffer(n);
const stream = { id: "mic" };
let start;

beforeEach(async () => {
  nodes = [];
  FakeSocket.all = [];
  ioMock.mockClear();
  window.AudioContext = FakeAudioContext;
  window.AudioWorkletNode = FakeWorkletNode;
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  ({ startLiveWords: start } = await import("./liveDictation"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.AudioContext;
  delete window.AudioWorkletNode;
});

function begin(over = {}) {
  const calls = { onText: vi.fn(), onEnd: vi.fn() };
  const session = start({ stream, context: { customerId: "c1", serviceId: null }, token: "staff-jwt", ...calls, ...over });
  return { session, ...calls, socket: FakeSocket.last };
}
async function ready(over) {
  const run = begin(over);
  run.socket.fire("connect");
  await flush();
  const startCall = run.socket.sent("dictation:live:start")[0];
  startCall[2]({ ok: true });
  return run;
}

describe("startLiveWords", () => {
  it("connects with the staff token, starts a session with ids only, and reads the SAME stream through the PCM worklet", async () => {
    const { socket } = await ready();
    expect(ioMock).toHaveBeenCalledWith(undefined, expect.objectContaining({ auth: { token: "staff-jwt" }, transports: ["websocket"], reconnection: false }));
    expect(socket.sent("dictation:live:start")[0][1]).toEqual({ customerId: "c1", serviceId: undefined });
    expect(FakeAudioContext.last.audioWorklet.addModule).toHaveBeenCalledWith("/dictation-pcm-worklet.js");
    expect(nodes.find((n) => n.stream)?.stream).toBe(stream);
    expect(FakeWorkletNode.last.name).toBe("dictation-pcm");
  });

  it("relays worklet frames once the server said ok; frames that came earlier wait and go first", async () => {
    const run = begin();
    run.socket.fire("connect");
    await flush();
    const first = frame(4800);
    FakeWorkletNode.last.port.onmessage({ data: first });
    expect(run.socket.sent("dictation:live:audio")).toHaveLength(0);
    run.socket.sent("dictation:live:start")[0][2]({ ok: true });
    expect(run.socket.sent("dictation:live:audio")[0][1]).toBe(first);
    const second = frame(4800);
    FakeWorkletNode.last.port.onmessage({ data: second });
    expect(run.socket.sent("dictation:live:audio")[1][1]).toBe(second);
  });

  it("passes the server's words on", async () => {
    const { socket, onText } = await ready();
    socket.fire("dictation:live:text", { text: "Treated the lanai" });
    expect(onText).toHaveBeenCalledWith("Treated the lanai");
  });

  it("a refused session ends as a failure and closes the socket and audio", async () => {
    const run = begin();
    run.socket.fire("connect");
    await flush();
    run.socket.sent("dictation:live:start")[0][2]({ ok: false, reason: "budget" });
    expect(run.onEnd).toHaveBeenCalledWith(true);
    expect(run.socket.disconnected).toBe(true);
    expect(FakeAudioContext.last.close).toHaveBeenCalled();
  });

  it("a connection error, or a server that never answers the start, ends as a failure", async () => {
    vi.useFakeTimers();
    const a = begin();
    a.socket.fire("connect_error", new Error("x"));
    expect(a.onEnd).toHaveBeenCalledWith(true);
    const b = begin();
    b.socket.fire("connect");
    vi.advanceTimersByTime(8001);
    expect(b.onEnd).toHaveBeenCalledWith(true);
  });

  it("a browser without an audio worklet ends as a failure", async () => {
    vi.stubGlobal("AudioWorkletNode", undefined);
    delete window.AudioWorkletNode;
    const run = begin();
    await flush();
    expect(run.onEnd).toHaveBeenCalledWith(true);
  });

  it("stop ends the audio, asks the server to finish, keeps showing words until the server is done, then ends well", async () => {
    const { session, socket, onText, onEnd } = await ready();
    session.stop();
    expect(FakeAudioContext.last.close).toHaveBeenCalled();
    expect(socket.sent("dictation:live:stop")).toHaveLength(1);
    FakeWorkletNode.last.port.onmessage?.({ data: frame() });
    expect(socket.sent("dictation:live:audio")).toHaveLength(0);
    socket.fire("dictation:live:text", { text: "final words" });
    expect(onText).toHaveBeenCalledWith("final words");
    expect(onEnd).not.toHaveBeenCalled();
    socket.sent("dictation:live:stop")[0][1]({ ok: true });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(false);
    expect(socket.disconnected).toBe(true);
  });

  it("a server end for a cap keeps the words; any other reason drops them", async () => {
    const good = await ready();
    good.socket.fire("dictation:live:ended", { reason: "max_time" });
    expect(good.onEnd).toHaveBeenCalledWith(false);
    const bad = await ready();
    bad.socket.fire("dictation:live:ended", { reason: "upstream_error" });
    expect(bad.onEnd).toHaveBeenCalledWith(true);
  });

  it("abort is silent and releases everything", async () => {
    const { session, socket, onEnd } = await ready();
    session.abort();
    expect(onEnd).not.toHaveBeenCalled();
    expect(socket.disconnected).toBe(true);
    expect(FakeAudioContext.last.close).toHaveBeenCalled();
  });

  it("never stops the microphone stream itself", async () => {
    const tracked = { getTracks: vi.fn() };
    const { session } = await ready({ stream: tracked });
    session.abort();
    expect(tracked.getTracks).not.toHaveBeenCalled();
  });
});
