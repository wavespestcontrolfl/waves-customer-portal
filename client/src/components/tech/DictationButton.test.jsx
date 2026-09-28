// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup, fireEvent, screen } from "@testing-library/react";
import DictationButton from "./DictationButton";

class FakeSpeechRecognition {
  static instances = [];
  constructor() {
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    FakeSpeechRecognition.instances.push(this);
  }
}

beforeEach(() => {
  FakeSpeechRecognition.instances = [];
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.webkitSpeechRecognition;
});

describe("DictationButton", () => {
  it("renders nothing without SpeechRecognition support", () => {
    const { container } = render(<DictationButton onAppend={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("starts listening on click, restarts on an unrequested onend, and stops on the second click", () => {
    window.webkitSpeechRecognition = FakeSpeechRecognition;
    const onAppend = vi.fn();
    render(<DictationButton onAppend={onAppend} title="Dictate" />);

    const button = screen.getByRole("button", { name: "Dictate" });
    fireEvent.click(button);

    const instance = FakeSpeechRecognition.instances[0];
    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Stop dictation" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The browser ends the session on its own after a pause — it must restart.
    act(() => instance.onend());
    expect(instance.start).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Stop dictation" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Second click stops it for good.
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(instance.stop).toHaveBeenCalledTimes(1);
    act(() => instance.onend());
    expect(instance.start).toHaveBeenCalledTimes(2); // no further restart
    expect(screen.getByRole("button", { name: "Dictate" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
  it("ends an active session when the consumer disables the button (no tap can stop it then)", () => {
    window.webkitSpeechRecognition = FakeSpeechRecognition;
    const { rerender } = render(<DictationButton onAppend={vi.fn()} />);
    act(() => fireEvent.click(screen.getByRole("button")));
    const instance = FakeSpeechRecognition.instances[0];
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");

    rerender(<DictationButton onAppend={vi.fn()} disabled />);
    expect(instance.stop).toHaveBeenCalledTimes(1);

    act(() => instance.onend()); // the browser's onend after stop()
    expect(instance.start).toHaveBeenCalledTimes(1); // no restart
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });
});
