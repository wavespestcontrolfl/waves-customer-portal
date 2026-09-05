// @vitest-environment jsdom
// Control center (agent-control PR B): one read per (area, window, status)
// from the URL, server counts on the status chips (never the visible rows),
// lane cards with the server's numbers and a dash + reason for anything it
// cannot show, the attention list only on the attention filter, the basis
// notes, and the alert colour only where the server says attention.

import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("../../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));

import { adminFetch } from "../../../utils/admin-fetch";
import AgentControlCenterTab from "./AgentControlCenterTab";
import { metricCells } from "./LaneCard";

const AREAS = [
  { key: "sms", label: "SMS & messaging" },
  { key: "calls", label: "Calls" },
];

const spark7 = (calls) => ["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((t, i) => ({ t, calls: i === 6 ? calls : 0, errors: 0 }));

const lane = (over) => ({
  id: "sms_draft",
  name: "SMS reply draft",
  describe: "Drafts the reply to an inbound text",
  area: "sms",
  modelNow: "claude-sonnet-5",
  backup: "gpt-5.6-terra",
  continuity: "judged",
  maturity: "M3",
  riskTier: 2,
  sideEffectClass: "customer_visible",
  ledger: "call",
  unrecordableReason: null,
  status: "active",
  calls: 6,
  okRate: 0.667,
  fallbackRate: 0.5,
  p50LatencyMs: 700,
  p95LatencyMs: 9000,
  tokens: { input: 600, cachedInput: 0, cacheWrite: 33, output: 120, reasoning: 0, unknownRows: 0 },
  estCostUsd: null,
  lastActiveAt: "2026-09-04T21:00:00.000Z",
  deltaVsPrior: { calls: 5, okRate: -0.333 },
  attention: { p0: 0, p1: 0, p2: 0, p3: 0 },
  attentionReasons: [],
  spark: spark7(6),
  runs: null,
  cost: null,
  verification: null,
  ...over,
});

const PAYLOAD = {
  generatedAt: "2026-09-04T21:30:00.000Z",
  phases: { ledger: true, runs: false, cost: false, verification: false },
  basis: { source: "llm_dispatch_log", rowKinds: ["call", "session_turn"], workloads: ["live"], sessions: "per_turn", ledgerRecording: true, chainRecording: true, priorAvailable: true, window: { key: "7d", unit: "day" } },
  counts: { all: 3, active: 1, attention: 1, idle: 1 },
  lanes: [
    lane(),
    lane({ id: "sms_intent", name: "SMS intent", describe: "Classifies an inbound text", status: "attention", calls: 6, okRate: 0.5, attention: { p0: 0, p1: 1, p2: 0, p3: 0 }, attentionReasons: [{ priority: "P1", kind: "error_rate", detail: "3 of 6 calls failed in the last hour" }] }),
    lane({ id: "transcription", name: "Call transcription", describe: "Transcribes a recording", area: "calls", ledger: "unrecordable", unrecordableReason: "audio", status: "idle", calls: 0, okRate: null, fallbackRate: null, p50LatencyMs: null, p95LatencyMs: null, tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, unknownRows: 0 }, lastActiveAt: null, deltaVsPrior: { calls: 0, okRate: null }, spark: spark7(0), continuity: "unchecked" }),
  ],
};

function LocationSpy() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderTab(entry = "/admin/agents?tab=overview", props = {}) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/agents"
          element={
            <>
              <AgentControlCenterTab areas={AREAS} {...props} />
              <LocationSpy />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  adminFetch.mockReset();
  adminFetch.mockImplementation(async () => PAYLOAD);
});

describe("AgentControlCenterTab", () => {
  it("reads once per URL scope and renders the server counts, cards, and dashes with reasons", async () => {
    renderTab("/admin/agents?tab=overview&area=sms&window=today&status=attention");
    expect(await screen.findByText("SMS reply draft")).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledTimes(1);
    expect(adminFetch).toHaveBeenCalledWith("/admin/agents/control/lanes?window=today&status=attention&area=sms");

    // counts are the server's for the scope, not the rendered rows
    const strip = screen.getByRole("group", { name: "Lane status" });
    expect(within(strip).getByRole("button", { name: /^All/ })).toHaveTextContent("3");
    expect(within(strip).getByRole("button", { name: /Needs attention/ })).toHaveTextContent("1");
    expect(within(strip).getByRole("button", { name: /^Idle/ })).toHaveTextContent("1");

    // an active lane: numbers as sent, cost / verification dashed with the phase reason
    const card = screen.getByText("SMS reply draft").closest("[data-lane]");
    expect(card).toHaveAttribute("data-status", "active");
    expect(within(card).getByText("6")).toBeInTheDocument();
    expect(within(card).getByText("+5 vs prior")).toBeInTheDocument();
    expect(within(card).getByText("700 ms")).toBeInTheDocument();
    expect(within(card).getByText("p95 9.0 s")).toBeInTheDocument();
    expect(within(card).getByText("33%")).toBeInTheDocument();
    expect(within(card).getByText("fallback 50%")).toBeInTheDocument();
    expect(within(card).getByText("arrives with cost tracking")).toBeInTheDocument();
    expect(within(card).getAllByText("arrives with verification")).toHaveLength(2);
    expect(within(card).getByText(/Runs on/)).toHaveTextContent("Runs on claude-sonnet-5 · Backup gpt-5.6-terra · Judged");
    expect(within(card).getByRole("link", { name: /Runs/ })).toHaveAttribute("href", "/admin/agents?tab=activity");
    expect(within(card).queryByRole("list", { name: "Attention reasons" })).toBeNull();
    // scoped to one area: the calls-area lane is not grouped in
    expect(screen.queryByText("Call transcription")).toBeNull();
  });

  it("dashes every ledger metric of an unrecordable lane with the policy reason", async () => {
    renderTab("/admin/agents?tab=overview");
    const audio = (await screen.findByText("Call transcription")).closest("[data-lane]");
    expect(within(audio).getByText("audio — no per-call row")).toBeInTheDocument();
    expect(within(audio).getAllByText("not recorded")).toHaveLength(2);
    expect(within(audio).getByText("No activity in this window")).toBeInTheDocument();
    expect(within(audio).getByText(/Runs on/)).toHaveTextContent("Backup gpt-5.6-terra · Unchecked");
  });

  it("marks an attention lane with the server's reason, lists it in the attention section, and keeps red off the others", async () => {
    renderTab("/admin/agents?tab=overview&status=attention");
    await screen.findByRole("heading", { name: "Needs attention" });
    const card = document.querySelector('[data-lane="sms_intent"]');
    expect(card).toHaveAttribute("data-status", "attention");
    expect(card.className).toContain("border-l-alert-fg");
    expect(within(card).getByRole("list", { name: "Attention reasons" })).toHaveTextContent("3 of 6 calls failed in the last hour");
    const section = screen.getByRole("heading", { name: "Needs attention" }).closest("section");
    expect(within(section).getByText("SMS intent")).toBeInTheDocument();
    expect(within(section).queryByText("SMS reply draft")).toBeNull();
    // the active chip is the alert variant only here: attention, active, count > 0
    const strip = screen.getByRole("group", { name: "Lane status" });
    expect(within(strip).getByRole("button", { name: /Needs attention/ }).className).toContain("bg-alert-bg");
    expect(within(strip).getByRole("button", { name: /^All/ }).className).not.toContain("alert");
    expect(screen.getByText("SMS reply draft").closest("[data-lane]").className).not.toContain("alert");
  });

  it("does not render the attention section on other filters", async () => {
    renderTab("/admin/agents?tab=overview");
    await screen.findByText("SMS intent");
    expect(screen.queryByRole("heading", { name: "Needs attention" })).toBeNull();
  });

  it("lets only the newest scope's response paint: a slower earlier read never overwrites it", async () => {
    renderTab("/admin/agents?tab=overview");
    await screen.findByText("SMS reply draft");
    // the next read (Idle) hangs; the one after it (All) answers at once
    let resolveSlow;
    adminFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }));
    adminFetch.mockImplementationOnce(async () => ({ ...PAYLOAD, counts: { ...PAYLOAD.counts, all: 7 } }));
    fireEvent.click(screen.getByRole("button", { name: /^Idle/ }));
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    const summary = () => screen.getByText(/lanes ·/).textContent;
    await screen.findAllByText("7");
    expect(summary()).toContain("7 lanes");
    resolveSlow({ ...PAYLOAD, counts: { ...PAYLOAD.counts, all: 99 }, lanes: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(summary()).toContain("7 lanes");
    expect(screen.queryAllByText("99")).toHaveLength(0);
    expect(screen.getByText("SMS reply draft")).toBeInTheDocument();
  });

  it("never shows the previous scope's lanes under new controls: a slow or failed read leaves them cleared", async () => {
    renderTab("/admin/agents?tab=overview");
    await screen.findByText("SMS reply draft");
    let resolveSlow;
    adminFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: /^Idle/ }));
    // the "All" payload is gone at once; the controls stay so a second click needs no wait
    expect(screen.queryByText("SMS reply draft")).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Idle/ })).toBeInTheDocument();
    resolveSlow({ ...PAYLOAD, counts: { all: 1, active: 0, attention: 0, idle: 1 }, lanes: [PAYLOAD.lanes[2]] });
    await screen.findByText("Call transcription");
    expect(screen.queryByText("SMS reply draft")).not.toBeInTheDocument();
    // a failed read for the next scope shows the error, not the Idle lanes
    adminFetch.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "30D" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByText("Call transcription")).not.toBeInTheDocument();
    expect(screen.queryByText(/lanes ·/)).not.toBeInTheDocument();
  });

  it("writes ?status= and ?window= to the URL (defaults never litter it) and refetches", async () => {
    renderTab("/admin/agents?tab=overview");
    await screen.findByText("SMS reply draft");
    fireEvent.click(screen.getByRole("button", { name: /^Idle/ }));
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=overview&status=idle");
    fireEvent.click(screen.getByRole("button", { name: "30D" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=overview&status=idle&window=30d");
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.click(screen.getByRole("button", { name: "7D" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=overview");
    expect(adminFetch).toHaveBeenCalledWith("/admin/agents/control/lanes?window=7d&status=idle");
    expect(adminFetch).toHaveBeenCalledWith("/admin/agents/control/lanes?window=30d&status=idle");
    expect(adminFetch).toHaveBeenLastCalledWith("/admin/agents/control/lanes?window=7d&status=all");
  });

  it("explains the basis when a recorder is off or no prior window exists", async () => {
    adminFetch.mockImplementation(async () => ({
      ...PAYLOAD,
      basis: { ...PAYLOAD.basis, ledgerRecording: false, chainRecording: false, priorAvailable: false },
      lanes: [lane({ fallbackRate: null, deltaVsPrior: null })],
      counts: { all: 1, active: 1, attention: 0, idle: 0 },
    }));
    renderTab();
    const card = (await screen.findByText("SMS reply draft")).closest("[data-lane]");
    expect(screen.getByText(/The call ledger is not recording/)).toBeInTheDocument();
    expect(screen.getByText(/fallback rates are not available/)).toBeInTheDocument();
    expect(screen.getByText(/No prior window to compare with/)).toBeInTheDocument();
    expect(within(card).getByText("fallback — (chain recorder off)")).toBeInTheDocument();
    // never a cross-provider total: input and output, the two counts every provider agrees on
    expect(within(card).getByText("600 in · 120 out")).toBeInTheDocument();
  });

  it("registers the hub refresh handle and shows the fetch error", async () => {
    const setRefreshHandler = vi.fn();
    adminFetch.mockRejectedValueOnce(new Error("boom"));
    renderTab("/admin/agents?tab=overview", { setRefreshHandler });
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(setRefreshHandler).toHaveBeenCalledWith(expect.any(Function), expect.any(Boolean));
  });
});

describe("metricCells", () => {
  it("dashes with the honest reason for every missing number", () => {
    const cells = metricCells(lane({ calls: 0, okRate: null, p50LatencyMs: null, p95LatencyMs: null, tokens: null, deltaVsPrior: null }), { chainRecording: true });
    expect(cells.map((c) => c.label)).toEqual(["Calls", "Cost", "Duration", "Errors", "Corrections", "Verified"]);
    expect(cells[0]).toEqual({ label: "Calls", value: "0", sub: null });
    expect(cells[2].reason).toBe("no calls in window");
    expect(cells[3].reason).toBe("no calls in window");
    const unknown = metricCells(lane({ calls: 2, okRate: null, tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, unknownRows: 2 }, deltaVsPrior: null }), {});
    expect(unknown[0].sub).toBe("2 without usage");
    expect(unknown[3].reason).toBe("no outcome recorded");
  });
});
