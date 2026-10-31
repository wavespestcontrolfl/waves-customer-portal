// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

vi.mock("./ContentCalendar", () => ({ default: () => <div>Calendar fixture</div> }));

import SocialMediaPage from "./SocialMediaPage";

function renderTab(tab) {
  return render(
    <MemoryRouter initialEntries={[`/admin/social-media?tab=${tab}`]}>
      <SocialMediaPage />
    </MemoryRouter>,
  );
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shared fixtures for the page chrome; each test overrides one route.
function baseFixture(path) {
  if (path === "/admin/social-media/status") {
    return { automation: { enabled: true, paused: false }, platforms: {} };
  }
  if (path === "/admin/social-media/stats") return { total: 0, published: 0, failed: 0, last7d: 0 };
  if (path.startsWith("/admin/social-media/history")) return { posts: [] };
  if (path === "/admin/social-media/health") return { credentials: [] };
  if (path === "/admin/social-media/alerts") return { active: false };
  if (path === "/admin/social-media/autonomous/status") return { enabled: true, channels: [] };
  return undefined;
}

function routeFetch(overrides) {
  fetch.mockImplementation(async (url, options = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const key = `${options.method || "GET"} ${path}`;
    if (overrides[key]) return overrides[key]();
    const base = baseFixture(path);
    if (base !== undefined) return response(base);
    throw new Error(`Unexpected synthetic request: ${key}`);
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-admin-token" });
  vi.stubGlobal("fetch", vi.fn());
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RSS tab", () => {
  it("shows an error with retry on a 503, not the empty state", async () => {
    let calls = 0;
    routeFetch({
      "GET /admin/social-media/rss": async () => {
        calls += 1;
        return calls === 1
          ? response({ error: "down" }, 503)
          : response({ items: [{ title: "Synthetic post", link: "https://example.test/p", posted: false }] });
      },
    });
    renderTab("rss");
    expect(await screen.findByText(/RSS feed unavailable: HTTP 503/)).toBeInTheDocument();
    expect(screen.queryByText("No RSS items found")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Synthetic post")).toBeInTheDocument();
  });

  it("keeps the empty message for a successful empty response", async () => {
    routeFetch({ "GET /admin/social-media/rss": async () => response({ items: [] }) });
    renderTab("rss");
    expect(await screen.findByText("No RSS items found")).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  });

  async function runCheck(result) {
    routeFetch({
      "GET /admin/social-media/rss": async () => response({ items: [] }),
      "POST /admin/social-media/check-rss": async () => response(result),
    });
    renderTab("rss");
    fireEvent.click(await screen.findByRole("button", { name: "Check & Auto-Publish New" }));
  }

  it("does not say published for a skipped-only check, and shows the reason", async () => {
    await runCheck({
      processed: 1, published: 0, skipped: 1, failed: 0,
      results: [{ item: "Synthetic post", success: false, platforms: [{ platform: "all", skipped: "Automation is paused" }] }],
    });
    expect(
      await screen.findByText("RSS check done: 0 published, 1 skipped, 0 failed (Automation is paused)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/new post\(s\) published/)).not.toBeInTheDocument();
  });

  it("reports a failed item with its error", async () => {
    await runCheck({
      processed: 1, published: 0, skipped: 0, failed: 1,
      results: [{ item: "Synthetic post", success: false, platforms: [{ platform: "facebook", success: false, error: "token expired" }] }],
    });
    expect(
      await screen.findByText("RSS check done: 0 published, 0 skipped, 1 failed (token expired)"),
    ).toBeInTheDocument();
  });

  it("reports mixed counts without a reason when something published", async () => {
    await runCheck({
      processed: 3, published: 1, skipped: 1, failed: 1,
      results: [{ item: "a", error: "boom" }],
    });
    expect(await screen.findByText("RSS check done: 1 published, 1 skipped, 1 failed")).toBeInTheDocument();
  });

  it("says no new items when nothing was attempted, and names a locked run", async () => {
    await runCheck({ processed: 0, published: 0, skipped: 0, failed: 0, results: [] });
    expect(await screen.findByText("RSS check done: no new items")).toBeInTheDocument();
    cleanup();
    await runCheck({ processed: 0, published: 0, skipped: 0, failed: 0, results: [], locked: true });
    expect(await screen.findByText("RSS check skipped: another RSS check is running")).toBeInTheDocument();
  });
});

describe("Analytics tab", () => {
  it("shows an error with retry on a 503, not the empty state", async () => {
    let calls = 0;
    routeFetch({
      "GET /admin/social-media/analytics": async () => {
        calls += 1;
        return calls === 1
          ? response({ error: "down" }, 503)
          : response({ byPlatform: { facebook: { total: 1, success: 1, failed: 0, skipped: 0 } }, summary: {} });
      },
    });
    renderTab("analytics");
    expect(await screen.findByText(/Analytics unavailable: HTTP 503/)).toBeInTheDocument();
    expect(screen.queryByText("No analytics data yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Performance by Platform")).toBeInTheDocument());
  });

  it("keeps the empty message for a successful empty response", async () => {
    routeFetch({ "GET /admin/social-media/analytics": async () => response(null) });
    renderTab("analytics");
    expect(await screen.findByText("No analytics data yet")).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  });

  it("shows the skipped count beside each platform's numbers", async () => {
    routeFetch({
      "GET /admin/social-media/analytics": async () => response({
        byPlatform: { linkedin: { total: 1, success: 0, failed: 0, skipped: 1 } },
        summary: {},
      }),
    });
    renderTab("analytics");
    expect(await screen.findByText("1 skipped")).toBeInTheDocument();
  });
});
