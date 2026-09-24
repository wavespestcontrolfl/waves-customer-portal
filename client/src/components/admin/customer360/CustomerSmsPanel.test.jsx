// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerSmsPanel from "./CustomerSmsPanel";
import { adminFetch } from "../../../utils/admin-fetch";
import { UNREAD_CHANGED_EVENT } from "../../../hooks/useUnreadConversations";

vi.mock("../../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));
vi.mock("../../../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../AuthenticatedCallAudio", () => ({ default: () => null }));

const render = (ui, options = {}) => rtlRender(ui, { wrapper: MemoryRouter, ...options });

const CUSTOMER_A = { id: "cust-a", firstName: "Avery", lastName: "Sample", phone: "+19415550101" };
const CUSTOMER_B = { id: "cust-b", firstName: "Blair", lastName: "Sample", phone: "+19415550102" };

function thread() {
  return {
    comms: [
      { id: "m1", channel: "sms", direction: "inbound", body: "Can you come Friday?", isRead: false, createdAt: "2026-09-05T14:00:00Z" },
      { id: "m2", channel: "sms", direction: "inbound", body: "Thanks!", isRead: true, createdAt: "2026-09-01T14:00:00Z" },
      { id: "m3", channel: "sms", direction: "outbound", body: "On it.", deliveryStatus: "queued", isRead: true, createdAt: "2026-09-05T14:05:00Z" },
    ],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("CustomerSmsPanel", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.setItem("waves_admin_user", JSON.stringify({ id: "staff-a", role: "admin" }));
    adminFetch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("loads the thread, marks only the unread inbound texts read after a successful load, and tells the badge", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.startsWith("/admin/customers/cust-a/comms")) return thread();
      if (path === "/admin/communications/messages/read") return { success: true, updated: 1 };
      throw new Error(`unexpected ${path}`);
    });
    const onEvent = vi.fn();
    window.addEventListener(UNREAD_CHANGED_EVENT, onEvent);
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} />);
    expect(await screen.findByText("Can you come Friday?")).toBeInTheDocument();
    // Provider "queued" is not delivery.
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
    await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    const readCall = adminFetch.mock.calls.find(([p]) => p === "/admin/communications/messages/read");
    expect(JSON.parse(readCall[1].body)).toEqual({ messageIds: ["m1"] });
    window.removeEventListener(UNREAD_CHANGED_EVENT, onEvent);
  });

  it("never marks anything read when the thread fails to load, and offers a retry", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.startsWith("/admin/customers/cust-a/comms")) throw new Error("Boom");
      throw new Error(`unexpected ${path}`);
    });
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Boom");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(adminFetch.mock.calls.some(([p]) => p === "/admin/communications/messages/read")).toBe(false);
  });

  it("keeps a draft per customer across switches", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    const { rerender } = render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} />);
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    fireEvent.change(box, { target: { value: "draft for Avery" } });
    rerender(<CustomerSmsPanel customer={CUSTOMER_B} open onClose={vi.fn()} />);
    expect(await screen.findByLabelText(/Message to Blair Sample/)).toHaveValue("");
    rerender(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} />);
    expect(await screen.findByLabelText(/Message to Avery Sample/)).toHaveValue("draft for Avery");
  });

  // Pre-push Codex P2: initialDraft only seeds an EMPTY draft — an existing
  // stored draft silently wins and a caller's text (e.g. "Send consultation
  // link") is lost. appendDraft joins onto whatever draft already exists
  // instead, matching how the Communications composer's own Insert Link
  // actions add a clause to the current body rather than dropping it.
  it("appendDraft joins onto an existing draft instead of being silently dropped by it", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    sessionStorage.setItem("c360:sms-draft:staff-a:cust-a", "already typed this");
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={"Pick a time: https://waves.link/l/abc\n\n"} />);
    expect(await screen.findByLabelText(/Message to Avery Sample/))
      .toHaveValue("already typed this\n\nPick a time: https://waves.link/l/abc\n\n");
  });

  it("appendDraft with no existing draft becomes the whole body (never dropped for an empty draft either)", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={"Pick a time: https://waves.link/l/abc\n\n"} />);
    expect(await screen.findByLabelText(/Message to Avery Sample/))
      .toHaveValue("Pick a time: https://waves.link/l/abc\n\n");
  });

  // Pre-push Codex P2: a stored draft that already carries an earlier
  // consultation insert (the operator collapsed/re-expanded the lead row,
  // or clicked Send consultation link twice) must not get a SECOND copy —
  // each mint is a fresh short code, so the new URL never literally
  // matches the old one; the stale line (remembered verbatim, alongside
  // the draft — pre-push Codex P1) is replaced in place instead of
  // appended alongside it.
  it("appendDraft REPLACES an earlier consultation clause already in the stored draft, instead of appending a second one", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    sessionStorage.setItem(
      "c360:sms-draft:staff-a:cust-a",
      "Hi Jamie, it's Waves. Pick a time: https://waves.link/l/old111\n\nReply STOP to opt out.",
    );
    // The exact URL line an earlier insert remembered — written alongside
    // the draft by the same code path in real sessions.
    sessionStorage.setItem("c360:sms-consult-line:staff-a:cust-a", "Hi Jamie, it's Waves. Pick a time: https://waves.link/l/old111");
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={"Hi Jamie, it's Waves. Pick a time: https://waves.link/l/new222\n\nReply STOP to opt out."} />);
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    expect(box.value).not.toContain("old111");
    expect(box.value).toContain("new222");
    expect((box.value.match(/waves\.link/g) || []).length).toBe(1);
  });

  it("appendDraft leaves unrelated typed text alone while replacing only the stale consultation line", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    sessionStorage.setItem(
      "c360:sms-draft:staff-a:cust-a",
      "Also, we'll need someone home.\n\nPick a time: https://waves.link/l/old111\n\n",
    );
    sessionStorage.setItem("c360:sms-consult-line:staff-a:cust-a", "Pick a time: https://waves.link/l/old111");
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={"Pick a time: https://waves.link/l/new222\n\n"} />);
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    expect(box.value).toContain("Also, we'll need someone home.");
    expect(box.value).not.toContain("old111");
    expect(box.value).toContain("new222");
  });

  // Pre-push Codex P1: every short link (pay, review, estimate,
  // consultation) shares the same short-link host — combineAppendedDraft
  // used to drop ANY line on that host, silently deleting a pasted
  // non-consultation link. With nothing remembered yet for this identity
  // (a fresh session), the fallback requires the consultation WORDING too,
  // not just the shared host.
  it("a draft with a non-consultation short link is preserved when a consultation link is inserted", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    sessionStorage.setItem(
      "c360:sms-draft:staff-a:cust-a",
      "Here's your invoice: https://waves.link/l/pay1",
    );
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={"Pick a time for us to stop by for a free consultation: https://waves.link/l/cons1\n\nReply STOP to opt out."} />);
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    expect(box.value).toContain("Here's your invoice: https://waves.link/l/pay1");
    expect(box.value).toContain("free consultation: https://waves.link/l/cons1");
  });

  // Same fallback, the other half: a stale consultation clause from BEFORE
  // this remember-the-line fix shipped (draft persisted, no remembered
  // line yet) is still recognized and replaced — by its wording, not just
  // its host — rather than left to duplicate forever.
  it("a stale consultation clause with no remembered line yet is still replaced, by template wording", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    sessionStorage.setItem(
      "c360:sms-draft:staff-a:cust-a",
      "Pick a time for us to stop by for a free consultation: https://waves.link/l/old111\n\nReply STOP to opt out.",
    );
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={"Pick a time for us to stop by for a free consultation: https://waves.link/l/new222\n\nReply STOP to opt out."} />);
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    expect(box.value).not.toContain("old111");
    expect(box.value).toContain("new222");
    expect((box.value.match(/waves\.link/g) || []).length).toBe(1);
  });

  // Codex #4709 P1: StrictMode runs a setState updater twice with the same
  // previous draft. The remembered line is read before the update, so both
  // runs strip the OLD consultation line and the replacement is persisted.
  it("under StrictMode, re-inserting a consultation link replaces the previous one (draft updater stays pure)", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    const first = "Hi Avery, it's Waves. Pick a time: https://waves.link/l/old111\n\nReply STOP to opt out.";
    const second = "Hi Avery, it's Waves. Pick a time: https://waves.link/l/new222\n\nReply STOP to opt out.";
    const { rerender } = render(
      <React.StrictMode><CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={first} /></React.StrictMode>,
    );
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    await waitFor(() => expect(box.value).toContain("old111"));
    rerender(<React.StrictMode><CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={second} /></React.StrictMode>);
    await waitFor(() => expect(box.value).toContain("new222"));
    expect(box.value).not.toContain("old111");
    await waitFor(() => expect(sessionStorage.getItem("c360:sms-draft:staff-a:cust-a")).toContain("new222"));
    expect(sessionStorage.getItem("c360:sms-draft:staff-a:cust-a")).not.toContain("old111");
  });

  // Codex #4709 P1: the template renderer strips https://, so the real line
  // is scheme-free. Re-inserting must still replace the previous invite.
  it("re-inserting a scheme-free consultation line (the renderer's real output) replaces the previous one", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) return { comms: [] };
      return {};
    });
    const first = "Hi Avery, it's Waves. Pick a time for a free consultation: wavespest.co/l/old111\n\nReply STOP to opt out.";
    const second = "Hi Avery, it's Waves. Pick a time for a free consultation: wavespest.co/l/new222\n\nReply STOP to opt out.";
    const { rerender } = render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={first} />);
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    await waitFor(() => expect(box.value).toContain("old111"));
    rerender(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} appendDraft={second} />);
    await waitFor(() => expect(box.value).toContain("new222"));
    expect(box.value).not.toContain("old111");
    expect((box.value.match(/wavespest\.co\/l\//g) || []).length).toBe(1);
  });

  it("sends once per click through the canonical route, pinned to the customer, and keeps the draft on failure", async () => {
    const send = deferred();
    adminFetch.mockImplementation(async (path, options = {}) => {
      if (path.includes("/comms")) return { comms: [] };
      if (path === "/admin/communications/sms") return send.promise;
      return {};
    });
    const onSent = vi.fn();
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} onSent={onSent} />);
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    fireEvent.change(box, { target: { value: "Hello there" } });
    const button = screen.getByRole("button", { name: "Send text" });
    fireEvent.click(button);
    fireEvent.click(button);
    const sends = () => adminFetch.mock.calls.filter(([p]) => p === "/admin/communications/sms");
    expect(sends()).toHaveLength(1);
    expect(JSON.parse(sends()[0][1].body)).toEqual({ to: "+19415550101", body: "Hello there", customerId: "cust-a", messageType: "manual" });
    await act(async () => { send.reject(new Error("Recipient opted out")); });
    expect(await screen.findByText("Recipient opted out")).toBeInTheDocument();
    expect(screen.getByLabelText(/Message to Avery Sample/)).toHaveValue("Hello there");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("clears the draft and reloads the thread after a successful send", async () => {
    let loads = 0;
    adminFetch.mockImplementation(async (path) => {
      if (path.includes("/comms")) { loads += 1; return { comms: [] }; }
      if (path === "/admin/communications/sms") return { sent: true, providerMessageId: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
      return {};
    });
    const onSent = vi.fn();
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} onSent={onSent} />);
    const box = await screen.findByLabelText(/Message to Avery Sample/);
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(loads).toBe(2));
    expect(screen.getByLabelText(/Message to Avery Sample/)).toHaveValue("");
    expect(sessionStorage.getItem("c360:sms-draft:staff-a:cust-a")).toBeNull();
  });

  it("links to the full conversation in the inbox and closes on Escape", async () => {
    adminFetch.mockImplementation(async (path) => (path.includes("/comms") ? thread() : {}));
    const onClose = vi.fn();
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={onClose} />);
    await screen.findByText("Can you come Friday?");
    expect(screen.getByRole("link", { name: "Open full conversation" })).toHaveAttribute("href", "/admin/communications?thread=cust-a");
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
  it("isolates drafts between staff accounts and uses exact phone history for unlinked leads", async () => {
    adminFetch.mockResolvedValue({ messages: [] });
    const lead = { firstName: "QA lead", phone: "+19415550103" };
    const { unmount } = render(<CustomerSmsPanel customer={lead} open onClose={vi.fn()} />);
    const box = await screen.findByLabelText("Message to QA lead");
    fireEvent.change(box, { target: { value: "private staff draft" } });
    expect(adminFetch).toHaveBeenCalledWith("/admin/communications/log?phone=%2B19415550103&limit=100");
    unmount();
    localStorage.setItem("waves_admin_user", JSON.stringify({ id: "staff-b" }));
    render(<CustomerSmsPanel customer={lead} open onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Message to QA lead")).toHaveValue("");
  });

  it("retains the draft when the canonical transport suppresses a send", async () => {
    adminFetch.mockImplementation(async (path) => path.endsWith("/sms")
      ? { sent: true, providerMessageId: "GATE_BLOCKED", reason: "Messaging disabled" }
      : { comms: [] });
    const onSent = vi.fn();
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={vi.fn()} onSent={onSent} />);
    fireEvent.change(await screen.findByLabelText(/Message to Avery/), { target: { value: "Retain this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    expect(await screen.findByText("Messaging disabled")).toBeInTheDocument();
    expect(screen.getByLabelText(/Message to Avery/)).toHaveValue("Retain this");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("keeps international drafts separate from a NANP contact with the same suffix", async () => {
    adminFetch.mockResolvedValue({ messages: [] });
    const international = { firstName: "International", phone: "+449415550103" };
    const domestic = { firstName: "Domestic", phone: "+19415550103" };
    const { rerender } = render(<CustomerSmsPanel customer={international} open onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Message to International"), { target: { value: "International draft" } });
    rerender(<CustomerSmsPanel customer={domestic} open onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Message to Domestic")).toHaveValue("");
    rerender(<CustomerSmsPanel customer={international} open onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Message to International")).toHaveValue("International draft");
  });

  it("uses the lead outreach route and retains its provider outcome boundary", async () => {
    adminFetch.mockImplementation(async (path) => path.endsWith("/send-sms")
      ? { sent: true, providerMessageId: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } : { messages: [] });
    const onSent = vi.fn();
    render(<CustomerSmsPanel customer={{ firstName: "QA lead", phone: "+19415550103" }} leadId="lead-qa" open onClose={vi.fn()} onSent={onSent} />);
    fireEvent.change(await screen.findByLabelText("Message to QA lead"), { target: { value: "Hello lead" } });
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    const sent = adminFetch.mock.calls.find(([path]) => path.endsWith("/send-sms"));
    expect(sent[0]).toBe("/admin/leads/lead-qa/send-sms");
    expect(JSON.parse(sent[1].body)).toEqual({ message: "Hello lead", to: "+19415550103" });
    expect(adminFetch.mock.calls.some(([path]) => path === "/admin/communications/sms")).toBe(false);
  });

  it("keeps the panel mounted through a pending send across close, Escape, backdrop and navigation", async () => {
    const pending = deferred();
    adminFetch.mockImplementation((path) => path.endsWith("/sms") ? pending.promise : Promise.resolve({ comms: [] }));
    const onClose = vi.fn();
    const onSent = vi.fn();
    render(<CustomerSmsPanel customer={CUSTOMER_A} open onClose={onClose} onSent={onSent} />);
    fireEvent.change(await screen.findByLabelText(/Message to Avery/), { target: { value: "One request only" } });
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    const close = screen.getByRole("button", { name: "Close messages" });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    fireEvent.click(document.querySelector('div[aria-hidden="true"]'));
    expect(fireEvent.click(screen.getByRole("link", { name: "Open full conversation" }))).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(adminFetch.mock.calls.filter(([path]) => path.endsWith("/sms"))).toHaveLength(1);
    await act(async () => pending.resolve({ sent: true, providerMessageId: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(close).not.toBeDisabled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

});
