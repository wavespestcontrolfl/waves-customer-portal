// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmailPage from "./EmailPage";
import { clearEmailDrafts } from "../../lib/emailDrafts";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
const a = { id: "mail-a", gmail_thread_id: "thread-a", from_address: "a@example.invalid", subject: "First fixture", body_text: "First fixture body", is_read: true, received_at: new Date().toISOString() };
const b = { ...a, id: "mail-b", gmail_thread_id: "thread-b", from_address: "b@example.invalid", subject: "Second fixture", body_text: "Second fixture body" };
const response = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
let overrides;
const calls = (suffix) => fetch.mock.calls.filter(([url]) => new URL(url, "https://fixture.invalid").pathname.endsWith(suffix));
function emailRoute(active = true) {
  return <BrowserRouter><Routes><Route path="/admin" element={<Outlet context={{ user: { id: "fixture-workspace-owner", role: "admin" } }} />}>
    <Route path="communications" element={<EmailPage active={active} navigation={{ title: "Communications", sections: [] }} />} />
  </Route></Routes></BrowserRouter>;
}
function mount(active = true) { return render(emailRoute(active)); }
async function open(mail = a) {
  fireEvent.click(await screen.findByRole("button", { name: (name) => name.startsWith("Open email:") && name.includes(mail.subject) }));
  return screen.findByRole("textbox", { name: "Reply", exact: true });
}
function visit(id) {
  act(() => { window.history.pushState({}, "", `/admin/communications?id=${id}#tab=email`); window.dispatchEvent(new PopStateEvent("popstate")); });
}
beforeEach(() => {
  clearEmailDrafts(); sessionStorage.clear(); localStorage.clear();
  localStorage.setItem("waves_admin_token", "fixture-token");
  window.history.replaceState({}, "", "/admin/communications#tab=email");
  overrides = new Map();
  vi.stubGlobal("fetch", vi.fn((input, options = {}) => {
    const url = new URL(input, "https://fixture.invalid");
    const override = overrides.get(url.pathname);
    if (override) return override(url, options);
    if (url.pathname.endsWith("/oauth/status")) return response({ connected: true });
    if (url.pathname.endsWith("/inbox")) return response({ emails: [a, b], total: 2 });
    if (url.pathname.endsWith("/stats")) return response({ total: 2, unread: 0, today: 2, starred: 0, vendor: 0 });
    if (url.pathname.endsWith("/daily-digest")) return response({ total_received: 0 });
    if (url.pathname.endsWith("/blocked")) return response({ blocked: [{ id: "blocked-a", domain: "unwanted.example.invalid", reason: "Fixture block", created_at: a.received_at }] });
    if (url.pathname.includes("/thread/")) return response({ thread: [url.pathname.endsWith("thread-a") ? a : b] });
    if (url.pathname.endsWith("/star")) return response({ is_starred: true });
    if (url.pathname.endsWith("/reclassify")) return response({ classification: { category: "customer_request" } });
    if (url.pathname.endsWith("/ai-draft")) return response({ reply_draft: "Fixture suggestion" });
    if (url.pathname.endsWith("/send")) return response({ success: true, messageId: "fixture-sent" });
    if (/\/(archive|trash|block|blocked-a)$/.test(url.pathname)) return response({ success: true });
    if (url.pathname.includes("/message/")) return response(url.pathname.endsWith(a.id) ? a : b);
    if (url.pathname.endsWith("/customers")) return response({ customers: [] });
    throw new Error(`Unmatched fixture request ${options.method || "GET"} ${url.pathname}`);
  }));
});
afterEach(() => { cleanup(); clearEmailDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Email workspace feedback and request ownership", () => {
  it.each([200, 503])("distinguishes unavailable connection status from a disconnected Gmail account and retries (%s)", async (status) => {
    overrides.set("/api/admin/email/oauth/status", () => response({ connected: false, error: "Fixture unavailable" }, status));
    mount();
    await screen.findByText("Email connection status is unavailable.");
    expect(screen.queryByRole("button", { name: /Connect Gmail/ })).not.toBeInTheDocument();
    expect(calls("/inbox")).toHaveLength(0);
    overrides.delete("/api/admin/email/oauth/status");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: (name) => name.startsWith("Open email:") && name.includes(a.subject) })).toBeInTheDocument();
    expect(calls("/oauth/status")).toHaveLength(2);
  });

  it("shows a loading inbox and retries a failed search with the same query", async () => {
    let finish;
    overrides.set("/api/admin/email/inbox", () => new Promise((resolve) => { finish = resolve; }));
    mount(); await screen.findByText("Loading inbox…");
    expect(screen.queryByText("No emails found")).not.toBeInTheDocument();
    await act(async () => finish(await response({}, 503)));
    await screen.findByText("The email inbox is unavailable.");
    overrides.set("/api/admin/email/inbox", () => response({}, 503));
    fireEvent.change(screen.getByLabelText("Search emails"), { target: { value: "fixture & notes" } });
    await waitFor(() => expect(calls("/inbox").at(-1)[0]).toContain("search=fixture+%26+notes"));
    overrides.set("/api/admin/email/inbox", () => response({ emails: [], total: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No emails found");
    expect(screen.getByLabelText("Search emails")).toHaveValue("fixture & notes");
    expect(calls("/inbox").at(-1)[0]).toContain("search=fixture+%26+notes");
  });

  it("shows unavailable metrics as missing values without inventing zeros", async () => {
    overrides.set("/api/admin/email/stats", () => response({}, 503));
    overrides.set("/api/admin/email/daily-digest", () => response({}, 503));
    mount();
    await screen.findByText("Email counts are unavailable.");
    await screen.findByText("Today's email activity is unavailable.");
    expect(screen.getAllByText("—", { exact: true })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Unread", exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unread (0)", exact: true })).not.toBeInTheDocument();
  });

  it("retries a failed thread without losing the selected reply draft", async () => {
    overrides.set("/api/admin/email/thread/thread-a", () => response({}, 503));
    mount(); const reply = await open();
    fireEvent.change(reply, { target: { value: "Retain this reply" } });
    const feedback = await screen.findByText("The email conversation is unavailable.");
    expect(screen.queryByText("No messages in this conversation.")).not.toBeInTheDocument();
    overrides.delete("/api/admin/email/thread/thread-a");
    fireEvent.click(within(feedback.closest('[role="alert"]')).getByRole("button", { name: "Try again" }));
    await screen.findByText(a.body_text);
    expect(reply).toHaveValue("Retain this reply");
    expect(calls("/thread/thread-a")).toHaveLength(2);
  });

  it("retries a retained message after its channel reactivation refresh fails", async () => {
    const view = mount();
    fireEvent.change(await open(), { target: { value: "Keep the selected reply" } });
    await screen.findByText(a.body_text);
    view.rerender(emailRoute(false));
    overrides.set(`/api/admin/email/message/${a.id}`, () => response({}, 503));
    view.rerender(emailRoute(true));
    await screen.findByText("The linked email is unavailable.");
    const attempts = calls(`/message/${a.id}`).length;
    overrides.delete(`/api/admin/email/message/${a.id}`);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(a.body_text);
    expect(calls(`/message/${a.id}`)).toHaveLength(attempts + 1);
    expect(screen.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue("Keep the selected reply");
  });

  it("returns to the inbox when a retained message cannot be refreshed", async () => {
    const view = mount();
    fireEvent.change(await open(), { target: { value: "Keep this reply" } });
    view.rerender(emailRoute(false));
    overrides.set(`/api/admin/email/message/${a.id}`, () => response({}, 404));
    view.rerender(emailRoute(true));
    await screen.findByText("The linked email is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Back to inbox", exact: true }));
    await waitFor(() => expect(window.location.search).toBe(""));
    await waitFor(() => expect(screen.queryByText("The linked email is unavailable.")).not.toBeInTheDocument());
    expect(await open(b)).toHaveValue("");
    expect(await open(a)).toHaveValue("Keep this reply");
  });

  it("retries an unavailable linked message and preserves the previous message's draft", async () => {
    mount(); fireEvent.change(await open(), { target: { value: "Draft for the first message" } });
    overrides.set(`/api/admin/email/message/${b.id}`, () => response({}, 404));
    visit(b.id); await screen.findByText("The linked email is unavailable.");
    expect(screen.queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
    overrides.delete(`/api/admin/email/message/${b.id}`);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(b.body_text);
    expect(await open(a)).toHaveValue("Draft for the first message");
  });

  it("discards a late thread response after the operator opens another email", async () => {
    let finish;
    overrides.set("/api/admin/email/thread/thread-a", () => new Promise((resolve) => { finish = resolve; }));
    mount(); await open(a); await open(b);
    await screen.findByText(b.body_text);
    await act(async () => finish(await response({ thread: [a] })));
    expect(screen.queryByText(a.body_text)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: b.subject })).toBeInTheDocument();
  });

  it.each(["reply", "read"])("keeps the current conversation loading when an earlier %s finishes", async (action) => {
    let finishAction, finishThread;
    const endpoint = action === "reply" ? "/api/admin/email/send" : `/api/admin/email/message/${a.id}/read`;
    overrides.set(endpoint, () => new Promise((resolve) => { finishAction = resolve; }));
    if (action === "read") {
      overrides.set("/api/admin/email/inbox", () => response({ emails: [{ ...a, is_read: false }, b], total: 2 }));
    }
    overrides.set("/api/admin/email/thread/thread-b", () => new Promise((resolve) => { finishThread = resolve; }));
    mount();
    const reply = await open(a);
    if (action === "reply") {
      await screen.findByText(a.body_text);
      fireEvent.change(reply, { target: { value: "Reply to the first email" } });
      fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    }
    await open(b);
    await screen.findByText("Loading conversation…");
    await act(async () => finishAction(await response({ success: true, is_read: true })));
    await act(async () => finishThread(await response({ thread: [b] })));
    expect(await screen.findByText(b.body_text)).toBeInTheDocument();
    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
  });

  it("keeps a linked message error after the previous conversation finishes loading", async () => {
    let finish;
    overrides.set("/api/admin/email/thread/thread-a", () => new Promise((resolve) => { finish = resolve; }));
    overrides.set(`/api/admin/email/message/${b.id}`, () => response({}, 404));
    window.history.replaceState({}, "", `/admin/communications?id=${a.id}#tab=email`);
    mount();
    await screen.findByRole("textbox", { name: "Reply" });
    visit(b.id);
    await screen.findByText("The linked email is unavailable.");
    await act(async () => finish(await response({ thread: [a] })));
    expect(screen.getByText("The linked email is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it.each(["Archive", "Trash"])("retains the message and draft after a failed %s, guards a repeated action, and removes it after success", async (label) => {
    const endpoint = `/api/admin/email/message/${a.id}/${label.toLowerCase()}`;
    let finish;
    overrides.set(endpoint, () => new Promise((resolve) => { finish = resolve; }));
    mount(); fireEvent.change(await open(), { target: { value: "Retained reply" } });
    const button = screen.getByRole("button", { name: label, exact: true });
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled(); expect(calls(endpoint)).toHaveLength(1);
    await act(async () => finish(await response({}, 503)));
    await screen.findByText(label === "Archive" ? "Could not archive the email. Try again." : "Could not move the email to trash. Try again.");
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Retained reply");
    overrides.delete(endpoint);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument());
    expect(window.location.search).not.toContain("id=");
  });

  it("keeps the star and classification unchanged after rejected actions", async () => {
    overrides.set(`/api/admin/email/message/${a.id}/star`, () => response({}, 503));
    overrides.set(`/api/admin/email/message/${a.id}/reclassify`, () => response({}, 503));
    mount(); await open();
    fireEvent.click(screen.getByRole("button", { name: `Star ${a.subject}` }));
    await screen.findByText("Could not update the star. Try again.");
    expect(screen.getByRole("button", { name: `Star ${a.subject}` })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Reclassify" }));
    await screen.findByText("Could not reclassify the email. Try again.");
    expect(screen.queryByText("AI classification:")).not.toBeInTheDocument();
  });

  it("preserves blocked senders and the entered address after failed writes", async () => {
    overrides.set("/api/admin/email/block", () => response({}, 503));
    overrides.set("/api/admin/email/blocked/blocked-a", () => response({}, 503));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Blocked senders", exact: true }));
    await screen.findByText("unwanted.example.invalid");
    fireEvent.change(screen.getByLabelText("Domain or email to block"), { target: { value: "Other@Example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Block", exact: true }));
    await screen.findByText("Could not block the sender. Try again.");
    expect(screen.getByLabelText("Domain or email to block")).toHaveValue("Other@Example.invalid");
    expect(JSON.parse(calls("/block")[0][1].body)).toEqual({ email_address: "other@example.invalid", domain: null, reason: "Manual block from admin portal" });
    fireEvent.click(screen.getByRole("button", { name: "Unblock" }));
    await screen.findByText("Could not unblock the sender. Try again.");
    expect(screen.getByText("unwanted.example.invalid")).toBeInTheDocument();
  });

  it("retains an unconfirmed new email and clears only a confirmed send", async () => {
    overrides.set("/api/admin/email/send", () => response({ success: false }));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "New email" }));
    const dialog = screen.getByRole("dialog", { name: "New email" });
    fireEvent.change(within(dialog).getByLabelText("To *"), { target: { value: "recipient@example.invalid" } });
    fireEvent.change(within(dialog).getByLabelText("Message *"), { target: { value: "Unconfirmed fixture email" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send", exact: true }));
    await within(dialog).findByText("Email send was not confirmed. Your draft is still here.");
    expect(within(dialog).getByLabelText("Message *")).toHaveValue("Unconfirmed fixture email");
    expect(within(dialog).getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    expect(calls("/send")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "I checked Sent: it was not sent" }));
    overrides.delete("/api/admin/email/send");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Email sent."));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["compose", "reply"].flatMap(kind => ["sent", "not_sent"].map(outcome => [kind, outcome])))
    ("clears %s feedback after a successful %s verdict", async (kind, outcome) => {
      overrides.set("/api/admin/email/send", () => response({}, 503));
      mount();
      if (kind === "compose") {
        fireEvent.click(await screen.findByRole("button", { name: "New email", exact: true }));
        fireEvent.change(screen.getByLabelText("To *"), { target: { value: "fixture@example.invalid" } });
      } else await open();
      const field = kind === "compose" ? screen.getByLabelText("Message *") : screen.getByRole("textbox", { name: "Reply", exact: true });
      fireEvent.change(field, { target: { value: "Recovery fixture" } });
      fireEvent.click(screen.getByRole("button", { name: kind === "compose" ? "Send" : "Send reply", exact: true }));
      const feedback = `${kind === "compose" ? "Email" : "Reply"} send was not confirmed. Your draft is still here.`;
      await screen.findByText(feedback);
      fireEvent.click(screen.getByRole("button", { name: `I checked Sent: it was ${outcome === "sent" ? "sent" : "not sent"}`, exact: true }));
      expect(screen.queryByText(feedback)).not.toBeInTheDocument();
      expect(field).toHaveValue(outcome === "sent" ? "" : "Recovery fixture");
      expect(calls("/send")).toHaveLength(1);
    });

  it("keeps a failed reply and its feedback scoped to the original message while browsing", async () => {
    let finish;
    overrides.set("/api/admin/email/send", () => new Promise((resolve) => { finish = resolve; }));
    mount(); fireEvent.change(await open(a), { target: { value: "Pending first reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await open(b);
    await act(async () => finish(await response({}, 503)));
    expect(screen.queryByText("Reply send was not confirmed. Your draft is still here.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
    expect(await open(a)).toHaveValue("Pending first reply");
    expect(screen.getByText("Reply send was not confirmed. Your draft is still here.")).toBeInTheDocument();
  });
});
