// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FocusedBoxMic from "./FocusedBoxMic";
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
      return <>{open && <textarea aria-label="notes" defaultValue="Hello" />}<button type="button" onClick={() => setOpen(false)}>Close box</button></>;
    }
    await mount(<Host />);
    await focusBox();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: MIC })); });
    const stop = await screen.findByRole("button", { name: "Stop dictation" });
    await act(async () => { fireEvent.click(stop); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Transcribing" })).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText("Close box")); });
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
        <textarea aria-label="notes" defaultValue="Hello" />
        <button type="button" onClick={send}>Send follow-up</button>
        <button type="button" onClick={cancel}>Cancel</button>
      </div>,
    );
    await focusBox();
    screen.getByLabelText("notes").setSelectionRange(5, 5);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: MIC })); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Transcribing" })).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByText("Send follow-up")); });
    expect(send).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(/wait for the words/);
    await act(async () => { fireEvent.click(screen.getByText("Cancel")); });
    expect(cancel).toHaveBeenCalledTimes(1);

    await act(async () => { resolveClip({ ok: true, json: async () => ({ text: "world" }) }); });
    await waitFor(() => expect(screen.getByLabelText("notes")).toHaveValue("Hello world"));
    await act(async () => { fireEvent.click(screen.getByText("Send follow-up")); });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
