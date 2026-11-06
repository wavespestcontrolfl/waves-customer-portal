// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GreetingNameNote, { useGreetingNameCheck } from "./GreetingNameCheck";
import { adminFetch } from "../../utils/admin-fetch";

vi.mock("../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));

const CUSTOMER = "11111111-1111-4111-8111-111111111111";

function Harness({ customerId = CUSTOMER, initial = "" }) {
  const [text, setText] = useState(initial);
  const check = useGreetingNameCheck({ customerId, text, setText });
  return (
    <div>
      <textarea aria-label="body" value={text} onChange={(e) => setText(e.target.value)} />
      <GreetingNameNote check={check} />
      <button type="button">Send</button>
    </div>
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const type = (value) => fireEvent.change(screen.getByLabelText("body"), { target: { value } });
const settle = async (ms = 450) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const fixFor = (text, spelled = "Sara", heard = "Sarah") => ({ fixes: [{ heard, spelled }], text: text.replace(heard, spelled) });

describe("greeting name check", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    adminFetch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the note after 400 ms and the fix button puts the record's spelling in the text", async () => {
    adminFetch.mockImplementation(async (_path, opts) => fixFor(JSON.parse(opts.body).text));
    render(<Harness />);
    type("Hi Sarah, see you Friday.");
    await settle(300);
    expect(adminFetch).not.toHaveBeenCalled();
    await settle(150);
    expect(adminFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = adminFetch.mock.calls[0];
    expect(path).toBe("/admin/communications/name-check");
    expect(JSON.parse(opts.body)).toEqual({ customer_id: CUSTOMER, text: "Hi Sarah, see you Friday." });
    expect(screen.getByText("Record says Sara")).toBeInTheDocument();
    // Send is untouched by the note.
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Change to Sara" }));
    expect(screen.getByLabelText("body")).toHaveValue("Hi Sara, see you Friday.");
    expect(screen.queryByTestId("greeting-name-note")).not.toBeInTheDocument();
  });

  it("changes nothing until the button is tapped", async () => {
    adminFetch.mockImplementation(async (_path, opts) => fixFor(JSON.parse(opts.body).text));
    render(<Harness />);
    type("Hi Sarah,");
    await settle();
    expect(screen.getByLabelText("body")).toHaveValue("Hi Sarah,");
  });

  it("hides the note when a later check finds nothing", async () => {
    adminFetch.mockImplementation(async (_path, opts) => {
      const body = JSON.parse(opts.body).text;
      return body.includes("Sarah") ? fixFor(body) : { fixes: [], text: body };
    });
    render(<Harness />);
    type("Hi Sarah,");
    await settle();
    expect(screen.getByTestId("greeting-name-note")).toBeInTheDocument();
    type("Hi there,");
    await settle();
    expect(screen.queryByTestId("greeting-name-note")).not.toBeInTheDocument();
  });

  it("ignores a stale check that answers after the text changed", async () => {
    const first = deferred();
    adminFetch.mockImplementationOnce(async () => first.promise);
    adminFetch.mockImplementation(async (_path, opts) => ({ fixes: [], text: JSON.parse(opts.body).text }));
    render(<Harness />);
    type("Hi Sarah,");
    await settle();
    expect(adminFetch.mock.calls[0][1].signal.aborted).toBe(false);
    type("Hi there,");
    expect(adminFetch.mock.calls[0][1].signal.aborted).toBe(true);
    await settle();
    await act(async () => { first.resolve(fixFor("Hi Sarah,")); });
    expect(screen.queryByTestId("greeting-name-note")).not.toBeInTheDocument();
  });

  it("checks again instead of replacing text that moved on since the check", async () => {
    adminFetch.mockImplementation(async (_path, opts) => fixFor(JSON.parse(opts.body).text));
    render(<Harness />);
    type("Hi Sarah,");
    await settle();
    type("Hi Sarah, also bring the form.");
    fireEvent.click(screen.getByRole("button", { name: "Change to Sara" }));
    expect(screen.getByLabelText("body")).toHaveValue("Hi Sarah, also bring the form.");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(JSON.parse(adminFetch.mock.calls.at(-1)[1].body).text).toBe("Hi Sarah, also bring the form.");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Change to Sara" }));
    expect(screen.getByLabelText("body")).toHaveValue("Hi Sara, also bring the form.");
  });

  it("does not check without a customer, for blank text, or for text over 2000 characters", async () => {
    adminFetch.mockResolvedValue({ fixes: [], text: "" });
    const { rerender } = render(<Harness customerId={null} />);
    type("Hi Sarah,");
    await settle();
    rerender(<Harness customerId={CUSTOMER} />);
    type("   ");
    await settle();
    type(`Hi Sarah, ${"a".repeat(2000)}`);
    await settle();
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("stays quiet when the check fails", async () => {
    adminFetch.mockRejectedValue(new Error("down"));
    render(<Harness />);
    type("Hi Sarah,");
    await settle();
    expect(screen.queryByTestId("greeting-name-note")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});
