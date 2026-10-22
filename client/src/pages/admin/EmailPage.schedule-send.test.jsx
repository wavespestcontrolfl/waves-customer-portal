// @vitest-environment jsdom
// Gmail-style Schedule send (GATE_EMAIL_SEND_LATER): the arrow beside Send
// queues the email with an Eastern wall-clock time and its plain text, the
// Scheduled tab lists it, and Cancel send brings it back as a draft — never
// over a draft already in progress.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmailPage from "./EmailPage";
import { clearEmailDrafts } from "../../lib/emailDrafts";
import { schedulePresets } from "./email/scheduleSend";
import { LIST_RETRY_MS } from "./email/useScheduledEmails";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
const mail = { id: "mail-a", gmail_thread_id: "thread-a", from_address: "a@example.invalid", subject: "Fixture", body_text: "Body", is_read: true, received_at: new Date().toISOString() };
const response = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
let scheduledRows;
let enabled;
const posts = (suffix) => fetch.mock.calls.filter(([url, options = {}]) => options.method === "POST" && new URL(url, "https://fixture.invalid").pathname.endsWith(suffix));

function mount() {
  return render(<BrowserRouter><Routes><Route path="/admin" element={<Outlet context={{ user: { id: "fixture-schedule-owner", role: "admin" } }} />}>
    <Route path="communications" element={<EmailPage active navigation={{ title: "Communications", sections: [] }} />} />
  </Route></Routes></BrowserRouter>);
}

beforeEach(() => {
  clearEmailDrafts(); sessionStorage.clear(); localStorage.clear();
  localStorage.setItem("waves_admin_token", "fixture-token");
  window.history.replaceState({}, "", "/admin/communications#tab=email");
  enabled = true;
  scheduledRows = [];
  vi.stubGlobal("fetch", vi.fn((input, options = {}) => {
    const url = new URL(input, "https://fixture.invalid");
    const path = url.pathname;
    if (path.endsWith("/oauth/status")) return response({ connected: true });
    if (path.endsWith("/inbox")) return response({ emails: [mail], total: 1 });
    if (path.endsWith("/stats")) return response({ total: 1, unread: 0, today: 1, starred: 0, vendor: 0 });
    if (path.endsWith("/daily-digest")) return response({ total_received: 0 });
    if (path.endsWith("/customers")) return response({ customers: [] });
    if (path.endsWith("/email/scheduled")) return response({ enabled, emails: scheduledRows });
    if (path.endsWith("/email/schedule")) {
      const body = JSON.parse(options.body);
      scheduledRows = [{ id: "queued-1", to: body.to, subject: body.subject, draftText: body.draftText, sendAt: "2026-10-23T13:00:00.000Z", status: "scheduled" }];
      return response({ success: true, scheduled: scheduledRows[0] });
    }
    if (path.endsWith("/queued-1/restored")) return response({ success: true });
    if (path.endsWith("/queued-1/cancel")) {
      const draft = { ...scheduledRows[0], status: "cancelled" };
      scheduledRows = [];
      return response({ success: true, draft });
    }
    throw new Error(`Unmatched fixture request ${options.method || "GET"} ${path}`);
  }));
});
afterEach(() => { cleanup(); clearEmailDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function writeEmail() {
  fireEvent.click(await screen.findByRole("button", { name: "New email" }));
  fireEvent.change(screen.getByLabelText(/^To/), { target: { value: "customer@example.invalid" } });
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Guide" } });
  fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Line one\n<b>two</b>" } });
}

describe("Email schedule send", () => {
  it("hides the arrow and the Scheduled tab while the gate is off", async () => {
    enabled = false;
    mount();
    await writeEmail();
    expect(screen.queryByRole("button", { name: "Schedule send options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Scheduled/ })).not.toBeInTheDocument();
  });

  it("queues the email for tomorrow morning with its plain text and an Eastern time", async () => {
    mount();
    await writeEmail();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    await waitFor(() => expect(posts("/email/schedule")).toHaveLength(1));
    const body = JSON.parse(posts("/email/schedule")[0][1].body);
    expect(body).toMatchObject({ to: "customer@example.invalid", subject: "Guide", draftText: "Line one\n<b>two</b>", sendAt: schedulePresets()[0].sendAt });
    expect(body.body).toBe("Line one<br>&lt;b&gt;two&lt;/b&gt;");
    expect(body.clientKey).toMatch(/^[\w-]{8,64}$/);
    expect((await screen.findAllByText(/^Scheduled for .*Find it under Scheduled\.$/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog", { name: "New email" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Scheduled (1)" })).toBeInTheDocument();
  });

  it.each(["network", "unreadable"])("a retry after a lost answer (%s) reuses the same client key", async (mode) => {
    let failNext = true;
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => {
      if (String(input).endsWith("/email/schedule") && failNext) {
        failNext = false;
        return mode === "network" ? Promise.reject(new TypeError("network"))
          : Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("truncated"); } });
      }
      return base(input, options);
    });
    mount();
    await writeEmail();
    const pickTomorrow = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
      fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    };
    await pickTomorrow();
    expect((await screen.findAllByText(/Look under Scheduled before you schedule or send it again/)).length).toBeGreaterThan(0);
    await pickTomorrow();
    await waitFor(() => expect(posts("/email/schedule")).toHaveLength(2));
    const [first, second] = posts("/email/schedule").map(([, options]) => JSON.parse(options.body).clientKey);
    expect(second).toBe(first);
  });

  it.each([
    ["a gate-off answer", { enabled: false, error: "Schedule send is off." }, 404],
    ["a sign-in failure", { error: "Session expired. Sign in again." }, 401],
    ["a rate limit", { error: "Too many requests. Try again shortly." }, 429],
  ])("keeps the client key through %s, so a later retry finds the first row", async (_label, refusal, status) => {
    let calls = 0;
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => {
      if (String(input).endsWith("/email/schedule")) {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError("network"));
        if (calls === 2) return response(refusal, status);
      }
      return base(input, options);
    });
    mount();
    await writeEmail();
    const pickTomorrow = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
      fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    };
    await pickTomorrow();
    expect((await screen.findAllByText(/Look under Scheduled before you schedule or send it again/)).length).toBeGreaterThan(0);
    await pickTomorrow();
    expect((await screen.findAllByText(refusal.error)).length).toBeGreaterThan(0);
    await pickTomorrow();
    await waitFor(() => expect(posts("/email/schedule")).toHaveLength(3));
    const keys = posts("/email/schedule").map(([, options]) => JSON.parse(options.body).clientKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("after a lost answer, plain Send waits until the operator checked Scheduled", async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/email/schedule")
      ? Promise.reject(new TypeError("network")) : base(input, options)));
    mount();
    await writeEmail();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    expect(await screen.findByText(/A schedule request for this email was not confirmed/)).toBeInTheDocument();
    const send = () => screen.getAllByRole("button", { name: "Send", exact: true }).at(-1);
    expect(send()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "I checked: it is in neither" }));
    await waitFor(() => expect(send()).not.toBeDisabled());
    expect(screen.queryByText(/A schedule request for this email was not confirmed/)).not.toBeInTheDocument();
  });

  it("after a lost answer, a changed email waits until the operator checked Scheduled", async () => {
    let calls = 0;
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => {
      if (String(input).endsWith("/email/schedule") && (calls += 1) === 1) return Promise.reject(new TypeError("network"));
      return base(input, options);
    });
    mount();
    await writeEmail();
    const pickTomorrow = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
      fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    };
    await pickTomorrow();
    expect(await screen.findByText(/A schedule request for this email was not confirmed/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Changed text" } });
    await pickTomorrow();
    expect((await screen.findAllByText(/An earlier schedule request for this email was not confirmed/)).length).toBeGreaterThan(0);
    expect(posts("/email/schedule")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "I checked: it is in neither" }));
    await pickTomorrow();
    await waitFor(() => expect(posts("/email/schedule")).toHaveLength(2));
    const [first, second] = posts("/email/schedule").map(([, options]) => JSON.parse(options.body).clientKey);
    expect(second).not.toBe(first);
  });

  it("leaving the page while a schedule request runs keeps plain Send blocked on return", async () => {
    let finish;
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/email/schedule")
      ? new Promise((resolve) => { finish = () => resolve(base(input, options)); }) : base(input, options)));
    const view = mount();
    await writeEmail();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.unmount();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    const send = () => screen.getAllByRole("button", { name: "Send", exact: true }).at(-1);
    expect(send()).toBeDisabled();
    finish();
    await waitFor(() => expect(posts("/email/schedule")).toHaveLength(1));
  });

  it("drops the key after a refusal the schedule route made past its key lookup", async () => {
    let calls = 0;
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => {
      if (String(input).endsWith("/email/schedule")) {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError("network"));
        if (calls === 2) return response({ error: "Pick a time at least a minute from now.", keyChecked: true }, 400);
      }
      return base(input, options);
    });
    mount();
    await writeEmail();
    const pickTomorrow = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
      fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    };
    await pickTomorrow();
    expect((await screen.findAllByText(/Look under Scheduled before you schedule or send it again/)).length).toBeGreaterThan(0);
    await pickTomorrow();
    expect((await screen.findAllByText("Pick a time at least a minute from now.")).length).toBeGreaterThan(0);
    await pickTomorrow();
    await waitFor(() => expect(posts("/email/schedule")).toHaveLength(3));
    const keys = posts("/email/schedule").map(([, options]) => JSON.parse(options.body).clientKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("never re-queues by itself when a retry finds the email cancelled; after I checked, a fresh key", async () => {
    let first = true;
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => {
      if (String(input).endsWith("/email/schedule") && first) {
        first = false;
        return response({ success: true, scheduled: { id: "old", status: "cancelled" } });
      }
      return base(input, options);
    });
    mount();
    await writeEmail();
    const pickTomorrow = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
      fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    };
    await pickTomorrow();
    expect((await screen.findAllByText(/This email was cancelled after an earlier request/)).length).toBeGreaterThan(0);
    expect(posts("/email/schedule")).toHaveLength(1);
    expect(screen.getByLabelText(/^Message/)).toHaveValue("Line one\n<b>two</b>");
    // Its text may be a draft in another tab: plain Send waits for the check.
    expect(screen.getAllByRole("button", { name: "Send", exact: true }).at(-1)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "I checked: it is in neither" }));
    await pickTomorrow();
    await waitFor(() => expect(posts("/email/schedule")).toHaveLength(2));
    const [a, b] = posts("/email/schedule").map(([, options]) => JSON.parse(options.body).clientKey);
    expect(b).not.toBe(a);
  });

  it("retries a failed Scheduled list by itself, so the tab comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let failList = true;
      const base = fetch.getMockImplementation();
      fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/email/scheduled") && failList
        ? response({ error: "down" }, 500) : base(input, options)));
      mount();
      await screen.findByRole("button", { name: "Inbox" });
      await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/email/scheduled"))).toBe(true));
      expect(screen.queryByRole("button", { name: /^Scheduled/ })).not.toBeInTheDocument();
      failList = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(LIST_RETRY_MS + 100); });
      expect(await screen.findByRole("button", { name: /^Scheduled/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a retry that returns a row the sender already refused keeps the draft and says so", async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/email/schedule")
      ? response({ success: true, scheduled: { id: "old", status: "failed" } }) : base(input, options)));
    mount();
    await writeEmail();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    expect((await screen.findAllByText("Gmail refused this email. Your draft is still here.")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/^Message/)).toHaveValue("Line one\n<b>two</b>");
    expect(screen.queryByText(/^Scheduled for /)).not.toBeInTheDocument();
  });

  it("a retry that returns an email that may have gone out keeps plain Send blocked", async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/email/schedule")
      ? response({ success: true, scheduled: { id: "old", status: "outcome_unknown" } }) : base(input, options)));
    mount();
    await writeEmail();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    expect((await screen.findAllByText(/This email may have gone out/)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Send", exact: true }).at(-1)).toBeDisabled();
    expect(screen.getByRole("button", { name: "I checked: it is in neither" })).toBeInTheDocument();
  });

  it("a retry that finds a cancelled email Gmail may have sent keeps plain Send blocked", async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/email/schedule")
      ? response({ success: true, scheduled: { id: "old", status: "cancelled", mayHaveSent: true } }) : base(input, options)));
    mount();
    await writeEmail();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    expect((await screen.findAllByText(/This email was cancelled after an earlier request/)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Send", exact: true }).at(-1)).toBeDisabled();
  });

  it("a retry that returns an email already sent says it went out, not Scheduled", async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/email/schedule")
      ? response({ success: true, scheduled: { id: "old", status: "sent" } }) : base(input, options)));
    mount();
    await writeEmail();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    expect((await screen.findAllByText("This email already went out. It is in the Gmail Sent folder.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Scheduled for /)).not.toBeInTheDocument();
  });

  it("an older list answer that arrives last does not replace the newer one", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "scheduled" }];
    const base = fetch.getMockImplementation();
    const held = [];
    let hold = false;
    fetch.mockImplementation((input, options = {}) => {
      if (hold && String(input).endsWith("/email/scheduled") && !held.length) {
        const stale = { enabled: true, emails: scheduledRows };
        return new Promise((resolve) => held.push(() => resolve({ ok: true, status: 200, json: async () => stale })));
      }
      return base(input, options);
    });
    mount();
    expect(await screen.findByRole("button", { name: "Scheduled (1)" })).toBeInTheDocument();
    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Scheduled (1)" }));
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    expect(await screen.findByText("Cancelled. The email is open as a draft.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Scheduled" })).toBeInTheDocument());
    held[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("button", { name: "Scheduled" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scheduled (1)" })).not.toBeInTheDocument();
  });

  it("Cancel send brings the email back into the composer", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "scheduled" }];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    expect(await screen.findByText("Cancelled. The email is open as a draft.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Message/)).toHaveValue("Saved text");
    expect(screen.getByLabelText(/^To/)).toHaveValue("customer@example.invalid");
    await waitFor(() => expect(posts("/queued-1/restored")).toHaveLength(1));
  });

  it("an unconfirmed restored mark keeps the row hidden and is sent again on the next reload", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "scheduled" }];
    const base = fetch.getMockImplementation();
    let markFails = true;
    fetch.mockImplementation((input, options = {}) => {
      if (String(input).endsWith("/queued-1/cancel")) {
        const draft = { ...scheduledRows[0], status: "cancelled" };
        scheduledRows = [draft];
        return response({ success: true, draft });
      }
      if (String(input).endsWith("/queued-1/restored")) {
        if (markFails) return response({ error: "down" }, 500);
        scheduledRows = [];
        return response({ success: true });
      }
      return base(input, options);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    expect(await screen.findByText("Cancelled. The email is open as a draft.")).toBeInTheDocument();
    await waitFor(() => expect(posts("/queued-1/restored").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open as draft" })).not.toBeInTheDocument());
    const before = posts("/queued-1/restored").length;
    markFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled" }));
    await waitFor(() => expect(posts("/queued-1/restored").length).toBeGreaterThan(before));
    expect(screen.queryByRole("button", { name: "Open as draft" })).not.toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("waves_email_restored_pending:fixture-schedule-owner"))).toEqual([]);
  });

  it("closes a restored draft the tab cannot save, and keeps the row listed", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "scheduled" }];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled (1)" }));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function failDrafts(key, value) {
      if (!/schedul|restore_keys/i.test(key)) throw new Error("Quota");
      return setItem.call(this, key, value);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    expect(await screen.findByText(/could not save the draft safely, so it closed again/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Saved text")).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts("/queued-1/restored")).toHaveLength(0);
  });

  it("does not schedule when the tab cannot save the safety key", async () => {
    mount();
    await writeEmail();
    // Fail only the schedule key write; the draft store keeps working.
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function failScheduleKey(key, value) {
      if (/schedul/i.test(key)) throw new Error("Quota");
      return setItem.call(this, key, value);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    expect((await screen.findAllByText(/Scheduling did not start/)).length).toBeGreaterThan(0);
    expect(posts("/email/schedule")).toHaveLength(0);
    expect(screen.getByLabelText(/^Message/)).toHaveValue("Line one\n<b>two</b>");
  });

  it("says when edits made during the request were not scheduled", async () => {
    let finish;
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/email/schedule")
      ? new Promise((resolve) => { finish = () => resolve(base(input, options)); }) : base(input, options)));
    mount();
    await writeEmail();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule send options" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow morning/ }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Edited later" } });
    finish();
    expect((await screen.findAllByText(/Your newer edits were not scheduled/)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/^Message/)).toHaveValue("Edited later");
  });

  it("Back to draft on an email Gmail may have sent keeps plain Send blocked until the Sent check", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "outcome_unknown", mayHaveSent: true }];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to draft" }));
    expect(await screen.findByText("Cancelled. The email is open as a draft.")).toBeInTheDocument();
    expect(screen.getByText(/Gmail may already have sent this email/)).toBeInTheDocument();
    const send = () => screen.getAllByRole("button", { name: "Send", exact: true }).at(-1);
    expect(send()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "I checked: it is in neither" }));
    await waitFor(() => expect(send()).not.toBeDisabled());
  });

  it("does not open a may-have-sent draft when the tab cannot save the Sent-check guard", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "outcome_unknown", mayHaveSent: true }];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled" }, { timeout: 3000 }));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function failGuard(key, value) {
      if (/schedule_uncertain/.test(key)) throw new Error("Quota");
      return setItem.call(this, key, value);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Back to draft" }));
    expect(await screen.findByText(/could not save its safety check/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Saved text")).not.toBeInTheDocument();
    expect(posts("/queued-1/restored")).toHaveLength(0);
  });

  it("takes the draft back when neither the browser nor the server can record the restore", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "scheduled" }];
    const base = fetch.getMockImplementation();
    fetch.mockImplementation((input, options = {}) => (String(input).endsWith("/queued-1/restored")
      ? response({ error: "down" }, 500) : base(input, options)));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled (1)" }, { timeout: 3000 }));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function failPending(key, value) {
      if (/restored_pending/.test(key)) throw new Error("Quota");
      return setItem.call(this, key, value);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    expect(await screen.findByText(/could not save the draft safely, so it closed again/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Saved text")).not.toBeInTheDocument();
    expect(posts("/queued-1/restored")).toHaveLength(1);
  });

  it("sign-out removes the schedule-send state with the drafts", () => {
    sessionStorage.setItem("waves_email_restored_pending:fixture-schedule-owner", "[\"queued-1\"]");
    sessionStorage.setItem("waves_email_restore_keys:fixture-schedule-owner", "{}");
    sessionStorage.setItem("waves_email_schedule_uncertain:fixture-schedule-owner", "{}");
    sessionStorage.setItem("unrelated_fixture_key", "kept");
    clearEmailDrafts();
    expect(Object.keys(sessionStorage)).toEqual(["unrelated_fixture_key"]);
  });

  it("never cancels over a new email in progress", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "scheduled" }];
    mount();
    await writeEmail();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1));
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    expect(await screen.findByText(/You have a new email in progress/)).toBeInTheDocument();
    expect(posts("/cancel")).toHaveLength(0);
  });
});
