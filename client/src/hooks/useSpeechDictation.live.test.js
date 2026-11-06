// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useSpeechDictation from "./useSpeechDictation";
import { forgetServerDictation } from "./serverDictation";

// GATE_DICTATION_LIVE_WORDS in the hook: liveText while the mic records, cleared when the final words land.
// The live session itself (socket + audio) is faked here; liveDictation.test.js covers it.

const sessions = [];
vi.mock("./liveDictation", () => ({
  startLiveWords: vi.fn((args) => {
    const session = { args, stop: vi.fn(), abort: vi.fn() };
    sessions.push(session);
    return session;
  }),
}));

class FakeRecorder {
  static isTypeSupported(t) { return t === "audio/webm;codecs=opus"; }
  constructor(stream, opts) { this.stream = stream; this.mimeType = opts?.mimeType || ""; this.state = "inactive"; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["pcm"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const yes = (body) => ({ ok: true, json: async () => body });
let clipResponse;
let stream;

function stubServer({ liveWords = true } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/tech/dictation/availability")) return yes({ available: true, liveWords });
    if (path.endsWith("/tech/dictation") && opts?.method === "POST") return clipResponse();
    throw new Error(`unexpected fetch ${url}`);
  }));
}

async function recording(options) {
  const hook = renderHook((props) => useSpeechDictation(vi.fn(), props), { initialProps: options });
  await waitFor(() => expect(hook.result.current.mode).toBe("upload"));
  await act(async () => { hook.result.current.toggle(); });
  await waitFor(() => expect(hook.result.current.listening).toBe(true));
  return hook;
}

beforeEach(() => {
  sessions.length = 0;
  forgetServerDictation();
  localStorage.setItem("waves_admin_token", "staff-jwt");
  window.MediaRecorder = FakeRecorder;
  stream = { getTracks: () => [{ stop: vi.fn() }] };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal("alert", vi.fn());
  clipResponse = () => yes({ text: "Treated the lanai." });
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.MediaRecorder;
});

describe("useSpeechDictation live words", () => {
  it("starts a session on the SAME stream with the field's ids, shows its words, and clears them when the final words land", async () => {
    stubServer();
    let release;
    clipResponse = () => new Promise((resolve) => { release = () => resolve(yes({ text: "Treated the lanai." })); });
    const { result } = await recording({ dictationContext: { customerId: CUSTOMER } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].args.stream).toBe(stream);
    expect(sessions[0].args.context.customerId).toBe(CUSTOMER);
    expect(sessions[0].args.token).toBe("staff-jwt");

    act(() => sessions[0].args.onText("Treated the"));
    expect(result.current.liveText).toBe("Treated the");

    // The mic stops: the preview stops taking audio but stays up while the clip is transcribed.
    await act(async () => { result.current.toggle(); });
    expect(sessions[0].stop).toHaveBeenCalledTimes(1);
    act(() => sessions[0].args.onText("Treated the lanai"));
    expect(result.current.liveText).toBe("Treated the lanai");
    await waitFor(() => expect(release).toBeTypeOf("function"));

    await act(async () => { release(); });
    await waitFor(() => expect(result.current.liveText).toBe(""));
    expect(sessions[0].abort).toHaveBeenCalled();
  });

  it("opens no session when the server did not offer live words", async () => {
    stubServer({ liveWords: false });
    const { result } = await recording({});
    expect(sessions).toHaveLength(0);
    expect(result.current.liveText).toBe("");
  });

  it("a failed live session clears the preview and leaves the recording and the final words alone", async () => {
    stubServer();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    act(() => sessions[0].args.onText("Treated"));
    act(() => sessions[0].args.onEnd(true));
    expect(result.current.liveText).toBe("");
    expect(result.current.listening).toBe(true);
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Treated the lanai."));
  });

  it("a session that ends well keeps its words up until the final words land", async () => {
    stubServer();
    const { result } = await recording({});
    act(() => sessions[0].args.onText("Treated the lanai"));
    act(() => sessions[0].args.onEnd(false));
    expect(result.current.liveText).toBe("Treated the lanai");
  });

  it("a failed clip clears the preview too", async () => {
    stubServer();
    clipResponse = () => ({ ok: false, status: 502, json: async () => ({ error: "Transcription unavailable" }) });
    const { result } = await recording({});
    act(() => sessions[0].args.onText("Treated"));
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.liveText).toBe(""));
  });

  it("cancel ends the session and drops the words", async () => {
    stubServer();
    const { result } = await recording({});
    act(() => sessions[0].args.onText("Treated"));
    act(() => result.current.cancel());
    expect(sessions[0].abort).toHaveBeenCalled();
    expect(result.current.liveText).toBe("");
  });

  it("unmounting ends the session", async () => {
    stubServer();
    const { unmount } = await recording({});
    unmount();
    expect(sessions[0].abort).toHaveBeenCalled();
  });

  it("a target change mid-recording ends the session and drops the words; late words are ignored", async () => {
    stubServer();
    const { result, rerender } = await recording({ dictationContext: { customerId: CUSTOMER } });
    act(() => sessions[0].args.onText("Treated"));
    rerender({ dictationContext: { customerId: "33333333-3333-4333-8333-333333333333" } });
    await waitFor(() => expect(result.current.liveText).toBe(""));
    expect(sessions[0].abort).toHaveBeenCalled();
    act(() => sessions[0].args.onText("late words"));
    expect(result.current.liveText).toBe("");
  });
});
