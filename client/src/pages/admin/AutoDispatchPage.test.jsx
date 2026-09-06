// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));
import { adminFetch } from "../../utils/admin-fetch";
import AutoDispatchPage from "./AutoDispatchPage";

const config = { mode: "apply", applyAllowed: true, lockWindowDays: 14, lookaheadDays: 90, maxChangesPerRun: 100, routeTiersEnabled: true };
const run = { id: "run-1", mode: "apply", status: "running", started_at: "2026-09-05T08:10:00Z", total_evaluated: 1, total_changed: 1, total_recommended: 0, total_skipped: 0, total_failed: 0, config_snapshot: config };
const decision = { id: "decision-1", scheduled_service_id: "visit-1", current_visit_id: "visit-1", current_scheduled_date: "2026-09-24", customer_id: "customer-1", customer_first_name: "Sample", customer_last_name: "Customer", service_type: "Pest control", action: "changed", reason_description: "Original decision", old_scheduled_date: "2026-09-20", new_scheduled_date: "2026-09-21", auto_dispatch_locked: false, auto_dispatch_excluded: false };
let detail;
let automation;
function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="url">{location.search}</output><button onClick={() => navigate("?tab=dispatch&run=run-2")}>Other run</button></>;
}
function mount(entry = "/admin/agents?tab=dispatch&run=run-1&source=alert") {
  return render(<MemoryRouter initialEntries={[entry]}><AutoDispatchPage embedded /><Probe /></MemoryRouter>);
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  detail = { run: { ...run }, logs: [{ ...decision }] };
  automation = { scheduledEnabled: true, config };
  adminFetch.mockReset();
  adminFetch.mockImplementation(async (path) => {
    if (path.includes("runs?")) return { runs: [detail.run], automation };
    return structuredClone(detail);
  });
});
afterEach(cleanup);

it("opens a requested run and links the named appointment to its CURRENT date", async () => {
  mount();
  expect(await screen.findByText("Original decision")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sample Customer" })).toHaveAttribute("href", "/admin/customers?customerId=customer-1");
  expect(screen.getByRole("link", { name: /Open appointment/ })).toHaveAttribute("href", "/admin/dispatch?tab=schedule&date=2026-09-24&appointment=visit-1");
  expect(screen.getAllByText(/evaluates visits from 7 days out/)[0]).toBeVisible();
});

it("refreshes selected decisions as well as the list when a running run completes", async () => {
  mount();
  await screen.findByText("Original decision");
  detail = { run: { ...run, status: "completed" }, logs: [{ ...decision, reason_description: "Final decision" }] };
  fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  expect(await screen.findByText("Final decision")).toBeInTheDocument();
  expect(screen.queryByText("Original decision")).not.toBeInTheDocument();
});

it("shows a retryable detail error instead of claiming there are no decisions", async () => {
  adminFetch.mockImplementation(async (path) => {
    if (path.includes("runs?")) return { runs: [run], automation };
    throw new Error("Decision service unavailable");
  });
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Decision service unavailable");
  expect(screen.queryByText(/No decision rows/)).not.toBeInTheDocument();
  adminFetch.mockImplementation(async (path) => path.includes("runs?") ? { runs: [run], automation } : detail);
  fireEvent.click(screen.getByRole("button", { name: "Retry decisions" }));
  expect(await screen.findByText("Original decision")).toBeInTheDocument();
});

it("shows the fatal run error even if no decision rows exist", async () => {
  detail = { run: { ...run, status: "failed", error_message: "Capability read failed" }, logs: [] };
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Capability read failed");
  expect(screen.getByText(/No decision rows were recorded/)).toBeInTheDocument();
});

it("selects a failed manual run and surfaces its unsuccessful outcome", async () => {
  const get = adminFetch.getMockImplementation();
  adminFetch.mockImplementation(async (path, options) => options?.method === "POST"
    ? { ok: false, status: "failed", runId: "run-failed" } : get(path));
  mount();
  await screen.findByText("Original decision");
  fireEvent.click(screen.getByRole("button", { name: "Run dry-run" }));
  await waitFor(() => expect(screen.getByTestId("url")).toHaveTextContent("run=run-failed"));
  expect(screen.getByTestId("url")).toHaveTextContent("source=alert");
  expect(screen.getByRole("alert")).toHaveTextContent("Dry-run failed");
  expect(adminFetch).toHaveBeenCalledWith("/admin/auto-dispatch/run", { method: "POST", body: '{"mode":"dry_run"}' });
});

it("ignores a late detail response from the previously selected run", async () => {
  const slow = deferred();
  const get = adminFetch.getMockImplementation();
  adminFetch.mockImplementation((path) => path.endsWith("/run-1") ? slow.promise : get(path));
  mount();
  detail = { run: { ...run, id: "run-2" }, logs: [{ ...decision, reason_description: "Second run decision" }] };
  fireEvent.click(screen.getByRole("button", { name: "Other run" }));
  await screen.findByText("Second run decision");
  await act(async () => slow.resolve({ run, logs: [decision] }));
  expect(screen.queryByText("Original decision")).not.toBeInTheDocument();
});

it("updates visit protection through the existing endpoint and reloads authoritative state", async () => {
  const get = adminFetch.getMockImplementation();
  adminFetch.mockImplementation(async (path, options) => {
    if (options?.method === "PATCH") {
      detail.logs[0].auto_dispatch_locked = true;
      return { ok: true };
    }
    return get(path);
  });
  mount();
  await screen.findByText("Original decision");
  fireEvent.click(screen.getByText("Decision details and visit controls"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Lock this visit from automation" }));
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/auto-dispatch/services/visit-1/lock", { method: "PATCH", body: '{"locked":true}' }));
  await screen.findByText("Original decision");
  fireEvent.click(screen.getByText("Decision details and visit controls"));
  expect(screen.getByRole("checkbox", { name: "Lock this visit from automation" })).toBeChecked();
});

it("does not infer current operation from an old apply run when status cannot load", async () => {
  automation = null;
  mount();
  expect(await screen.findByText("Current operating status unavailable.")).toBeInTheDocument();
  expect(screen.getByText(/may use Google geocoding/)).toBeInTheDocument();
});
