// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useSpeechDictation from "./useSpeechDictation";
import { forgetServerDictation } from "./serverDictation";

// GATE_SERVER_DICTATION: every mic records a clip and the server transcribes it.

class FakeRecorder {
  static instances = [];
  static isTypeSupported(t) { return t === "audio/webm;codecs=opus"; }
  constructor(stream, opts) {
    this.stream = stream; this.mimeType = opts?.mimeType || ""; this.state = "inactive";
    FakeRecorder.instances.push(this);
  }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["pcm"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

class FakeSpeechRecognition {
  static instances = [];
  constructor() {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    FakeSpeechRecognition.instances.push(this);
  }
}

const track = { stop: vi.fn() };
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SERVICE = "22222222-2222-4222-8222-222222222222";

const yes = (body) => ({ ok: true, json: async () => body });

// Routes fetch by URL: availability answers `available`, the clip POST answers `clip`.
function stubServer({ available = true, clip = yes({ text: "Treated the lanai for roaches." }) } = {}) {
  const fn = vi.fn(async (url, opts) => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/tech/dictation/availability")) return typeof available === "function" ? available() : yes({ available });
    if (path.endsWith("/tech/dictation") && opts?.method === "POST") return clip;
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const postsTo = (fn) => fn.mock.calls.filter(([url, o]) => String(url).split("?")[0].endsWith("/tech/dictation") && o?.method === "POST");
const callsTo = (fn, suffix) => fn.mock.calls.filter(([url]) => String(url).split("?")[0].endsWith(suffix));

beforeEach(() => {
  forgetServerDictation();
  localStorage.setItem("waves_admin_token", "staff-jwt");
  FakeRecorder.instances = [];
  FakeSpeechRecognition.instances = [];
  // An iPhone browser: it HAS speech recognition (Apple dictation) and can record.
  window.webkitSpeechRecognition = FakeSpeechRecognition;
  delete window.SpeechRecognition;
  window.MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.MediaRecorder;
  delete window.webkitSpeechRecognition;
});

describe("useSpeechDictation with server dictation on", () => {
  it("records a clip on a browser that HAS speech recognition and never starts the browser mic", async () => {
    const onTranscript = vi.fn();
    const fetchMock = stubServer();
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    expect(result.current.supported).toBe(true);

    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(FakeSpeechRecognition.instances).toHaveLength(0);

    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Treated the lanai for roaches."));
    expect(result.current.uploading).toBe(false);
    expect(track.stop).toHaveBeenCalled();

    const [url, opts] = callsTo(fetchMock, "/tech/dictation").find(([, o]) => o?.method === "POST");
    expect(url).toBe("/api/tech/dictation");
    expect(opts.headers.Authorization).toBe("Bearer staff-jwt");
    expect(opts.body.get("audio").name).toBe("dictation.webm");
    expect(opts.body.get("duration_seconds")).toMatch(/^\d+$/);
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
  });

  it("sends ids only, in the query (the server checks them before it reads the clip), never words", async () => {
    const fetchMock = stubServer();
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { dictationContext: { customerId: CUSTOMER, serviceId: SERVICE } }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(postsTo(fetchMock)).toHaveLength(1));
    const [url, opts] = postsTo(fetchMock)[0];
    const query = new URL(url, "http://x").searchParams;
    expect([...query.keys()].sort()).toEqual(["customer_id", "service_id"]);
    expect(query.get("customer_id")).toBe(CUSTOMER);
    expect(query.get("service_id")).toBe(SERVICE);
    expect([...opts.body.keys()].sort()).toEqual(["audio", "duration_seconds"]);
  });

  it("a visit id given for the older upload path is also the visit context", async () => {
    const fetchMock = stubServer();
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: SERVICE }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(postsTo(fetchMock)).toHaveLength(1));
    expect(new URL(postsTo(fetchMock)[0][0], "http://x").searchParams.get("service_id")).toBe(SERVICE);
    // the per-visit availability route is not asked when the server transcribes every mic
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/tech/services/"))).toBe(false);
  });

  it("asks the server once per session, however many mics mount", async () => {
    const fetchMock = stubServer();
    const a = renderHook(() => useSpeechDictation(vi.fn()));
    const b = renderHook(() => useSpeechDictation(vi.fn()));
    await waitFor(() => expect(a.result.current.mode).toBe("upload"));
    await waitFor(() => expect(b.result.current.mode).toBe("upload"));
    const c = renderHook(() => useSpeechDictation(vi.fn()));
    // a mic mounting after the answer needs no request and starts in upload mode
    expect(c.result.current.mode).toBe("upload");
    expect(callsTo(fetchMock, "/tech/dictation/availability")).toHaveLength(1);
  });

  it("drops a transcript that arrives after the mic moved to another customer", async () => {
    const onTranscript = vi.fn();
    let resolveClip;
    const clip = new Promise((r) => { resolveClip = r; });
    stubServer({ clip });
    const { result, rerender } = renderHook(({ customerId }) => useSpeechDictation(onTranscript, { dictationContext: { customerId } }), { initialProps: { customerId: CUSTOMER } });
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.uploading).toBe(true));
    rerender({ customerId: "33333333-3333-4333-8333-333333333333" });
    await act(async () => { resolveClip(yes({ text: "Words for the first customer." })); });
    await waitFor(() => expect(result.current.uploading).toBe(false));
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("a target change mid-RECORDING: the clip is sent for the customer it was started on and its words are dropped, never put into the new field", async () => {
    const onTranscript = vi.fn();
    const fetchMock = stubServer();
    const B = "33333333-3333-4333-8333-333333333333";
    const { result, rerender } = renderHook(({ customerId }) => useSpeechDictation(onTranscript, { dictationContext: { customerId } }), { initialProps: { customerId: CUSTOMER } });
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    rerender({ customerId: B });
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(postsTo(fetchMock)).toHaveLength(1));
    expect(new URL(postsTo(fetchMock)[0][0], "http://x").searchParams.get("customer_id")).toBe(CUSTOMER);
    await waitFor(() => expect(result.current.uploading).toBe(false));
    expect(onTranscript).not.toHaveBeenCalled();
    // and a recording started on B afterwards lands on B
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Treated the lanai for roaches."));
    expect(new URL(postsTo(fetchMock)[1][0], "http://x").searchParams.get("customer_id")).toBe(B);
  });

  it("one microphone at a time: starting a second mic stops the first and hands over its clip", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const fetchMock = stubServer();
    const a = renderHook(() => useSpeechDictation(first));
    const b = renderHook(() => useSpeechDictation(second));
    await waitFor(() => expect(a.result.current.mode).toBe("upload"));
    await waitFor(() => expect(b.result.current.mode).toBe("upload"));
    await act(async () => { a.result.current.toggle(); });
    await waitFor(() => expect(a.result.current.listening).toBe(true));
    await act(async () => { b.result.current.toggle(); });
    await waitFor(() => expect(b.result.current.listening).toBe(true));
    // the first mic's recording ended and was sent; only the second still records
    expect(a.result.current.listening).toBe(false);
    await waitFor(() => expect(first).toHaveBeenCalledWith("Treated the lanai for roaches."));
    expect(postsTo(fetchMock)).toHaveLength(1);
    expect(FakeRecorder.instances.filter((r) => r.state === "recording")).toHaveLength(1);
    await act(async () => { b.result.current.toggle(); });
    await waitFor(() => expect(second).toHaveBeenCalled());
  });

  it("a mic still waiting for the permission prompt when another mic takes over never starts recording", async () => {
    stubServer();
    let resolveStream;
    navigator.mediaDevices.getUserMedia.mockImplementationOnce(() => new Promise((r) => { resolveStream = r; }));
    const a = renderHook(() => useSpeechDictation(vi.fn()));
    const b = renderHook(() => useSpeechDictation(vi.fn()));
    await waitFor(() => expect(a.result.current.mode).toBe("upload"));
    await waitFor(() => expect(b.result.current.mode).toBe("upload"));
    act(() => { a.result.current.toggle(); });
    await act(async () => { b.result.current.toggle(); });
    await waitFor(() => expect(b.result.current.listening).toBe(true));
    await act(async () => { resolveStream({ getTracks: () => [track] }); });
    await waitFor(() => expect(a.result.current.starting).toBe(false));
    expect(a.result.current.listening).toBe(false);
    expect(FakeRecorder.instances).toHaveLength(1);
  });

  it("a recording ends when the page is hidden and the clip is still transcribed", async () => {
    const onTranscript = vi.fn();
    stubServer();
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Treated the lanai for roaches."));
    expect(result.current.listening).toBe(false);
    delete document.visibilityState;
    if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
  });

  it("a refusal is shown, the notes stay untouched, and a 404 (gate went off) returns the mic to the browser", async () => {
    const onTranscript = vi.fn();
    stubServer({ clip: { ok: false, status: 404, json: async () => ({ error: "Server dictation is not available" }) } });
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Dictation error: Server dictation is not available"));
    expect(onTranscript).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.mode).toBe("speech"));
  });

  it("a speech session started before the server answered is stopped by its own tap", async () => {
    let answer;
    stubServer({ available: () => new Promise((r) => { answer = r; }) });
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    expect(result.current.mode).toBe("speech");
    act(() => { result.current.toggle(); });
    expect(FakeSpeechRecognition.instances).toHaveLength(1);
    await act(async () => { answer(yes({ available: true })); });
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    act(() => { result.current.toggle(); });
    expect(FakeSpeechRecognition.instances[0].stop).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.instances).toHaveLength(0);
  });
});

describe("useSpeechDictation with server dictation off", () => {
  it("gate off: the browser's speech recognition runs exactly as before and no clip is ever posted", async () => {
    const fetchMock = stubServer({ available: false });
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    await waitFor(() => expect(callsTo(fetchMock, "/tech/dictation/availability")).toHaveLength(1));
    expect(result.current.mode).toBe("speech");
    act(() => { result.current.toggle(); });
    expect(FakeSpeechRecognition.instances).toHaveLength(1);
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(postsTo(fetchMock)).toHaveLength(0);
  });

  it("an availability request that fails (offline, 500, 401) leaves the browser mic and is asked again next time", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    const first = renderHook(() => useSpeechDictation(vi.fn()));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(first.result.current.mode).toBe("speech");
    await act(async () => { await Promise.resolve(); });
    renderHook(() => useSpeechDictation(vi.fn()));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("a browser that cannot record never asks the server and keeps the speech path", async () => {
    delete window.MediaRecorder;
    const fetchMock = stubServer();
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("speech");
  });

  it("no login token: no request and the speech path", async () => {
    localStorage.clear();
    const fetchMock = stubServer();
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("speech");
  });

  it("clip mode (Fast Complete voice fill) never asks the server about dictation", async () => {
    const fetchMock = stubServer();
    const clipHandler = vi.fn(async () => {});
    const { result } = renderHook(() => useSpeechDictation(null, { clipHandler }));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("upload");
  });
});
