// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FocusedBoxMic from "./FocusedBoxMic";
import { Dialog } from "../ui/Dialog";
import useDictationPending from "../../hooks/dictationPending";
import { forgetServerDictation } from "../../hooks/serverDictation";
import { IntelligenceBarPageDataProvider, usePublishIntelligenceBarPageData } from "../../hooks/useIntelligenceBarPageData";

// GATE_DICTATION_EVERY_BOX: one Waves mic on every staff text box with none of
// its own. The recorder and the server are faked; the box, the focus handling
// and the insertion are real.

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

// The live-words preview comes from the hook (GATE_DICTATION_LIVE_WORDS); a test sets it here.
const live = vi.hoisted(() => ({ text: "" }));
vi.mock("../../hooks/useSpeechDictation", async (importOriginal) => {
  const real = (await importOriginal()).default;
  return { default: (...args) => { const r = real(...args); return live.text ? { ...r, liveText: live.text } : r; } };
});

const CUSTOMER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VISIT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MIC = /Dictate into this box/;
let clipRequests;
let resolveClip;

function stubServer(availability) {
  vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
    if (String(url).includes("/availability")) return { ok: true, json: async () => availability };
    clipRequests.push(String(url));
    return new Promise((r) => { resolveClip = r; });
  }));
}

function Page({ children }) {
  usePublishIntelligenceBarPageData({ customer_id: CUSTOMER, appointment_id: VISIT });
  return children;
}

function Controlled({ onChange }) {
  const [value, setValue] = useState("Hello");
  return <textarea aria-label="notes" value={value} onChange={(e) => { onChange(e.target.value); setValue(e.target.value); }} />;
}

function Send() {
  const pending = useDictationPending();
  return <button type="button" disabled={pending}>Send</button>;
}

async function mount(children) {
  render(
    <IntelligenceBarPageDataProvider>
      <Page>{children}</Page>
      <FocusedBoxMic />
      <Send />
    </IntelligenceBarPageDataProvider>,
  );
  await act(async () => {});
}

const focusBox = (label = "notes") => act(() => { screen.getByLabelText(label).focus(); });

beforeEach(() => {
  live.text = "";
  forgetServerDictation();
  clipRequests = [];
  localStorage.setItem("waves_admin_token", "staff-jwt");
  window.MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
  vi.stubGlobal("alert", vi.fn());
  // jsdom has no layout: give every textarea a real-looking box.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect() {
    const big = this.tagName === "TEXTAREA";
    return { top: 100, left: 40, right: big ? 440 : 40, bottom: big ? 220 : 100, width: big ? 400 : 0, height: big ? 120 : 0, x: 40, y: 100, toJSON() {} };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.MediaRecorder;
});

describe("FocusedBoxMic", () => {
  it("draws nothing when the server says everyBox is off", async () => {
    stubServer({ available: true, everyBox: false });
    await mount(<textarea aria-label="notes" />);
    await focusBox();
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
  });

  it("draws nothing when server dictation itself is off", async () => {
    stubServer({ available: false, everyBox: true });
    await mount(<textarea aria-label="notes" />);
    await focusBox();
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
  });

  it("shows the mic on the focused eligible box and hides it when focus leaves", async () => {
    stubServer({ available: true, everyBox: true });
    await mount(<><textarea aria-label="notes" /><button type="button">Other</button></>);
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
    await focusBox();
    expect(await screen.findByRole("button", { name: MIC })).toBeInTheDocument();
    await act(async () => { screen.getByLabelText("notes").blur(); });
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
  });

  it.each([
    ["disabled", { disabled: true }],
    ["read-only", { readOnly: true }],
    ["own mic", { "data-own-mic": "true" }],
    ["no dictation", { "data-no-dictation": "true" }],
  ])("never shows on a %s box", async (_name, props) => {
    stubServer({ available: true, everyBox: true });
    await mount(<textarea aria-label="notes" {...props} />);
    await focusBox();
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
  });

  it("never shows on a single-line input", async () => {
    stubServer({ available: true, everyBox: true });
    await mount(<input aria-label="one line" />);
    await act(async () => { screen.getByLabelText("one line").focus(); });
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
  });

  it("keeps focus in the box on press, and puts the words at the caret of a controlled box", async () => {
    stubServer({ available: true, everyBox: true });
    const onChange = vi.fn();
    await mount(<Controlled onChange={onChange} />);
    const box = screen.getByLabelText("notes");
    await focusBox();
    box.setSelectionRange(5, 5);
    const mic = await screen.findByRole("button", { name: MIC });
    expect(fireEvent.mouseDown(mic)).toBe(false); // default prevented: the box keeps focus
    expect(document.activeElement).toBe(box);

    await act(async () => { fireEvent.click(mic); });
    const stop = await screen.findByRole("button", { name: "Stop dictation" });
    expect(screen.getByText("Send")).toBeDisabled();
    // Focus moves away mid-recording: the mic stays pinned for the stop tap.
    await act(async () => { box.blur(); });
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeInTheDocument();
    await act(async () => { fireEvent.click(stop); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Transcribing" })).toBeDisabled());
    expect(clipRequests[0]).toContain(`customer_id=${CUSTOMER}`);
    expect(clipRequests[0]).toContain(`service_id=${VISIT}`);

    await act(async () => { resolveClip({ ok: true, json: async () => ({ text: "world" }) }); });
    await waitFor(() => expect(box).toHaveValue("Hello world"));
    expect(onChange).toHaveBeenCalledWith("Hello world");
    await waitFor(() => expect(screen.getByText("Send")).toBeEnabled());
    expect(screen.queryByRole("button", { name: /Stop dictation|Transcribing/ })).toBeNull();
  });

  it("drops the words and says so when the box left the page", async () => {
    stubServer({ available: true, everyBox: true });
    function Host() {
      const [open, setOpen] = useState(true);
      return <>{open && <textarea aria-label="notes" defaultValue="Hello" />}<button type="button" onClick={() => setOpen(false)}>Close</button></>;
    }
    await mount(<Host />);
    await focusBox();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: MIC })); });
    const stop = await screen.findByRole("button", { name: "Stop dictation" });
    await act(async () => { fireEvent.click(stop); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Transcribing" })).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText("Close")); });
    await act(async () => { resolveClip({ ok: true, json: async () => ({ text: "lost words" }) }); });
    expect(await screen.findByRole("status")).toHaveTextContent(/closed before the words came back/);
    expect(screen.queryByLabelText("notes")).toBeNull();
    expect(document.body.textContent).not.toContain("lost words");
  });

  it("holds a Send button in the box's own dialog until the words land, but not Cancel", async () => {
    stubServer({ available: true, everyBox: true });
    const send = vi.fn();
    const cancel = vi.fn();
    await mount(
      <div role="dialog" aria-label="Follow up">
        <textarea aria-label="notes" defaultValue="Hello" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
        <button type="button" onClick={send}>Send follow-up</button>
        <button type="button" onClick={cancel}>Cancel</button>
        <button type="button" onClick={send}>Save and close</button>
      </div>,
    );
    await focusBox();
    screen.getByLabelText("notes").setSelectionRange(5, 5);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: MIC })); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Transcribing" })).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByText("Send follow-up")); });
    await act(async () => { fireEvent.click(screen.getByText("Save and close")); });
    expect(send).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(screen.getByLabelText("notes"), { key: "Enter", metaKey: true }); });
    expect(send).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(/wait for the words/);
    // Enter on a focused Cancel or on the mic is a click for the browser; the key guard leaves it alone.
    expect(fireEvent.keyDown(screen.getByText("Cancel"), { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Transcribing" }), { key: "Enter" })).toBe(true);
    await act(async () => { fireEvent.click(screen.getByText("Cancel")); });
    expect(cancel).toHaveBeenCalledTimes(1);

    await act(async () => { resolveClip({ ok: true, json: async () => ({ text: "world" }) }); });
    await waitFor(() => expect(screen.getByLabelText("notes")).toHaveValue("Hello world"));
    await act(async () => { fireEvent.click(screen.getByText("Send follow-up")); });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("draws the mic inside the box's own dialog, so a focus trap and aria-hidden background include it", async () => {
    stubServer({ available: true, everyBox: true });
    await mount(<div role="dialog" aria-label="Edit"><textarea aria-label="notes" /></div>);
    await focusBox();
    const mic = await screen.findByRole("button", { name: MIC });
    expect(screen.getByRole("dialog")).toContainElement(mic);
  });

  it("turning the gate off reaches an open session when the page comes back to the front", async () => {
    stubServer({ available: true, everyBox: true });
    await mount(<textarea aria-label="notes" />);
    await focusBox();
    expect(await screen.findByRole("button", { name: MIC })).toBeInTheDocument();
    await act(async () => { screen.getByLabelText("notes").blur(); });

    stubServer({ available: true, everyBox: false });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await focusBox();
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
  });

  it("holds Save in an editor portaled straight to body (no dialog role, no form)", async () => {
    stubServer({ available: true, everyBox: true });
    const save = vi.fn();
    // #admin-main exists but does not contain the editor, like the Dispatch visit editor.
    document.body.insertAdjacentHTML("beforeend", '<main id="admin-main"></main>');
    await mount(
      <>
        <textarea aria-label="notes" defaultValue="Hello" />
        <button type="button" onClick={save}>Save</button>
      </>,
    );
    await focusBox();
    screen.getByLabelText("notes").setSelectionRange(5, 5);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: MIC })); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Transcribing" })).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText("Save")); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { resolveClip({ ok: true, json: async () => ({ text: "world" }) }); });
    await waitFor(() => expect(screen.getByLabelText("notes")).toHaveValue("Hello world"));
    await act(async () => { fireEvent.click(screen.getByText("Save")); });
    expect(save).toHaveBeenCalledTimes(1);
    document.getElementById("admin-main")?.remove();
  });

  it("draws the mic inside the panel a modal traps (ui/Dialog), not its outer wrapper", async () => {
    stubServer({ available: true, everyBox: true });
    await mount(
      <div role="dialog" aria-modal="true">
        <div className="backdrop" />
        <div data-modal-panel="true" tabIndex={-1}><textarea aria-label="notes" /></div>
      </div>,
    );
    await focusBox();
    const mic = await screen.findByRole("button", { name: MIC });
    expect(mic.closest("[data-modal-panel]")).toBe(document.querySelector("[data-modal-panel]"));
  });

  it("box removed while RECORDING: the clip is abandoned (nothing uploaded), the hold is released and the notice shows", async () => {
    stubServer({ available: true, everyBox: true });
    const send = vi.fn();
    let closeBox;
    function Host() {
      const [open, setOpen] = useState(true);
      closeBox = () => setOpen(false);
      return (
        <div role="dialog" aria-label="Edit">
          {open && <textarea aria-label="notes" defaultValue="Hello" />}
          <button type="button" onClick={send}>Send message</button>
        </div>
      );
    }
    await mount(<Host />);
    await focusBox();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: MIC })); });
    await screen.findByRole("button", { name: "Stop dictation" });
    await act(async () => { closeBox(); });
    expect(await screen.findByRole("status")).toHaveTextContent(/closed before the words came back/);
    expect(screen.queryByRole("button", { name: /Stop dictation|Transcribing/ })).toBeNull();
    expect(clipRequests).toHaveLength(0);
    // The hold is gone: Send in the same dialog works at once.
    await act(async () => { fireEvent.click(screen.getByText("Send message")); });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("shows the live-words bubble beside the mic while recording, and none without liveText", async () => {
    stubServer({ available: true, everyBox: true });
    await mount(<textarea aria-label="notes" />);
    await focusBox();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: MIC })); });
    await screen.findByRole("button", { name: "Stop dictation" });
    expect(screen.queryByTestId("dictation-live-words")).toBeNull();
    live.text = "gate is on the left";
    await act(async () => { screen.getByLabelText("notes").dispatchEvent(new Event("input", { bubbles: true })); });
    // Re-render with the preview: any state change in the component does it.
    await act(async () => { screen.getByLabelText("notes").blur(); });
    expect(await screen.findByTestId("dictation-live-words")).toHaveTextContent("gate is on the left");
  });

  const anchorCount = () => document.querySelectorAll("[data-focused-box-mic-anchor]").length;

  it("keyboard: in a ui/Dialog the mic is the next Tab stop after its box, Shift+Tab returns, Tab goes on", async () => {
    stubServer({ available: true, everyBox: true });
    await mount(
      <Dialog open onClose={() => {}} aria-label="Cancel plan">
        <button type="button">First</button>
        <textarea aria-label="notes" />
        <button type="button">Last</button>
      </Dialog>,
    );
    const box = screen.getByLabelText("notes");
    await focusBox();
    const mic = await screen.findByRole("button", { name: MIC });
    expect(box.nextElementSibling).toBe(mic.parentElement); // right after the box, in DOM order
    expect(mic.parentElement.style.display).toBe("contents");

    await act(async () => { fireEvent.keyDown(box, { key: "Tab" }); });
    expect(document.activeElement).toBe(mic);
    // Focus moving from the box to the mic keeps the box (and the mic).
    expect(screen.getByRole("button", { name: MIC })).toBe(mic);

    await act(async () => { fireEvent.keyDown(mic, { key: "Tab", shiftKey: true }); });
    expect(document.activeElement).toBe(box);

    await act(async () => { fireEvent.keyDown(box, { key: "Tab" }); });
    expect(document.activeElement).toBe(mic);
    await act(async () => { fireEvent.keyDown(mic, { key: "Tab" }); });
    expect(document.activeElement).toBe(screen.getByText("Last"));
    // Focus left the box and the mic: both are gone, no stray stop is left.
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
    expect(anchorCount()).toBe(0);
  });

  it("leaves no container behind after focus moves to a non-box element, or after the box is removed", async () => {
    stubServer({ available: true, everyBox: true });
    let closeBox;
    function Host() {
      const [open, setOpen] = useState(true);
      closeBox = () => setOpen(false);
      return <>{open && <textarea aria-label="notes" />}<button type="button">Elsewhere</button></>;
    }
    await mount(<Host />);
    await focusBox();
    await screen.findByRole("button", { name: MIC });
    expect(anchorCount()).toBe(1);
    await act(async () => { screen.getByText("Elsewhere").focus(); });
    expect(anchorCount()).toBe(0);
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();

    await focusBox();
    await screen.findByRole("button", { name: MIC });
    expect(anchorCount()).toBe(1);
    await act(async () => { closeBox(); });
    await waitFor(() => expect(anchorCount()).toBe(0));
    expect(screen.queryByRole("button", { name: MIC })).toBeNull();
  });
});
