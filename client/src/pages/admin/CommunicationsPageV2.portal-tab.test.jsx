// @vitest-environment jsdom
// Portal tab (GATE_PORTAL_INBOX, owner 2026-10-31): the tab shows only when the
// owner's one-time summary read says enabled, with the open count in its label.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));

import CommunicationsPageV2 from "./CommunicationsPageV2";

let summary;
beforeEach(() => {
  summary = { enabled: true, count: 5 };
  localStorage.setItem("waves_admin_token", "synthetic-token");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = new URL(String(url), "http://localhost").pathname;
    let data = {};
    if (path.endsWith("/log")) data = { messages: [{ id: "m1", conversationId: "conv1", from: "+15557654321", to: "+19415550199", channel: "sms", direction: "inbound", body: "Synthetic customer text", createdAt: "2024-01-01T12:00:00Z", isRead: false }] };
    else if (path.endsWith("/blocked-numbers")) data = { numbers: [] };
    else if (path.endsWith("/admin/portal-inbox/summary")) data = summary;
    else if (path.endsWith("/admin/portal-inbox")) data = { enabled: true, cutoff: "2026-10-17T12:00:00.000Z", items: [], older: { chats: 0, requests: 0 } };
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

const summaryCalls = () => fetch.mock.calls.filter(([url]) => String(url).includes("/admin/portal-inbox/summary"));

describe("Communications Portal tab", () => {
  it("is hidden when the summary says the gate is off", async () => {
    summary = { enabled: false };
    mount("admin");
    await screen.findByText("Synthetic customer text");
    await waitFor(() => expect(summaryCalls()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /^Portal/ })).not.toBeInTheDocument();
  });

  it("shows with the open count in its label, right after Triage, when the gate is on", async () => {
    mount("admin");
    const tab = await screen.findByRole("button", { name: "Portal (5)" });
    expect(tab.previousElementSibling).toHaveTextContent("Triage");
    expect(summaryCalls()).toHaveLength(1);
  });

  it("lands on the Portal tab from a #tab=portal deep link once the summary arrives, and the label follows the list", async () => {
    // MemoryRouter does not write window.location, which the page's hash sync reads.
    window.location.hash = "#tab=portal";
    mount("admin", "/admin/communications#tab=portal");
    expect(await screen.findByText(/Nothing open/)).toBeInTheDocument();
    // The list holds no open items, so the label count follows it down to zero.
    expect(await screen.findByRole("button", { name: "Portal" })).toBeInTheDocument();
    window.location.hash = "";
  });

  it("is never requested for a technician", async () => {
    mount("technician");
    await screen.findByText("Synthetic customer text");
    expect(summaryCalls()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Portal/ })).not.toBeInTheDocument();
  });

  it("stays hidden when the summary cannot be read", async () => {
    fetch.mockImplementation(async (url) => {
      const path = new URL(String(url), "http://localhost").pathname;
      if (path.endsWith("/admin/portal-inbox/summary")) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(path.endsWith("/log") ? { messages: [] } : {}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    mount("admin");
    await waitFor(() => expect(summaryCalls()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /^Portal/ })).not.toBeInTheDocument();
  });
});
