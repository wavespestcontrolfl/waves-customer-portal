// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToolHealthPage from "./ToolHealthPage";

const runtime = {
  overallStatus: "critical",
  generatedAt: new Date().toISOString(),
  summary: {
    total: 32,
    failed: 3,
    errorRate: 0.09375,
    circuitOpenCount: 1,
    avgDurationMs: 184,
  },
  pdfRenderer: {
    successRate: 0.98,
    succeeded: 49,
    terminalFailed: 1,
    p95LatencyMs: 930,
  },
  agents: [
    { source: "primary", label: "Primary agent", status: "critical", total: 20, failed: 3, avgDurationMs: 220, lastCallAt: new Date().toISOString() },
    { source: "fast", label: "Fast agent", status: "ok", total: 12, failed: 0, avgDurationMs: 85, lastCallAt: new Date().toISOString() },
  ],
  contexts: [
    {
      context: "customer-support",
      toolsUsed: 2,
      total: 12,
      failed: 3,
      errorRate: 0.25,
      tools: [
        { toolName: "lookup_customer", source: "primary", total: 10, failed: 1, errorRate: 0.1, avgDurationMs: 140 },
        { toolName: "create_followup", source: "primary", total: 2, failed: 2, errorRate: 1, avgDurationMs: 410 },
      ],
    },
    {
      context: "scheduling",
      toolsUsed: 1,
      total: 8,
      failed: 0,
      errorRate: 0,
      tools: [
        { toolName: "find_slots", source: "fast", total: 8, failed: 0, errorRate: 0, avgDurationMs: 72 },
      ],
    },
  ],
  recentErrors: [
    {
      id: "error-1",
      at: new Date().toISOString(),
      toolName: "create_followup",
      context: "customer-support",
      circuitOpen: true,
      errorMessage: "Synthetic long tool failure. ".repeat(8),
    },
  ],
  alerts: [
    { severity: "critical", title: "Circuit breaker open", detail: "Primary calls require attention." },
    { severity: "warning", title: "Latency elevated", detail: "Fast calls remain available." },
  ],
};

let profileRole;

beforeEach(() => {
  profileRole = "admin";
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token" });
  vi.stubGlobal("fetch", vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => url.endsWith("/admin/auth/me")
      ? { id: "operator-1", role: profileRole }
      : runtime,
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <MemoryRouter initialEntries={["/admin/tool-health"]}>
      <ToolHealthPage />
    </MemoryRouter>,
  );
}

describe("ToolHealthPage foundation migration", () => {
  it("renders the complete runtime in the comfortable workspace foundation", async () => {
    const { container } = mount();

    expect(await screen.findByRole("heading", { level: 1, name: "Tool health" })).toBeInTheDocument();
    expect(container.querySelector('[data-ui-density="comfortable"]')).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Tool health section" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("PDF render success rate")).toBeInTheDocument();
    expect(screen.getByText("Circuit breaker open")).toBeInTheDocument();
    expect(screen.getByText("Primary agent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings → Integrations" })).toHaveAttribute(
      "href",
      "/admin/settings?tab=integrations",
    );
    expect(container.querySelector("[style]")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/admin/tool-health?hours=24",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer synthetic-token" }),
        }),
      );
      expect(fetch).toHaveBeenCalledWith("/api/admin/auth/me", expect.any(Object));
    });
  });

  it("keeps automatic context expansion and both expandable row interactions", async () => {
    mount();
    await screen.findByRole("heading", { name: "Recent errors" });
    const failedContext = document.querySelector('[aria-controls="tool-context-0"]');
    const healthyContext = document.querySelector('[aria-controls="tool-context-1"]');

    expect(failedContext).toHaveAttribute("aria-expanded", "true");
    expect(healthyContext).toHaveAttribute("aria-expanded", "false");
    const table = screen.getByRole("table", { name: "customer-support tool health" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByText("create_followup")).toBeInTheDocument();

    fireEvent.click(failedContext);
    expect(screen.queryByRole("table", { name: "customer-support tool health" })).not.toBeInTheDocument();
    fireEvent.click(healthyContext);
    expect(screen.getByRole("table", { name: "scheduling tool health" })).toBeInTheDocument();

    const errorRow = screen.getByRole("button", { name: /Synthetic long tool failure/ });
    expect(errorRow).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(errorRow);
    expect(errorRow).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the owner-only integrations link hidden for a technician profile", async () => {
    profileRole = "technician";
    mount();
    await screen.findByRole("heading", { name: "Recent errors" });
    expect(screen.queryByRole("link", { name: "Settings → Integrations" })).not.toBeInTheDocument();
  });
});
