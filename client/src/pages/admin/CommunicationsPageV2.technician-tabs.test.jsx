// @vitest-environment jsdom
// Technician allow-list (owner 2026-10-02): a technician keeps SMS and
// Promises in Communications. Automations (notification-events) and Triage are
// owner-only, and there is no call bridge ("Call back") for a technician.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));

import CommunicationsPageV2 from "./CommunicationsPageV2";

const line = "+19415550199";
const MESSAGES = [
  { id: "m1", conversationId: "conv1", from: "+15557654321", to: line, channel: "sms", direction: "inbound", body: "Synthetic customer text", createdAt: "2024-01-01T12:00:00Z", isRead: false },
];

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const data = path.endsWith("/log") ? { messages: MESSAGES } : path.endsWith("/blocked-numbers") ? { numbers: [] } : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount(role, entry = "/admin/communications") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Outlet context={{ user: { id: `${role}-1`, role } }} />}>
          <Route path="/admin/communications" element={<CommunicationsPageV2 />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Communications tabs by role", () => {
  it("hides Automations and Triage from a technician, who keeps SMS and Promises", async () => {
    mount("technician");
    await screen.findByText("Synthetic customer text");
    expect(screen.queryByRole("button", { name: /Automations/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Triage/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^SMS/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Promises/ })).toBeInTheDocument();
  });

  it("resolves a technician's #tab=events / #tab=triage deep link to SMS without fetching either route", async () => {
    mount("technician", "/admin/communications#tab=triage");
    await screen.findByText("Synthetic customer text");
    cleanup();
    mount("technician", "/admin/communications#tab=events");
    await screen.findByText("Synthetic customer text");
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("/admin/triage"))).toBe(false);
    expect(urls.some((url) => url.includes("/admin/notification-events"))).toBe(false);
  });

  it("keeps Automations and Triage for an admin", async () => {
    mount("admin");
    await screen.findByText("Synthetic customer text");
    expect(screen.getByRole("button", { name: /Automations/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Triage/ })).toBeInTheDocument();
  });
});

describe("Call back in a text thread", () => {
  async function openThread(role) {
    mount(role);
    fireEvent.click(await screen.findByText("Synthetic customer text"));
    expect(await screen.findByRole("button", { name: /Back/ })).toBeInTheDocument();
  }

  it("is not offered to a technician", async () => {
    await openThread("technician");
    expect(screen.queryByRole("button", { name: /Call back/ })).not.toBeInTheDocument();
  });

  it("is offered to an admin", async () => {
    await openThread("admin");
    expect(screen.getByRole("button", { name: /Call back/ })).toBeInTheDocument();
  });
});
