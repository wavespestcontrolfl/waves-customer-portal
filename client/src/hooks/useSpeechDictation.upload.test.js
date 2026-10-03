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

  it("reports starting from the tap until the recording begins", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) });
    let resolveStream;
    navigator.mediaDevices.getUserMedia.mockImplementation(() => new Promise((r) => { resolveStream = r; }));
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    expect(result.current.starting).toBe(false);
    act(() => { result.current.toggle(); });
    // The permission prompt is open: nothing is recording yet, but the
    // caller must already treat the dictation as under way.
    expect(result.current.starting).toBe(true);
    expect(result.current.listening).toBe(false);
    await act(async () => { resolveStream({ getTracks: () => [track] }); });
    expect(result.current.starting).toBe(false);
    expect(result.current.listening).toBe(true);
  });

  it("clears starting when the microphone is refused", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) });
    let refuse;
    navigator.mediaDevices.getUserMedia.mockImplementation(() => new Promise((_, reject) => { refuse = reject; }));
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    act(() => { result.current.toggle(); });
    expect(result.current.starting).toBe(true);
    await act(async () => { refuse(new Error("Permission denied")); });
    expect(result.current.starting).toBe(false);
    expect(result.current.listening).toBe(false);
    expect(alert).toHaveBeenCalledWith("Microphone unavailable: Permission denied");
  });

  it("releases the microphone when the recorder cannot be constructed", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) });
    window.MediaRecorder = class { static isTypeSupported() { return false; } constructor() { throw new Error("NotSupportedError"); } };
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.listening).toBe(false);
    expect(result.current.starting).toBe(false);
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
    expect(result.current.starting).toBe(false);
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

  it("a transcript that lands after the target visit changed is dropped", async () => {
    const onTranscript = vi.fn();
    let resolveUpload;
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) })
      .mockImplementationOnce(() => new Promise((r) => { resolveUpload = r; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: true }) });
    const { result, rerender } = renderHook(({ id }) => useSpeechDictation(onTranscript, { uploadServiceId: id }), { initialProps: { id: "svc-1" } });
    await waitFor(() => expect(result.current.mode).toBe("upload"));
    await act(async () => { result.current.toggle(); });
    await act(async () => { result.current.toggle(); });
    await waitFor(() => expect(result.current.uploading).toBe(true));
    rerender({ id: "svc-2" });
    await act(async () => { resolveUpload({ ok: true, json: async () => ({ text: "stale words" }) }); });
    await waitFor(() => expect(result.current.uploading).toBe(false));
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("never touches the upload path when SpeechRecognition exists", async () => {
    window.webkitSpeechRecognition = class { start() {} stop() {} abort() {} };
    const { result } = renderHook(() => useSpeechDictation(vi.fn(), { uploadServiceId: "svc-1" }));
    expect(result.current.mode).toBe("speech");
    expect(result.current.supported).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  describe("clip mode (clipHandler)", () => {
    it("always records, even where SpeechRecognition exists, and never asks availability or transcribes", async () => {
      const recognition = vi.fn();
      window.SpeechRecognition = recognition;
      const clipHandler = vi.fn(async () => {});
      const onTranscript = vi.fn();
      const { result } = renderHook(() => useSpeechDictation(onTranscript, { clipHandler }));
      expect(result.current.mode).toBe("upload");
      expect(result.current.supported).toBe(true);

      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(true));
      expect(recognition).not.toHaveBeenCalled();
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(clipHandler).toHaveBeenCalledTimes(1));
      const [blob, seconds] = clipHandler.mock.calls[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
      expect(typeof seconds).toBe("number");
      expect(fetch).not.toHaveBeenCalled();
      expect(onTranscript).not.toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalled();
      delete window.SpeechRecognition;
    });

    it("is uploading while the handler runs", async () => {
      let finish;
      const clipHandler = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
      const { result } = renderHook(() => useSpeechDictation(null, { clipHandler }));
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(true));
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.uploading).toBe(true));
      await act(async () => { finish(); });
      await waitFor(() => expect(result.current.uploading).toBe(false));
    });

    it("stops recording when the page is hidden, and hands over what was recorded", async () => {
      const clipHandler = vi.fn(async () => {});
      const { result } = renderHook(() => useSpeechDictation(null, { clipHandler }));
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(true));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await waitFor(() => expect(clipHandler).toHaveBeenCalledTimes(1));
      expect(result.current.listening).toBe(false);
      expect(track.stop).toHaveBeenCalled();
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    });

    it("never starts a clip on a page hidden while the mic prompt was open", async () => {
      const clipHandler = vi.fn(async () => {});
      const { result } = renderHook(() => useSpeechDictation(null, { clipHandler }));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(track.stop).toHaveBeenCalled());
      expect(result.current.listening).toBe(false);
      expect(clipHandler).not.toHaveBeenCalled();
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    });

    it("takes the hidden-page guard off once the clip stops, and on unmount", async () => {
      // pagehide is the guard's own listener (visibilitychange is shared with speech mode)
      const added = vi.spyOn(window, "addEventListener");
      const removed = vi.spyOn(window, "removeEventListener");
      const count = (spy) => spy.mock.calls.filter(([type]) => type === "pagehide").length;
      const { result, unmount } = renderHook(() => useSpeechDictation(null, { clipHandler: vi.fn(async () => {}) }));
      // the guard is on by the time recording is reported: no gap to miss a lock in
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(true));
      expect(count(added)).toBe(1);
      expect(count(removed)).toBe(0);
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(false));
      expect(count(removed)).toBe(1);
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(true));
      unmount();
      expect(count(added)).toBe(2);
      expect(count(removed)).toBe(2);
      added.mockRestore(); removed.mockRestore();
    });

    it("a forgotten mic stops by itself at the cutoff and hands over the clip", async () => {
      const clipHandler = vi.fn(async () => {});
      const { result } = renderHook(() => useSpeechDictation(null, { clipHandler, clipMaxMs: 40 }));
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(true));
      await waitFor(() => expect(clipHandler).toHaveBeenCalledTimes(1));
      expect(result.current.listening).toBe(false);
      expect(track.stop).toHaveBeenCalled();
    });

    it("a clip the tech stops is not stopped again by the cutoff", async () => {
      const clipHandler = vi.fn(async () => {});
      const { result } = renderHook(() => useSpeechDictation(null, { clipHandler, clipMaxMs: 60 }));
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(true));
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(clipHandler).toHaveBeenCalledTimes(1));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
      expect(clipHandler).toHaveBeenCalledTimes(1);
    });

    it("stops recording on pagehide", async () => {
      const clipHandler = vi.fn(async () => {});
      const { result } = renderHook(() => useSpeechDictation(null, { clipHandler }));
      await act(async () => { result.current.toggle(); });
      await waitFor(() => expect(result.current.listening).toBe(true));
      await act(async () => { window.dispatchEvent(new Event("pagehide")); });
      await waitFor(() => expect(result.current.listening).toBe(false));
    });

    it("is unsupported where the browser cannot record", () => {
      delete window.MediaRecorder;
      const { result } = renderHook(() => useSpeechDictation(null, { clipHandler: vi.fn() }));
      expect(result.current.supported).toBe(false);
      expect(result.current.mode).toBe(null);
    });
  });
});

