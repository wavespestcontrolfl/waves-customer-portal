// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DictationButton from "./DictationButton";
import useDictationPending from "../../hooks/dictationPending";
import { forgetServerDictation } from "../../hooks/serverDictation";

// GATE_SERVER_DICTATION through the shared mic button: the Transcribing state,
// the cross-page "words are on the way" signal, and the browser mic left alone.

class FakeRecorder {
  static isTypeSupported() { return true; }
  constructor(stream, opts) { this.mimeType = opts?.mimeType || ""; this.state = "inactive"; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["pcm"], { type: this.mimeType }) });
    this.onstop?.();
  }
}
const browserMic = vi.fn();
class FakeSpeechRecognition { constructor() { browserMic(); this.start = vi.fn(); this.stop = vi.fn(); this.abort = vi.fn(); } }

function SendButton() {
  const pending = useDictationPending();
  return <button type="button" disabled={pending}>Send</button>;
}

beforeEach(() => {
  forgetServerDictation();
  browserMic.mockClear();
  localStorage.setItem("waves_admin_token", "staff-jwt");
  window.webkitSpeechRecognition = FakeSpeechRecognition;
  window.MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.MediaRecorder;
  delete window.webkitSpeechRecognition;
});

describe("DictationButton with server dictation on", () => {
  it("holds Send from the tap until the words land, shows Transcribing, and never starts the browser mic", async () => {
    let resolveClip;
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (String(url).endsWith("/availability")) return { ok: true, json: async () => ({ available: true }) };
      expect(opts.method).toBe("POST");
      return new Promise((r) => { resolveClip = r; });
    }));
    const onAppend = vi.fn();
    render(<><DictationButton onAppend={onAppend} title="Dictate" /><SendButton /></>);
    const mic = await screen.findByRole("button", { name: "Dictate" });
    expect(screen.getByText("Send")).toBeEnabled();

    await act(async () => { fireEvent.click(mic); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation" })).toBeInTheDocument());
    expect(screen.getByText("Send")).toBeDisabled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop dictation" })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Transcribing" })).toBeDisabled());
    expect(screen.getByText("Send")).toBeDisabled();

    await act(async () => { resolveClip({ ok: true, json: async () => ({ text: "Gate is on the left." }) }); });
    await waitFor(() => expect(onAppend).toHaveBeenCalledWith("Gate is on the left."));
    await waitFor(() => expect(screen.getByText("Send")).toBeEnabled());
    expect(browserMic).not.toHaveBeenCalled();
  });

  it("gate off: Send is never held and the browser mic is the one that listens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ available: false }) })));
    render(<><DictationButton onAppend={vi.fn()} title="Dictate" /><SendButton /></>);
    const mic = await screen.findByRole("button", { name: "Dictate" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(mic); });
    expect(browserMic).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Send")).toBeEnabled();
  });
});
