// @vitest-environment jsdom
// Gmail-style Schedule send (GATE_EMAIL_SEND_LATER): the arrow beside Send
// queues the email with an Eastern wall-clock time and its plain text, the
// Scheduled tab lists it, and Cancel send brings it back as a draft — never
// over a draft already in progress.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmailPage from "./EmailPage";
import { clearEmailDrafts } from "../../lib/emailDrafts";
import { schedulePresets } from "./email/scheduleSend";

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

  it("Cancel send brings the email back into the composer", async () => {
    scheduledRows = [{ id: "queued-1", to: "customer@example.invalid", subject: "Guide", draftText: "Saved text", sendAt: "2026-10-23T13:00:00.000Z", status: "scheduled" }];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    expect(await screen.findByText("Cancelled. The email is open as a draft.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Message/)).toHaveValue("Saved text");
    expect(screen.getByLabelText(/^To/)).toHaveValue("customer@example.invalid");
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
