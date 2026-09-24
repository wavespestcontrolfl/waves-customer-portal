// @vitest-environment jsdom
// ADMIN-BUG-R29: the AI Auto-Reply switch used to swallow failed toggles
// (empty catch) and trust a 200 {enabled:false, error} body from the
// server's own catch path, so an operator could believe AI texting was off
// while the server still had it on. Adapted from the audit repro at
// wt-audit-bugs-20260922/client/src/__audit_repro__/r1-client-state-2-ai-auto-reply-toggle-error.test.jsx
// (that repro asserted the BUGGY behaviour to prove it reproduced; these
// assertions are inverted to the fixed/expected behaviour and fail on the
// pre-fix code).
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";

vi.mock("../../utils/imageCompression", async (original) => ({ ...await original(), fitImagesToBudget: async (files) => ({ ok: true, files }) }));

const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tick = async (ms = 350) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
let toggleResponse;

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("waves_admin_token", "synthetic-token");
  sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
    const parsed = new URL(String(url), "http://localhost");
    if (parsed.pathname.endsWith("/ai-auto-reply-status")) return response({ enabled: true });
    if (parsed.pathname.endsWith("/ai-auto-reply")) return toggleResponse();
    if (parsed.pathname.endsWith("/log")) return response({ messages: [], hasMore: false, page: 1 });
    if (parsed.pathname.endsWith("/blocked-numbers")) return response({ numbers: [] });
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const toggleButton = () => screen.getByRole("button", { name: /AI Auto-Reply/ });
const togglePosts = () => fetch.mock.calls.filter(([u, o]) => String(u).endsWith("/ai-auto-reply") && o?.method === "POST");

it("HTTP 500 on the toggle POST: switch stays ON and the failure is surfaced", async () => {
  toggleResponse = () => response({ error: "boom" }, 500);
  render(<SmsTab active />, { wrapper: MemoryRouter }); await tick();
  expect(toggleButton()).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(toggleButton()); await tick();
  expect(togglePosts()).toHaveLength(1);
  expect(toggleButton()).toHaveAttribute("aria-pressed", "true"); // did not silently flip
  expect(toggleButton()).not.toBeDisabled();
  expect(screen.getByText(/boom|could not be changed/i)).toBeInTheDocument(); // operator is told
});

it("HTTP 429 (no retry in this page's local adminFetch): failure is surfaced, no silent retry", async () => {
  toggleResponse = () => response({ error: "Too many requests, please try again later." }, 429);
  render(<SmsTab active />, { wrapper: MemoryRouter }); await tick();
  fireEvent.click(toggleButton()); await tick(5000);
  expect(togglePosts()).toHaveLength(1); // no auto-retry
  expect(toggleButton()).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText(/too many requests|could not be changed/i)).toBeInTheDocument();
});

it("server DB failure returns 200 {enabled:false,error}: switch is NOT adopted from the error body", async () => {
  toggleResponse = () => response({ enabled: false, error: "connection refused" }, 200);
  render(<SmsTab active />, { wrapper: MemoryRouter }); await tick();
  fireEvent.click(toggleButton()); await tick();
  // The 200 body carries an error, so the client must not adopt enabled:false —
  // the switch keeps showing the last CONFIRMED state (still on).
  expect(toggleButton()).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText(/connection refused/)).toBeInTheDocument();
});

it("a successful toggle still flips the switch with no error text", async () => {
  toggleResponse = () => response({ enabled: false }, 200);
  render(<SmsTab active />, { wrapper: MemoryRouter }); await tick();
  fireEvent.click(toggleButton()); await tick();
  expect(toggleButton()).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByText(/could not be changed|connection refused|boom/i)).not.toBeInTheDocument();
});
