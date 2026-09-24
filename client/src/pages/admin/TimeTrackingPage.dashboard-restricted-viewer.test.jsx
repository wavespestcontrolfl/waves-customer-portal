// @vitest-environment jsdom
//
// codex round-1 P2 on PR #4673: admin-timetracking.js GET / drops job_count,
// total_job_minutes, revenue_generated and utilization_pct entirely for a
// technician (non-admin) caller, but this page's reduces defaulted each
// missing field to 0 and rendered it as a real metric ("$0 revenue",
// "0% utilization" for a coworker) instead of hiding it. The server now
// tags its response with `viewerRole`; this page hides the affected
// tiles/columns when it reads back "technician".
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardTab } from "./TimeTrackingPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE_RESPONSE = {
  activeShifts: [],
  todaySummaries: [
    { technician_id: "tech-1", tech_name: "Field Tech", work_date: "2026-09-23", total_shift_minutes: 480 },
  ],
  weekDailies: [
    { technician_id: "tech-1", tech_name: "Field Tech", work_date: "2026-09-23", total_shift_minutes: 480 },
  ],
  allTechs: [{ id: "tech-1", name: "Field Tech", role: "technician" }],
  today: "2026-09-23",
  weekStart: "2026-09-22",
};

function stubFetch(response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })),
  );
}

it("hides Jobs Done / Utilization (and the per-tech Jobs/Revenue/Utilization) for a technician (restricted) viewer", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  stubFetch({ ...BASE_RESPONSE, viewerRole: "technician" });
  render(<DashboardTab showToast={() => {}} />);

  await waitFor(() => expect(screen.getByText("Today's Labor")).toBeInTheDocument());

  // Aggregate "Today's Labor" stat cards — Revenue/Jobs Done/Utilization
  // all derive from fields the server never sent this viewer.
  expect(screen.getByText("Total Hours")).toBeInTheDocument();
  expect(screen.getByText("Labor Cost")).toBeInTheDocument();
  expect(screen.queryByText("Jobs Done")).not.toBeInTheDocument();
  expect(screen.queryByText("Utilization")).not.toBeInTheDocument();

  // Per-tech mini-card — Jobs/Revenue MiniStats and the utilization ring.
  expect(screen.queryByText("Jobs")).not.toBeInTheDocument();
  expect(screen.queryByText(/Utilization: \d+%/)).not.toBeInTheDocument();

  // "This Week" summary line drops its Revenue segment.
  expect(screen.queryByText(/Revenue:/)).not.toBeInTheDocument();
});

it("codex round-3 P2: shows the current job's service_type (not a blank 'Job: ') for a restricted viewer, whose currentJob has no customer name", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  stubFetch({
    ...BASE_RESPONSE,
    viewerRole: "technician",
    activeShifts: [
      { id: "shift-1", technician_id: "tech-1", tech_name: "Field Tech", clock_in: new Date().toISOString(), onBreak: false, currentJob: { service_type: "Quarterly Pest Control" } },
    ],
  });
  render(<DashboardTab showToast={() => {}} />);

  await waitFor(() => expect(screen.getByText("Today's Labor")).toBeInTheDocument());
  expect(screen.getByText(/Job: Quarterly Pest Control/)).toBeInTheDocument();
});

it("codex round-3 P2: hides the OT summary text and the bar chart's overtime split for a restricted viewer", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  stubFetch({
    ...BASE_RESPONSE,
    viewerRole: "technician",
    weekDailies: [{ ...BASE_RESPONSE.weekDailies[0], overtime_minutes: 120 }],
  });
  render(<DashboardTab showToast={() => {}} />);

  await waitFor(() => expect(screen.getByText("Today's Labor")).toBeInTheDocument());
  expect(screen.queryByText(/OT:/)).not.toBeInTheDocument();
});

it("control: an admin viewer sees the OT summary text", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  stubFetch({
    ...BASE_RESPONSE,
    viewerRole: "admin",
    weekDailies: [{ ...BASE_RESPONSE.weekDailies[0], overtime_minutes: 120 }],
  });
  render(<DashboardTab showToast={() => {}} />);

  await waitFor(() => expect(screen.getByText("Today's Labor")).toBeInTheDocument());
  expect(screen.getByText(/OT:/)).toBeInTheDocument();
});

it("control: an admin viewer still sees every tile (Revenue/Jobs Done/Utilization included)", async () => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  stubFetch({
    ...BASE_RESPONSE,
    viewerRole: "admin",
    todaySummaries: [{ ...BASE_RESPONSE.todaySummaries[0], job_count: 3, revenue_generated: 450, utilization_pct: 62 }],
  });
  render(<DashboardTab showToast={() => {}} />);

  await waitFor(() => expect(screen.getByText("Today's Labor")).toBeInTheDocument());
  expect(screen.getByText("Jobs Done")).toBeInTheDocument();
  expect(screen.getByText("Utilization")).toBeInTheDocument();
  expect(screen.getByText(/Utilization: \d+%/)).toBeInTheDocument();
});
