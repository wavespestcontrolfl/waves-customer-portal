// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useSpeechDictation from "./useSpeechDictation";

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

const track = { stop: vi.fn() };

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "tech-jwt");
  FakeRecorder.instances = [];
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
  window.MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.MediaRecorder;
});

describe("useSpeechDictation upload fallback", () => {
  it("asks availability only without SpeechRecognition; stays unsupported when the server says no", async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ available: false }) });
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe("/api/tech/services/svc-1/dictation/availability");
    expect(opts.headers.Authorization).toBe("Bearer tech-jwt");
    expect(result.current.supported).toBe(false);
    expect(result.current.mode).toBe(null);
  });

  it("records with MediaRecorder, uploads the clip on stop, and appends the transcript", async () => {
    const onTranscript = vi.fn();
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "Treated the exterior perimeter." }) });
    const { result } = renderHook(() => useSpeechDictation(onTranscript, { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    expect(result.current.supported).toBe(true);

    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(FakeRecorder.instances[0].mimeType).toBe("audio/webm;codecs=opus");

    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Treated the exterior perimeter."));
    expect(result.current.listening).toBe(false);
    expect(result.current.uploading).toBe(false);
    expect(track.stop).toHaveBeenCalled();

    const [url, opts] = fetch.mock.calls[1];
    expect(url).toBe("/api/tech/services/svc-1/dictation");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tech-jwt");
    expect(opts.body).toBeInstanceOf(FormData);
    const file = opts.body.get("audio");
    expect(file.name).toBe("dictation.webm");
    expect(opts.body.get("duration_seconds")).toMatch(/^\d+$/);
    expect(alert).not.toHaveBeenCalled();
  });

  it("surfaces a failed upload and leaves the notes untouched", async () => {
    const onTranscript = vi.fn();
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) })
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: "Transcription unavailable — type your notes instead" }) });
    const { result } = renderHook(() => useSpeechDictation(onTranscript, { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Dictation error: Transcription unavailable — type your notes instead"));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.uploading).toBe(false);
  });

  it("a second tap while the permission prompt is open does not open a second stream", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) });
    let resolveStream;
    navigator.mediaDevices.getUserMedia.mockImplementation(() => new Promise((r) => { resolveStream = r; }));
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    act(() => { result.current.toggle(); });
    act(() => { result.current.toggle(); });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    await act(async () => { resolveStream({ getTracks: () => [track] }); });
    await waitFor(() => expect(result.current.listening).toBe(true));
    expect(FakeRecorder.instances).toHaveLength(1);
  });

  it("releases the microphone when the recorder cannot be constructed", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) });
    window.MediaRecorder = class { static isTypeSupported() { return false; } constructor() { throw new Error("NotSupportedError"); } };
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.listening).toBe(false);
    expect(alert).toHaveBeenCalledWith("Dictation error: NotSupportedError");
    // Not stuck: a later tap starts a fresh attempt.
    await act(async () => { result.current.toggle(); });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("releases the microphone when start() throws synchronously", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) });
    window.MediaRecorder = class extends FakeRecorder { start() { throw new Error("InvalidStateError"); } };
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.listening).toBe(false);
    expect(alert).toHaveBeenCalledWith("Dictation error: InvalidStateError");
    await act(async () => { result.current.toggle(); });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("a recorder error never uploads the partial clip", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) });
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    const rec = FakeRecorder.instances[0];
    await act(async () => { rec.ondataavailable?.({ data: new Blob(["partial"]) }); rec.onerror?.(new Event("error")); rec.onstop?.(); });
    expect(fetch).toHaveBeenCalledTimes(1); // availability only — no upload
    expect(result.current.listening).toBe(false);
    expect(alert).toHaveBeenCalledWith("Dictation error: recording failed");
  });

  it("never touches the upload path when SpeechRecognition exists", async () => {
    window.webkitSpeechRecognition = class { start() {} stop() {} abort() {} };
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    expect(result.current.mode).toBe("speech");
    expect(result.current.supported).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });
});
