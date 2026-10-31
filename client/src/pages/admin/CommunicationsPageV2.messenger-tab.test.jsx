// @vitest-environment jsdom
// Messenger tab (GATE_MESSENGER_INBOX, owner 2026-10-31): the tab shows only when
// the one-time summary read says enabled, for any staff role, with the count of
// threads waiting for an answer in its label.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));

import CommunicationsPageV2 from "./CommunicationsPageV2";

let messengerSummary;
let portalSummary;
beforeEach(() => {
  messengerSummary = { enabled: true, unanswered: 3 };
  portalSummary = { enabled: false };
  localStorage.setItem("waves_admin_token", "synthetic-token");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = new URL(String(url), "http://localhost").pathname;
    let data = {};
    if (path.endsWith("/log")) data = { messages: [{ id: "m1", conversationId: "conv1", from: "+15557654321", to: "+19415550199", channel: "sms", direction: "inbound", body: "Synthetic customer text", createdAt: "2024-01-01T12:00:00Z", isRead: false }] };
    else if (path.endsWith("/blocked-numbers")) data = { numbers: [] };
    else if (path.endsWith("/admin/messenger/summary")) {
      if (messengerSummary === null) return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } });
      data = messengerSummary;
    }
    else if (path.endsWith("/admin/messenger/threads")) data = { enabled: true, threads: [] };
    else if (path.endsWith("/admin/portal-inbox/summary")) data = portalSummary;
    else if (path.endsWith("/admin/portal-inbox")) data = { enabled: true, cutoff: "2026-10-17T12:00:00.000Z", items: [], older: { chats: 0, requests: 0 } };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
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

const summaryCalls = () => fetch.mock.calls.filter(([url]) => String(url).includes("/admin/messenger/summary"));

describe("Communications Messenger tab", () => {
  it("is hidden when the summary says the gate is off", async () => {
    messengerSummary = { enabled: false };
    mount("admin");
    await screen.findByText("Synthetic customer text");
    await waitFor(() => expect(summaryCalls()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /^Messenger/ })).not.toBeInTheDocument();
  });

  it("is hidden when the summary cannot be read", async () => {
    messengerSummary = null;
    mount("admin");
    await screen.findByText("Synthetic customer text");
    await waitFor(() => expect(summaryCalls()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /^Messenger/ })).not.toBeInTheDocument();
  });

  it("shows with the waiting count in its label, right after Triage, when the Portal tab is off", async () => {
    mount("admin");
    const tab = await screen.findByRole("button", { name: "Messenger (3)" });
    expect(tab.previousElementSibling).toHaveTextContent("Triage");
    expect(summaryCalls()).toHaveLength(1);
  });

  it("sits right after the Portal tab when that is on", async () => {
    portalSummary = { enabled: true, count: 5 };
    mount("admin");
    const tab = await screen.findByRole("button", { name: "Messenger (3)" });
    expect(tab.previousElementSibling).toHaveTextContent("Portal (5)");
  });

  it("drops the count from the label when nothing waits", async () => {
    messengerSummary = { enabled: true, unanswered: 0 };
    mount("admin");
    expect(await screen.findByRole("button", { name: "Messenger" })).toBeInTheDocument();
  });

  it("shows for a technician too, right after SMS", async () => {
    mount("technician");
    const tab = await screen.findByRole("button", { name: "Messenger (3)" });
    expect(tab.previousElementSibling).toHaveTextContent("SMS");
  });

  it("lands on the Messenger tab from a #tab=messenger deep link once the summary arrives", async () => {
    // MemoryRouter does not write window.location, which the page's hash sync reads.
    window.location.hash = "#tab=messenger";
    mount("admin", "/admin/communications#tab=messenger");
    expect(await screen.findByText("No Facebook messages yet.")).toBeInTheDocument();
  });
});
