// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";

const line = "+19415550199";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ["+442079460958", "+12079460958"],
  ["+12079460958", "+442079460958"],
])("blocking %s preserves the unrelated %s thread and counts", async (blocked, ordinary) => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const messages = [
    { id: "blocked", from: blocked, to: line, channel: "sms", direction: "inbound", body: "Blocked vendor pitch", createdAt: "2024-01-01T12:00:00Z" },
    { id: "ordinary", from: ordinary, to: line, channel: "sms", direction: "inbound", body: "Please quote pest control", createdAt: "2024-01-01T12:01:00Z" },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const data = path.endsWith("/log") ? { messages }
      : path.endsWith("/blocked-numbers") ? { numbers: [{ number: blocked }] }
      : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<SmsTab active />, { wrapper: MemoryRouter });
  expect(await screen.findByText("Please quote pest control")).toBeInTheDocument();
  expect(screen.queryByText("Blocked vendor pitch")).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Unanswered (1)" })).toBeInTheDocument();
});

// codex #4213 P2: a failed /messages/read after a successful block must not
// be reported as a mark-spam failure — the block already stood, and the
// confirmation must not claim the thread was marked read when it wasn't.
it("reports a read failure separately after the block itself succeeds", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const spammer = "+15557654321";
  const messages = [
    { id: "m1", conversationId: "conv1", from: spammer, to: line, channel: "sms", direction: "inbound", body: "Unsolicited pitch", createdAt: "2024-01-01T12:00:00Z", isRead: false },
  ];
  let blockPosted = false;
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (path.endsWith("/blocked-numbers") && options.method === "POST") {
      blockPosted = true;
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.endsWith("/messages/read")) {
      return new Response(JSON.stringify({ error: "read service unavailable" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const data = path.endsWith("/log") ? { messages }
      : path.endsWith("/blocked-numbers") ? { numbers: blockPosted ? [{ number: spammer }] : [] }
      : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  const alertSpy = vi.fn();
  vi.stubGlobal("alert", alertSpy);

  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByText("Unsolicited pitch"));
  fireEvent.click(await screen.findByRole("button", { name: /Mark spam/ }));

  await vi.waitFor(() => expect(blockPosted).toBe(true));
  await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
  const [message] = alertSpy.mock.calls[0];
  expect(message).toMatch(/blocked/i);
  expect(message).toMatch(/marking the thread read failed/i);
  expect(message).not.toMatch(/could not mark spam/i);
});

// codex #4213 P2: Mark spam is a sender action. A thread the office started
// by texting an unlinked number has nothing inbound, so blocking it would
// reject a recipient who never sent anything.
it("does not offer Mark spam on an outbound-only thread", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  const messages = [
    { id: "out1", conversationId: "conv-out", from: line, to: "+15557650001", channel: "sms", direction: "outbound", body: "Following up on your quote", createdAt: "2024-01-01T12:00:00Z", isRead: true },
    { id: "in1", conversationId: "conv-in", from: "+15557650002", to: line, channel: "sms", direction: "inbound", body: "Unsolicited pitch", createdAt: "2024-01-01T12:01:00Z", isRead: false },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const data = path.endsWith("/log") ? { messages } : path.endsWith("/blocked-numbers") ? { numbers: [] } : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  render(<SmsTab active />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByText("Following up on your quote"));
  expect(await screen.findByRole("button", { name: /Back/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Mark spam/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Back/ }));
  fireEvent.click(await screen.findByText("Unsolicited pitch"));
  expect(await screen.findByRole("button", { name: /Mark spam/ })).toBeInTheDocument();
});
