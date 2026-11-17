// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

// Mark spam tags the sender (texts stay, no alerts) instead of blocking it;
// "Not spam" undoes it.
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useOutletContext: () => ({ user: { role: "admin" } }) };
});

import { SmsTab, mergeRefreshedLogPages } from "./CommunicationsPageV2";

const line = "+19415550199";
const spammer = "+15557654321";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubServer({ messages }) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = new URL(String(url), "http://localhost").pathname;
    calls.push({ path, method: options.method || "GET" });
    const data = path.endsWith("/log") ? { messages }
      : path.endsWith("/blocked-numbers") ? { numbers: [] }
      : { success: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const pitch = (extra = {}) => ({
  id: "m1", conversationId: "conv1", from: spammer, to: line, channel: "sms", direction: "inbound",
  body: "Unsolicited pitch", createdAt: "2024-01-01T12:00:00Z", isRead: false, ...extra,
});

it("Mark spam tags the sender and never touches the block list", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const calls = stubServer({ messages: [pitch()] });
  const confirmSpy = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmSpy);
  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByText("Unsolicited pitch"));
  fireEvent.click(await screen.findByRole("button", { name: /Mark spam/ }));
  await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith("/spam-senders") && c.method === "POST")).toBe(true));
  expect(confirmSpy).toHaveBeenCalledWith(
    `Mark ${spammer} as spam? Its texts stay in the inbox with a Spam tag and no alerts. Calls are not blocked.`,
  );
  expect(calls.some((c) => c.path.endsWith("/blocked-numbers") && c.method === "POST")).toBe(false);
});

it("a silenced thread shows the Spam tag and Not spam, which undoes it", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const calls = stubServer({ messages: [pitch({ spamEnforced: true, isRead: true })] });
  const confirmSpy = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmSpy);
  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByText("Unsolicited pitch"));
  expect(await screen.findByText(/Spam · no alert sent/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Mark spam/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Not spam/ }));
  await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith(`/spam-senders/${encodeURIComponent(spammer)}`))).toBe(true));
  expect(confirmSpy).toHaveBeenCalledWith(`Bring ${spammer}'s texts back as needing a reply?`);
});

it("an unlinked thread without a verdict shows no Spam tag", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  stubServer({ messages: [pitch()] });
  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByText("Unsolicited pitch"));
  await screen.findByRole("button", { name: /Mark spam/ });
  expect(screen.queryByText(/Spam · no alert sent/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Not spam/ })).not.toBeInTheDocument();
});

// Refreshing several loaded Unanswered pages rebuilds the log response from
// every page, newest first.
it("a refresh of several loaded pages merges them", () => {
  const page = (n) => ({
    messages: [pitch({ id: `m${n}`, createdAt: `2024-01-0${n}T12:00:00Z` })], hasMore: n < 2, page: n,
  });
  const merged = mergeRefreshedLogPages([page(1), page(2)], 2);
  expect(merged).toMatchObject({ hasMore: false, page: 2 });
  expect(merged.messages.map((m) => m.id)).toEqual(["m2", "m1"]);
});

// Codex pre-push P1: photos are never stamped, so a photo-only thread has no
// verdict to show. The log payload marks the tagged sender instead, and the
// thread offers Not spam after the tag.
it("a photo-only thread can be tagged and then undone", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  let tagged = false;
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const method = options.method || "GET";
    calls.push({ path, method });
    if (method === "POST" && path.endsWith("/spam-senders")) tagged = true;
    if (method === "DELETE" && path.includes("/spam-senders/")) tagged = false;
    const photo = pitch({
      body: "Look at this", media: [{ url: "https://example.com/p.jpg", contentType: "image/jpeg" }],
      ...(tagged ? { senderSpamTagged: true } : {}),
    });
    const data = path.endsWith("/log") ? { messages: [photo] }
      : path.endsWith("/blocked-numbers") ? { numbers: [] }
      : { success: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click((await screen.findAllByText("Look at this"))[0]);
  fireEvent.click(await screen.findByRole("button", { name: /Mark spam/ }));
  await vi.waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/spam-senders"))).toBe(true));
  // The inbox reloads after the tag; that reload carries the sender's tag.
  const postAt = calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/spam-senders"));
  await vi.waitFor(() => expect(calls.slice(postAt + 1).some((c) => c.path.endsWith("/log"))).toBe(true));

  fireEvent.click((await screen.findAllByText("Look at this"))[0]);
  fireEvent.click(await screen.findByRole("button", { name: /Not spam/ }));
  expect(screen.queryByText(/Spam · no alert sent/)).not.toBeInTheDocument();
  await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith(`/spam-senders/${encodeURIComponent(spammer)}`))).toBe(true));
  expect(calls.some((c) => c.path.endsWith("/blocked-numbers") && c.method === "POST")).toBe(false);
});

// Codex P2 on #7457: a tagged sender who later became a customer keeps the
// texts silenced before the link; the thread must still offer Not spam (and
// never Mark spam, which the server refuses for a customer).
it("a customer-linked thread with silenced texts still offers Not spam", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const calls = stubServer({
    messages: [pitch({ spamEnforced: true, isRead: true, customerId: "cust-synthetic-1", customerName: "Synthetic Customer" })],
  });
  vi.stubGlobal("confirm", vi.fn(() => true));
  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click((await screen.findAllByText("Unsolicited pitch"))[0]);
  expect(screen.queryByRole("button", { name: /Mark spam/ })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: /Not spam/ }));
  await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path.includes("/spam-senders/"))).toBe(true));
});
