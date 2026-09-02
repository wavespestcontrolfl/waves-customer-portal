// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();
vi.mock("../../utils/admin-fetch", () => ({ adminFetch: (...args) => adminFetch(...args) }));

import AgentActivityTab from "./AgentActivityTab";

const FEED = {
  available: true,
  windowHours: 24,
  agents: ["Blog Content Engine", "System"],
  summary: { total: 2, running: 0, awaiting_review: 1, blocked: 0, failed: 1, completed: 0, skipped: 0 },
  items: [
    {
      id: "run:1",
      kind: "content_run",
      agent: "Blog Content Engine",
      title: "How to Get Rid of Ghost Ants",
      subtitle: "new post · blog",
      status: "awaiting_review",
      startedAt: "2026-09-02T10:00:00Z",
      finishedAt: "2026-09-02T10:04:00Z",
      durationMs: 239000,
      steps: [
        { key: "claim", label: "Claim opportunity", status: "done", detail: null, ms: 120 },
        { key: "quality_gate", label: "Quality gate", status: "done", detail: null, ms: 40000 },
        { key: "publish", label: "Publish", status: "not_started", detail: null, ms: null },
      ],
      stepsDone: 2,
      stepsTotal: 3,
      link: "/admin/blog?tab=autopilot",
      detail: "Awaiting emailed reply (EA-12ab34cd)",
    },
    {
      id: "job:impact_verdict_digest",
      kind: "job",
      agent: "System",
      title: "impact verdict digest",
      subtitle: "3 consecutive failures",
      status: "failed",
      startedAt: "2026-09-02T08:00:00Z",
      finishedAt: "2026-09-02T08:00:01Z",
      durationMs: 1000,
      steps: [],
      stepsDone: 0,
      stepsTotal: 1,
      link: null,
      detail: "ECONNRESET",
    },
  ],
};

function renderTab() {
  return render(
    <MemoryRouter>
      <AgentActivityTab />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  adminFetch.mockReset();
});

describe("AgentActivityTab", () => {
  it("explains itself while the gate is off", async () => {
    adminFetch.mockResolvedValue({ available: false, items: [], agents: [], summary: { total: 0 } });
    renderTab();
    expect(await screen.findByText(/not enabled on this deployment/)).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith("/admin/agents/activity?hours=24");
  });

  it("renders rows with status chips, a Review link for awaiting items, and expandable steps", async () => {
    adminFetch.mockResolvedValue(FEED);
    renderTab();
    expect(await screen.findByText("How to Get Rid of Ghost Ants")).toBeInTheDocument();
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    // Review link (desktop + mobile variants both point at the review tab)
    const reviewLinks = screen.getAllByRole("link", { name: "Review" });
    expect(reviewLinks.length).toBeGreaterThan(0);
    expect(reviewLinks[0]).toHaveAttribute("href", "/admin/blog?tab=autopilot");
    // Steps hidden until expanded
    expect(screen.queryByText("Quality gate")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Expand" })[0]);
    expect(screen.getByText("Quality gate")).toBeInTheDocument();
    expect(screen.getByText("Awaiting emailed reply (EA-12ab34cd)")).toBeInTheDocument();
  });

  it("ignores a slower, superseded window response", async () => {
    let resolveFirst;
    adminFetch.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    adminFetch.mockResolvedValueOnce({ ...FEED, items: [FEED.items[1]], summary: { ...FEED.summary, total: 1 } });
    renderTab();
    fireEvent.change(screen.getByLabelText(/Window/), { target: { value: "168" } });
    expect(await screen.findByText("impact verdict digest")).toBeInTheDocument();
    // the stale 24h response lands late and must not replace the 7d rows
    resolveFirst(FEED);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("How to Get Rid of Ghost Ants")).not.toBeInTheDocument();
  });

  it("filters by status client-side and refetches when the window changes", async () => {
    adminFetch.mockResolvedValue(FEED);
    renderTab();
    await screen.findByText("How to Get Rid of Ghost Ants");
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: "failed" } });
    expect(screen.queryByText("How to Get Rid of Ghost Ants")).not.toBeInTheDocument();
    expect(screen.getByText("impact verdict digest")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Window/), { target: { value: "168" } });
    await waitFor(() => expect(adminFetch).toHaveBeenLastCalledWith("/admin/agents/activity?hours=168"));
  });
});
