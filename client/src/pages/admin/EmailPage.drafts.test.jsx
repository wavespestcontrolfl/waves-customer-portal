// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmailPage from "./EmailPage";
import { clearEmailDrafts } from "../../lib/emailDrafts";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
const a = { id: "00000000-0000-4000-8000-000000000001", gmail_thread_id: "thread-a", from_address: "a@example.invalid", subject: "First fixture message", is_read: true, received_at: new Date().toISOString(), body_text: "First fixture body" };
const b = { ...a, id: "00000000-0000-4000-8000-000000000002", gmail_thread_id: "thread-b", from_address: "b@example.invalid", subject: "Second fixture message", body_text: "Second fixture body" };
let sendResponse;
let draftResponse;
let messageResponse;
let actionResponse;
let inbox;
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  clearEmailDrafts(); sessionStorage.clear(); localStorage.setItem("waves_admin_token", "fixture-token");
  window.history.replaceState({}, "", "/admin/communications#tab=email");
  inbox = [a, b]; sendResponse = null; draftResponse = null; messageResponse = null; actionResponse = null;
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input, options = {}) => {
    const url = new URL(input, "https://fixture.invalid");
    if (url.pathname.endsWith("/oauth/status")) return response({ connected: true });
    if (url.pathname.endsWith("/inbox")) return response({ emails: inbox, total: inbox.length });
    if (url.pathname.endsWith("/send")) return sendResponse ? sendResponse(options) : response({ success: true });
    if (url.pathname.endsWith("/ai-draft")) return draftResponse ? draftResponse() : response({ reply_draft: "Synthetic AI suggestion" });
    if (url.pathname.includes("/thread/")) return response({ thread: [url.pathname.endsWith("thread-a") ? a : b] });
    if (url.pathname.endsWith("/star")) return response({ is_starred: true });
    if (/\/(archive|trash)$/.test(url.pathname)) return actionResponse ? actionResponse() : response({ success: true });
    if (url.pathname.endsWith("/reclassify")) return response({ classification: { category: "customer", summary: "Synthetic classification detail" } });
    if (url.pathname.includes("/message/")) return messageResponse ? messageResponse(url) : response(url.pathname.endsWith(a.id) ? a : b);
    if (url.pathname.endsWith("/stats")) return response({ total: inbox.length, unread: 0 });
    if (url.pathname.endsWith("/daily-digest")) return response({ total_received: 0 });
    if (url.pathname.endsWith("/customers")) return response({ customers: [] });
    throw new Error(`Unmatched fixture request ${options.method || "GET"} ${url.pathname}`);
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(userId = "fixture-owner") {
  return render(<BrowserRouter><Routes><Route path="/admin" element={<Outlet context={{ user: { id: userId, role: "admin" } }} />}>
    <Route path="communications" element={<EmailPage active navigation={{ title: "Communications", sections: [] }} />} />
  </Route></Routes></BrowserRouter>);
}
async function compose() {
  fireEvent.click(await screen.findByRole("button", { name: "New Email" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("To *"), { target: { value: "recipient@example.invalid" } });
  fireEvent.change(within(dialog).getByLabelText("Subject"), { target: { value: "Synthetic subject" } });
  fireEvent.change(within(dialog).getByLabelText("Message *"), { target: { value: "Unsent compose text" } });
  return dialog;
}
async function open(message) {
  fireEvent.click(await screen.findByText(message.subject));
  return screen.findByRole("textbox", { name: "Reply" });
}

describe("Email draft and navigation preservation", () => {
  it("recovers compose after unmount and supports explicit discard", async () => {
    const view = mount(); await compose(); view.unmount();
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    expect(screen.getByLabelText("Message *")).toHaveValue("Unsent compose text");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "New Email" }));
    expect(screen.getByLabelText("Message *")).toHaveValue("");
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/send"))).toHaveLength(0);
  });

  it("keeps replies separate across messages and preserves query/hash context", async () => {
    window.history.replaceState({}, "", "/admin/communications?tag=a&tag=b#tab=email&source=bell");
    const view = mount();
    fireEvent.change(await open(a), { target: { value: "Reply for A" } });
    fireEvent.change(await open(b), { target: { value: "Reply for B" } });
    expect(await open(a)).toHaveValue("Reply for A");
    expect(new URLSearchParams(window.location.search).getAll("tag")).toEqual(["a", "b"]);
    expect(window.location.hash).toBe("#tab=email&source=bell");
    view.unmount(); mount();
    expect(await screen.findByRole("textbox", { name: "Reply" })).toHaveValue("Reply for A");
  });

  it("actually renders an archived or off-page message reached by a deep link", async () => {
    inbox = [];
    window.history.replaceState({}, "", `/admin/communications?id=${a.id}#tab=email`);
    mount();
    expect(await screen.findByText(a.body_text)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeInTheDocument();
  });

  it.each([404, 503, "network"])("clears the previous message while a changed link loads or fails (%s)", async (failure) => {
    mount();
    fireEvent.change(await open(a), { target: { value: "Unsent reply for A" } });
    let finish;
    messageResponse = () => new Promise((resolve, reject) => { finish = () => failure === "network" ? reject(new Error("Synthetic fetch failure")) : resolve(response({}, failure)); });
    act(() => {
      window.history.pushState({}, "", `/admin/communications?id=${b.id}#tab=email`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith(`/message/${b.id}`))).toBe(true));
    expect(screen.queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archive$/ })).not.toBeInTheDocument();
    await act(async () => finish());
    expect(screen.queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
    messageResponse = null;
    expect(await open(a)).toHaveValue("Unsent reply for A");
  });

  it("updates the visible star and classification for an off-list message", async () => {
    inbox = [];
    window.history.replaceState({}, "", `/admin/communications?id=${a.id}#tab=email`);
    mount();
    await screen.findByText(a.body_text);
    fireEvent.click(screen.getByText("☆", { exact: true }));
    expect(await screen.findByText("⭐", { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reclassify/ }));
    expect(await screen.findByText("AI classification:")).toBeInTheDocument();
  });

  it.each(["Archive", "Trash"].flatMap((action) => [a.id, b.id].map((id) => [action, id])))("a late %s keeps the current SMS route and message context (%s)", async (action, id) => {
    const view = mount(); await open(a);
    let finish;
    actionResponse = () => new Promise((resolve) => { finish = resolve; });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${action}$`) }));
    view.rerender(<BrowserRouter><Routes><Route path="/admin" element={<Outlet context={{ user: { id: "fixture-owner", role: "admin" } }} />}>
      <Route path="communications" element={<EmailPage active={false} navigation={{ title: "Communications", sections: [] }} />} />
    </Route></Routes></BrowserRouter>);
    act(() => {
      window.history.pushState({}, "", `/admin/communications?id=${id}&tag=new&thread=fixture-customer#tab=sms`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => finish(response({ success: true })));
    expect(window.location.hash).toBe("#tab=sms");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("tag")).toBe("new");
    expect(params.get("thread")).toBe("fixture-customer");
    expect(params.get("id")).toBe(id === a.id ? null : b.id);
  });

  it.each(["Archive", "Trash"])("a late %s cannot navigate after leaving Communications", async (action) => {
    const view = mount(); await open(a);
    let finish;
    actionResponse = () => new Promise((resolve) => { finish = resolve; });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${action}$`) }));
    view.unmount();
    window.history.pushState({}, "", "/admin/settings?tab=general");
    await act(async () => finish(response({ success: true })));
    expect(window.location.pathname + window.location.search).toBe("/admin/settings?tab=general");
  });

  it("retains a failed compose and clears it only after a confirmed send", async () => {
    sendResponse = () => response({ error: "Synthetic send failure" }, 503);
    const view = mount(); const dialog = await compose();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    view.unmount(); mount(); fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    expect(screen.getByLabelText("Message *")).toHaveValue("Unsent compose text");
    sendResponse = null;
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New Email" }));
    expect(screen.getByLabelText("Message *")).toHaveValue("");
  });

  it("does not overwrite a newer edit when an AI draft returns late", async () => {
    let finish;
    draftResponse = () => new Promise((resolve) => { finish = resolve; });
    mount(); const reply = await open(a);
    fireEvent.click(screen.getByRole("button", { name: /AI Draft/ }));
    fireEvent.change(reply, { target: { value: "Owner edited while waiting" } });
    await act(async () => finish(response({ reply_draft: "Late synthetic suggestion" })));
    expect(reply).toHaveValue("Owner edited while waiting");
  });

  it("does not restore a discarded reply when an AI draft returns late", async () => {
    let finish;
    draftResponse = () => new Promise((resolve) => { finish = resolve; });
    const view = mount(); const reply = await open(a);
    fireEvent.click(screen.getByRole("button", { name: /AI Draft/ }));
    fireEvent.change(reply, { target: { value: "Discard this reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard reply" }));
    view.unmount(); mount();
    await screen.findByRole("textbox", { name: "Reply" });
    await act(async () => finish(response({ reply_draft: "Late discarded suggestion" })));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
  });

  it("preserves a compose edited back to the submitted text while its send is pending", async () => {
    let finish;
    sendResponse = () => new Promise((resolve) => { finish = resolve; });
    mount(); const dialog = await compose();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send", exact: true }));
    fireEvent.change(screen.getByLabelText("Message *"), { target: { value: "New compose edit" } });
    fireEvent.change(screen.getByLabelText("Message *"), { target: { value: "Unsent compose text" } });
    await act(async () => finish(response({ success: true })));
    expect(screen.getByLabelText("Message *")).toHaveValue("Unsent compose text");
  });

  it("preserves a reply edited back to the submitted text while its send is pending", async () => {
    let finish;
    sendResponse = () => new Promise((resolve) => { finish = resolve; });
    mount(); const reply = await open(a);
    fireEvent.change(reply, { target: { value: "Submitted snapshot" } });
    fireEvent.click(screen.getByRole("button", { name: /Send Reply/ }));
    fireEvent.change(reply, { target: { value: "New reply edit" } });
    fireEvent.change(reply, { target: { value: "Submitted snapshot" } });
    await act(async () => finish(response({ success: true })));
    expect(reply).toHaveValue("Submitted snapshot");
  });

  it("keeps a newer reply when the previously submitted text completes", async () => {
    let finish;
    sendResponse = () => new Promise((resolve) => { finish = resolve; });
    mount(); const reply = await open(a);
    fireEvent.change(reply, { target: { value: "Submitted snapshot" } });
    fireEvent.click(screen.getByRole("button", { name: /Send Reply/ }));
    fireEvent.change(reply, { target: { value: "New unsent edit" } });
    await act(async () => finish(response({ success: true })));
    expect(reply).toHaveValue("New unsent edit");
  });

  it("shows storage failure, preserves navigation memory and warns before reload", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Synthetic quota failure"); });
    const view = mount(); await compose(); view.unmount(); mount();
    await screen.findByRole("button", { name: "Resume draft" });
    expect(screen.getByRole("alert")).toHaveTextContent("Draft recovery is unavailable");
    const reload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(reload); expect(reload.defaultPrevented).toBe(true);
  });

  it("keeps the storage failure reload warning after leaving Communications", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Synthetic quota failure"); });
    const view = mount(); await compose(); view.unmount();
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving); expect(leaving.defaultPrevented).toBe(true);
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    const discarded = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(discarded); expect(discarded.defaultPrevented).toBe(false);
  });

  it("does not offer another verified account's draft", async () => {
    const view = mount("fixture-owner-a"); await compose(); view.unmount(); mount("fixture-owner-b");
    await screen.findByRole("button", { name: "New Email" });
    expect(screen.queryByRole("button", { name: "Resume draft" })).not.toBeInTheDocument();
  });

  it("clears the recovered editor when its in-flight send completes after remount", async () => {
    let finish;
    sendResponse = () => new Promise((resolve) => { finish = resolve; });
    const view = mount(); const dialog = await compose();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send", exact: true }));
    view.unmount(); mount();
    await screen.findByRole("button", { name: "Resume draft" });
    await act(async () => finish(response({ success: true })));
    expect(screen.getByRole("button", { name: "New Email" })).toBeInTheDocument();
  });

  it("keeps a pending compose disabled after remount and warns before leaving", async () => {
    let finish;
    sendResponse = () => new Promise((resolve) => { finish = resolve; });
    const view = mount(); const dialog = await compose();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send", exact: true }));
    view.unmount();
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving); expect(leaving.defaultPrevented).toBe(true);
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    const send = within(screen.getByRole("dialog")).getByRole("button", { name: "Sending…", exact: true });
    expect(send).toBeDisabled(); fireEvent.click(send);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/send"))).toHaveLength(1);
    await act(async () => finish(response({ error: "Synthetic failure" }, 503)));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(screen.getByLabelText("Message *")).toHaveValue("Unsent compose text");
    const settled = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(settled); expect(settled.defaultPrevented).toBe(false);
  });

  it("keeps a pending reply disabled after remount without submitting twice", async () => {
    let finish;
    sendResponse = () => new Promise((resolve) => { finish = resolve; });
    const view = mount();
    fireEvent.change(await open(a), { target: { value: "Pending reply" } });
    fireEvent.click(screen.getByRole("button", { name: /Send Reply/ }));
    view.unmount(); mount();
    await screen.findByRole("textbox", { name: "Reply" });
    const send = screen.getByRole("button", { name: /Sending/ });
    expect(send).toBeDisabled(); fireEvent.click(send);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/send"))).toHaveLength(1);
    await act(async () => finish(response({ success: true })));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
  });
});
