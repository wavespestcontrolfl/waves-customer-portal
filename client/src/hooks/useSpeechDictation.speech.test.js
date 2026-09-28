// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useSpeechDictation from "./useSpeechDictation";

class FakeSpeechRecognition {
  static instances = [];
  constructor() {
    this.continuous = false;
    this.interimResults = false;
    this.lang = "";
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    FakeSpeechRecognition.instances.push(this);
  }
}

// Fires a final transcript chunk through the instance's onresult, the shape
// the hook reads (ev.results[i].isFinal / ev.results[i][0].transcript).
function fireFinalResult(instance, text) {
  instance.onresult?.({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: text }, length: 1 }],
  });
}

beforeEach(() => {
  FakeSpeechRecognition.instances = [];
  delete window.SpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
  delete window.MediaRecorder;
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.webkitSpeechRecognition;
});

describe("useSpeechDictation speech path — keep listening through pauses", () => {
  it("restarts the same instance on a bare onend and keeps listening true", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];
    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(true);

    act(() => instance.onend());

    expect(FakeSpeechRecognition.instances).toHaveLength(1); // same instance, not a new one
    expect(instance.start).toHaveBeenCalledTimes(2);
    expect(result.current.listening).toBe(true);
  });

  it("a first start() that throws leaves no stuck session: alert, not listening, and the next tap starts fresh", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    const RealFake = window.webkitSpeechRecognition;
    window.webkitSpeechRecognition = class extends RealFake {
      constructor() {
        super();
        this.start = vi.fn(() => { throw new Error("InvalidStateError"); });
      }
    };
    act(() => result.current.toggle());
    expect(alert).toHaveBeenCalledWith("Dictation error: InvalidStateError");
    expect(result.current.listening).toBe(false);

    window.webkitSpeechRecognition = RealFake;
    act(() => result.current.toggle());
    const fresh = FakeSpeechRecognition.instances[1];
    expect(fresh.stop).not.toHaveBeenCalled();
    expect(fresh.start).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(true);
  });

  it("a tap-to-stop calls stop() and the following onend does not restart", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    act(() => result.current.toggle()); // second tap
    expect(instance.stop).toHaveBeenCalledTimes(1);

    act(() => instance.onend()); // browser's real onend after stop()

    expect(instance.start).toHaveBeenCalledTimes(1); // no restart
    expect(result.current.listening).toBe(false);
  });

  it("a no-speech error does not stop the loop — the following onend restarts", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    act(() => instance.onerror({ error: "no-speech" }));
    act(() => instance.onend());

    expect(instance.start).toHaveBeenCalledTimes(2);
    expect(result.current.listening).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it("not-allowed shows the friendly mic-blocked alert and does not restart", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    act(() => instance.onerror({ error: "not-allowed" }));
    act(() => instance.onend());

    expect(alert).toHaveBeenCalledWith(
      "Microphone access is blocked. Allow mic permission for this site, or use the keyboard mic on your phone.",
    );
    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(false);
  });

  it("a network error alerts and does not restart", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    act(() => instance.onerror({ error: "network" }));
    act(() => instance.onend());

    expect(alert).toHaveBeenCalledWith("Dictation error: network");
    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(false);
  });

  it("an aborted error ends the session with no alert and no restart", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    act(() => instance.onerror({ error: "aborted" }));
    act(() => instance.onend());

    expect(alert).not.toHaveBeenCalled();
    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(false);
  });

  it("stops after 60s with no final result since the session started", () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    now += 60_000;
    act(() => instance.onend());

    expect(instance.start).toHaveBeenCalledTimes(1); // no restart — idle
    expect(result.current.listening).toBe(false);
  });

  it("a final result resets the idle clock so a later onend still restarts", () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    now += 59_000;
    act(() => fireFinalResult(instance, "hello"));
    now += 59_000; // 118s since start, but only 59s since the final result
    act(() => instance.onend());

    expect(instance.start).toHaveBeenCalledTimes(2);
    expect(result.current.listening).toBe(true);
  });

  it("stops after 3 consecutive fast (<1s), empty sessions", () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    now += 100; // fast, empty end #1 — restarts (streak 1)
    act(() => instance.onend());
    expect(result.current.listening).toBe(true);

    now += 100; // fast, empty end #2 — restarts (streak 2)
    act(() => instance.onend());
    expect(result.current.listening).toBe(true);

    now += 100; // fast, empty end #3 — stops (streak 3)
    act(() => instance.onend());

    expect(instance.start).toHaveBeenCalledTimes(3); // initial + 2 restarts, no 3rd
    expect(result.current.listening).toBe(false);
  });

  it("a final result before the fast-end streak breaks it", () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    now += 100;
    act(() => instance.onend()); // streak 1
    now += 100;
    act(() => fireFinalResult(instance, "hi"));
    act(() => instance.onend()); // had a result this session — streak resets to 0
    now += 100;
    act(() => instance.onend()); // streak 1 again, not 3
    now += 100;
    act(() => instance.onend()); // streak 2, not 3

    expect(result.current.listening).toBe(true);
  });

  it("does not restart while the page is hidden", () => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    act(() => instance.onend());

    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(false);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });

  it("finishes normally when the restart start() throws", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];
    instance.start = vi.fn(() => {
      throw new Error("InvalidStateError");
    });

    act(() => instance.onend());

    expect(result.current.listening).toBe(false);
  });

  it("unmounting mid-session aborts and delivers no further transcript", () => {
    const onTranscript = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechDictation(onTranscript));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    unmount();

    expect(instance.abort).toHaveBeenCalledTimes(1);
    expect(instance.onresult).toBeNull();
    expect(instance.onend).toBeNull();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("delivers final transcripts from both before and after a restart", () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    act(() => fireFinalResult(instance, "before the pause"));
    act(() => instance.onend()); // restart, same instance
    act(() => fireFinalResult(instance, "after the pause"));

    expect(onTranscript).toHaveBeenNthCalledWith(1, "before the pause");
    expect(onTranscript).toHaveBeenNthCalledWith(2, "after the pause");
    expect(result.current.listening).toBe(true);
  });
  it("the idle timer stops a live session that never fires onend on its own, and re-arms on each final result", () => {
    vi.useFakeTimers();
    try {
      const onTranscript = vi.fn();
      const { result } = renderHook(() => useSpeechDictation(onTranscript));
      act(() => result.current.toggle());
      const instance = FakeSpeechRecognition.instances[0];

      act(() => vi.advanceTimersByTime(50000));
      act(() => fireFinalResult(instance, "still talking")); // re-arms
      act(() => vi.advanceTimersByTime(50000));
      expect(instance.stop).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(10000)); // 60 s since the last final result
      expect(instance.stop).toHaveBeenCalledTimes(1);
      act(() => instance.onend());
      expect(instance.start).toHaveBeenCalledTimes(1); // stopped, not restarted
      expect(result.current.listening).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the idle timer stops a live session where nothing is ever said", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSpeechDictation(vi.fn()));
      act(() => result.current.toggle());
      const instance = FakeSpeechRecognition.instances[0];

      act(() => vi.advanceTimersByTime(59999));
      expect(instance.stop).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(instance.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking any other button (Save, Generate, Send) stops a live session; a click on plain content does not", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    const text = document.createElement("p");
    text.textContent = "report text";
    const save = document.createElement("button");
    const saveLabel = document.createElement("span"); // a click lands on the label inside
    save.appendChild(saveLabel);
    document.body.append(text, save);
    try {
      act(() => text.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(instance.stop).not.toHaveBeenCalled();

      act(() => saveLabel.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(instance.stop).toHaveBeenCalledTimes(1);
      act(() => instance.onend());
      expect(instance.start).toHaveBeenCalledTimes(1); // stopped, not restarted
      expect(result.current.listening).toBe(false);
    } finally {
      text.remove();
      save.remove();
    }
  });

  it("the mic's own click is the normal tap-to-stop: the document listener skips it, toggle stops, and the last words still arrive", () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    const mic = document.createElement("button");
    const micIcon = document.createElement("svg");
    mic.appendChild(micIcon);
    document.body.append(mic);
    try {
      act(() => result.current.toggle({ currentTarget: mic })); // the click that started it
      const instance = FakeSpeechRecognition.instances[0];

      // The mic's own click reaches the document listener first: it must be
      // skipped there, so the one gesture is a single tap-to-stop.
      act(() => micIcon.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(instance.stop).not.toHaveBeenCalled();

      act(() => result.current.toggle({ currentTarget: mic })); // the click: tap-to-stop
      expect(instance.stop).toHaveBeenCalledTimes(1);
      act(() => fireFinalResult(instance, "last words"));
      expect(onTranscript).toHaveBeenCalledWith("last words");
      act(() => instance.onend());
      expect(instance.start).toHaveBeenCalledTimes(1);
      expect(result.current.listening).toBe(false);
    } finally {
      mic.remove();
    }
  });

  it("a final result still in flight after another button stops the session is dropped", () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];
    const save = document.createElement("button");
    document.body.append(save);
    try {
      act(() => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      act(() => fireFinalResult(instance, "said while pressing save"));
      expect(onTranscript).not.toHaveBeenCalled();
    } finally {
      save.remove();
    }
  });

  it("cancel() stops the live session and drops a result still in flight; the next session delivers normally", () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    act(() => result.current.toggle());
    const first = FakeSpeechRecognition.instances[0];
    act(() => result.current.cancel());
    expect(first.stop).toHaveBeenCalledTimes(1);
    act(() => fireFinalResult(first, "in flight"));
    act(() => first.onend());
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.listening).toBe(false);

    act(() => result.current.toggle());
    const second = FakeSpeechRecognition.instances[1];
    act(() => fireFinalResult(second, "fresh words"));
    expect(onTranscript).toHaveBeenCalledWith("fresh words");
  });

  it("a keyboard-activated button (Enter / Space fire click with no pointer event) stops a live session", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];
    const complete = document.createElement("button");
    complete.type = "button";
    document.body.append(complete);
    try {
      act(() => complete.click()); // what the browser does on Enter / Space
      expect(instance.stop).toHaveBeenCalledTimes(1);
    } finally {
      complete.remove();
    }
  });

  it("a keypress (Enter in a prompt box running the action from onKeyDown) stops a live session; a bare modifier or a key on the mic does not", () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechDictation(onTranscript));
    const mic = document.createElement("button");
    const prompt = document.createElement("input");
    document.body.append(mic, prompt);
    try {
      act(() => result.current.toggle({ currentTarget: mic }));
      const instance = FakeSpeechRecognition.instances[0];

      act(() => prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true })));
      act(() => mic.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(instance.stop).not.toHaveBeenCalled();

      act(() => prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(instance.stop).toHaveBeenCalledTimes(1);
      act(() => fireFinalResult(instance, "after enter"));
      expect(onTranscript).not.toHaveBeenCalled(); // the action already read the prompt
    } finally {
      mic.remove();
      prompt.remove();
    }
  });

  it("submitting a form stops a live session", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    const form = document.createElement("form");
    document.body.append(form);
    try {
      act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(instance.stop).toHaveBeenCalledTimes(1);
    } finally {
      form.remove();
    }
  });

  it("hiding the page stops a live session right away, without waiting for onend", () => {
    const { result } = renderHook(() => useSpeechDictation(vi.fn()));
    act(() => result.current.toggle());
    const instance = FakeSpeechRecognition.instances[0];

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(instance.stop).toHaveBeenCalledTimes(1);
      act(() => instance.onend());
      expect(instance.start).toHaveBeenCalledTimes(1);
      expect(result.current.listening).toBe(false);
    } finally {
      visibility.mockRestore();
    }
  });
});
