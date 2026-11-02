// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

// GATE_SMS_SPAM_TAG: Mark spam tags the sender (texts stay, no alerts) instead
// of blocking it; "Not spam" undoes it. The log payload carries smsSpamTag
// while the gate is on.
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useOutletContext: () => ({ user: { role: "admin" } }) };
});

import { SmsTab, mergeRefreshedLogPages } from "./CommunicationsPageV2";

const line = "+19415550199";
const spammer = "+15557654321";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubServer({ gateOn, messages }) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = new URL(String(url), "http://localhost").pathname;
    calls.push({ path, method: options.method || "GET" });
    const data = path.endsWith("/log") ? { messages, ...(gateOn ? { smsSpamTag: true } : {}) }
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

it("gate on: Mark spam tags the sender and never touches the block list", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const calls = stubServer({ gateOn: true, messages: [pitch()] });
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

it("gate off: Mark spam still blocks the number", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const calls = stubServer({ gateOn: false, messages: [pitch()] });
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("alert", vi.fn());
  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByText("Unsolicited pitch"));
  fireEvent.click(await screen.findByRole("button", { name: /Mark spam/ }));
  await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith("/blocked-numbers") && c.method === "POST")).toBe(true));
  expect(calls.some((c) => c.path.endsWith("/spam-senders"))).toBe(false);
});

it("gate on: a silenced thread shows the Spam tag and Not spam, which undoes it", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const calls = stubServer({ gateOn: true, messages: [pitch({ spamEnforced: true, isRead: true })] });
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
  stubServer({ gateOn: true, messages: [pitch()] });
  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByText("Unsolicited pitch"));
  await screen.findByRole("button", { name: /Mark spam/ });
  expect(screen.queryByText(/Spam · no alert sent/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Not spam/ })).not.toBeInTheDocument();
});

// Codex pre-push P1: refreshing several loaded Unanswered pages rebuilds the
// log response; without the flag, Mark spam fell back to the block while the
// gate was on.
it("a refresh of several loaded pages keeps the spam-tag flag", () => {
  const page = (n, extra = {}) => ({
    messages: [pitch({ id: `m${n}`, createdAt: `2024-01-0${n}T12:00:00Z` })], hasMore: n < 2, page: n, ...extra,
  });
  const on = mergeRefreshedLogPages([page(1, { smsSpamTag: true }), page(2, { smsSpamTag: true })], 2);
  expect(on).toMatchObject({ smsSpamTag: true, hasMore: false, page: 2 });
  expect(on.messages.map((m) => m.id)).toEqual(["m2", "m1"]);
  expect(mergeRefreshedLogPages([page(1), page(2)], 2)).not.toHaveProperty("smsSpamTag");
});
