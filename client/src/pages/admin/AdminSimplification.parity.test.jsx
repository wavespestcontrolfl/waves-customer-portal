// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";
import ToolHealthPage from "./ToolHealthPage";
import IntegrationHealthSection from "../../components/admin/IntegrationHealthSection";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../../lib/adminUsage", () => ({ trackAdminPageView: vi.fn() }));

const runtime = {
  overallStatus: "critical", generatedAt: new Date().toISOString(),
  summary: { total: 20, failed: 2, errorRate: 0.1, circuitOpenCount: 1 },
  agents: [], contexts: [], recentErrors: [],
  alerts: [{ severity: "critical", title: "Synthetic runtime failure", detail: "Inspect the existing agent run" }],
};
const catalog = { integrations: [{ id: "fixture-provider", name: "Synthetic provider", category: "Messaging",
  description: "Fixture only", health: { status: "expired", label: "Expired", reason: "Credential needs attention" } }] };
let role;
let pending;
let failure;
let healthOffline;
beforeEach(() => {
  role = "admin"; pending = null; failure = null; healthOffline = false;
  vi.stubGlobal("localStorage", { getItem: () => "fixture-token" });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (healthOffline && url === "/api/health") throw new Error("Fixture health endpoint offline");
    if (pending && url.includes(pending)) return new Promise(() => {});
    if (failure && url.includes(failure)) return { ok: false, status: 503, json: async () => ({ error: "Fixture unavailable" }) };
    const data = url.includes("/auth/me") ? { id: "fixture-user", name: "Fixture operator", email: "operator@example.invalid", role }
      : url.includes("/tool-health?") ? runtime
        : url.includes("/integrations/health") ? catalog
          : url.endsWith("/health") ? { gates: {} }
            : url.includes("/gbp/locations") ? { locations: [] } : {};
    return { ok: true, status: 200, json: async () => data };
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = (component, entry = "/admin/settings?tab=general") => render(<MemoryRouter initialEntries={[entry]}>{component}</MemoryRouter>);

describe("preserved Settings and diagnostic capabilities", () => {
  it.each(["admin", "technician"])("keeps the signed-in %s identity at the old Team link and Account", async (userRole) => {
    role = userRole;
    mount(<SettingsPage />, "/admin/settings?tab=team&source=bookmark#profile");
    expect(await screen.findByText("Fixture operator")).toBeInTheDocument();
    expect(screen.getByText(/operator@example.invalid/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(userRole))).toBeInTheDocument();
    expect(screen.getByText("Logged In As")).toBeInTheDocument();
    expect(screen.queryByText("Team Members")).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/auth/me"))).toHaveLength(1);
    cleanup();
    mount(<SettingsPage />);
    expect(await screen.findByText("Logged In As")).toBeInTheDocument();
    expect(screen.getByText("Fixture operator")).toBeInTheDocument();
  });

  it("retains cached credential detail and executes one requested check followed by one reload", async () => {
    mount(<IntegrationHealthSection />);
    expect(await screen.findByText("Synthetic provider")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByText("Credential needs attention")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh checks" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh checks" })).toBeEnabled());
    expect(fetch.mock.calls.filter(([url, opts]) => url.endsWith("/token-health/check") && opts.method === "POST")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/integrations/health"))).toHaveLength(2);
  });

  it("keeps the old Team identity available when the separate health endpoint is offline", async () => {
    healthOffline = true;
    mount(<SettingsPage />, "/admin/settings?tab=team");
    expect(await screen.findByText("Fixture operator")).toBeInTheDocument();
    expect(screen.getByText(/operator@example.invalid/)).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/auth/me"))).toHaveLength(1);
  });

  it("does not display a previous identity or credential configuration when the profile read fails", async () => {
    failure = "/auth/me";
    mount(<SettingsPage />, "/admin/settings?tab=team");
    expect(await screen.findByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Fixture operator")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Integrations", exact: true })).not.toBeInTheDocument();
  });

  it("shows loading and failed catalog reads instead of a successful empty catalog", async () => {
    pending = "/integrations/health";
    mount(<IntegrationHealthSection />);
    expect(screen.getByText("Loading integrations...")).toBeInTheDocument();
    cleanup(); pending = null; failure = "/integrations/health";
    mount(<IntegrationHealthSection />);
    expect(await screen.findByText(/Failed to load integrations: HTTP 503/)).toBeInTheDocument();
    expect(screen.queryByText("Synthetic provider")).not.toBeInTheDocument();
  });

  it("keeps runtime alerts, time windows, refresh and polling cleanup", async () => {
    mount(<ToolHealthPage />);
    expect(await screen.findByText("Synthetic runtime failure")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings → Integrations" })).toHaveAttribute("href", "/admin/settings?tab=integrations");
    expect(fetch.mock.calls.some(([url]) => url.includes("/integrations/health"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("tool-health?hours=1"))).toBe(true));
    const before = fetch.mock.calls.filter(([url]) => url.endsWith("tool-health?hours=1")).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith("tool-health?hours=1"))).toHaveLength(before + 1));
    cleanup();
    vi.useFakeTimers();
    const view = mount(<ToolHealthPage />);
    await act(async () => {});
    const initial = fetch.mock.calls.filter(([url]) => url.includes("/tool-health?")).length;
    await act(async () => vi.advanceTimersByTime(30000));
    expect(fetch.mock.calls.filter(([url]) => url.includes("/tool-health?"))).toHaveLength(initial + 1);
    view.unmount();
    await act(async () => vi.advanceTimersByTime(60000));
    expect(fetch.mock.calls.filter(([url]) => url.includes("/tool-health?"))).toHaveLength(initial + 1);
  });

  it("keeps a failed runtime read visible with its retry action", async () => {
    failure = "/tool-health?";
    mount(<ToolHealthPage />);
    expect(await screen.findByText("Failed to load: HTTP 503")).toBeInTheDocument();
    failure = null;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Synthetic runtime failure")).toBeInTheDocument();
  });

  it("does not load credential configuration for a technician deep link", async () => {
    role = "technician";
    mount(<SettingsPage />, "/admin/settings?tab=integrations");
    expect(await screen.findByText("Logged In As")).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => url.includes("/integrations/health"))).toBe(false);
  });
});
