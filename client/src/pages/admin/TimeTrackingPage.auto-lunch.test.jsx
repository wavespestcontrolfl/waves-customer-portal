// @vitest-environment jsdom
//
// No unpaid lunch (owner 2026-11-22: every clocked minute is paid) on the admin
// time pages. The pages still read a stored unpaid meal off older rows: totals
// and labor cost use paid minutes, and each day shows the lunch taken off and a
// "no lunch" marker. With no lunch on the rows every figure is the shift
// figure, and the timesheet has no control to set or clear No lunch.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalsTab } from "./staff/ApprovalsTab";
import { DashboardTab } from "./staff/DashboardTab";
import { TimesheetTab } from "./staff/TimesheetTab";

// Wednesday 2026-10-28, 11:00 ET: this week starts Monday 2026-10-26.
const NOW = new Date("2026-10-28T15:00:00Z");

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

function day(extra) {
  return {
    id: 1,
    technician_id: "tech-1",
    tech_name: "Field Tech",
    work_date: "2026-10-26",
    total_shift_minutes: "630.00",
    total_job_minutes: "400.00",
    overtime_minutes: "0.00",
    job_count: 5,
    revenue_generated: "800.00",
    utilization_pct: "63.00",
    status: "pending",
    ...extra,
  };
}

const TECH = { id: "tech-1", name: "Field Tech", role: "technician", pay_rate: "20" };

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("dashboard totals use paid minutes", () => {
  const dashboard = (rows) => ({
    viewerRole: "admin",
    activeShifts: [],
    todaySummaries: rows,
    weekDailies: rows,
    allTechs: [TECH],
    today: "2026-10-28",
    weekStart: "2026-10-26",
  });
  const mount = async (rows) => {
    vi.stubGlobal("fetch", vi.fn(async () => json(dashboard(rows))));
    render(<DashboardTab showToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Today's Labor")).toBeInTheDocument());
  };

  it("takes the unpaid lunch off Total Hours and Labor Cost", async () => {
    await mount([day({ work_date: "2026-10-28", unpaid_meal_minutes: "30.00" })]);
    // 630 shift - 30 unpaid = 600 min = 10.0 h at $20 = $200.00
    expect(screen.getByText("Total Hours").parentElement).toHaveTextContent("10.0h");
    expect(screen.getByText("Labor Cost").parentElement).toHaveTextContent("$200.00");
  });

  it("is exactly the shift figures when no lunch is on the row", async () => {
    await mount([day({ work_date: "2026-10-28" })]);
    expect(screen.getByText("Total Hours").parentElement).toHaveTextContent("10.5h");
    expect(screen.getByText("Labor Cost").parentElement).toHaveTextContent("$210.00");
  });
});

describe("timesheet tab", () => {
  function stubTimesheet({ rows, entries = [] }) {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      calls.push([String(url), options]);
      const u = String(url);
      if (u.includes("/admin/timetracking/daily")) return json(rows);
      if (u.includes("/admin/timetracking/entries")) return json({ entries });
      return json({ allTechs: [TECH] });
    }));
    return calls;
  }
  const mount = async () => {
    render(<TimesheetTab showToast={() => {}} onOpenApprovals={() => {}} />);
    await waitFor(() => expect(screen.getByText("Field Tech")).toBeInTheDocument());
  };

  it("shows the paid hours of a stored lunch, and a no lunch marker", async () => {
    stubTimesheet({
      rows: [
        day({ unpaid_meal_minutes: "30.00" }),
        day({ id: 2, work_date: "2026-10-27", unpaid_meal_minutes: "0.00", no_lunch: true }),
      ],
    });
    await mount();
    expect(screen.getByText("10.0")).toBeInTheDocument();
    expect(screen.getByText("lunch -0.5")).toBeInTheDocument();
    expect(screen.getByText("no lunch")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    // week total = 10.0 paid + 10.5 no-lunch day
    expect(screen.getByText("20.5")).toBeInTheDocument();
  });

  it("is exactly the shift hours when no lunch is on the row, with no lunch controls", async () => {
    stubTimesheet({ rows: [day()] });
    await mount();
    expect(screen.getAllByText("10.5").length).toBeGreaterThan(0);
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.queryByText(/lunch/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByText("10.5")[0]);
    await waitFor(() => expect(screen.getByText("Entries for 2026-10-26")).toBeInTheDocument());
    expect(screen.queryByTestId("day-lunch-panel")).not.toBeInTheDocument();
  });

  it("opens and closes a day from a named button, so the keyboard reaches it", async () => {
    stubTimesheet({ rows: [day({ unpaid_meal_minutes: "30.00" })] });
    await mount();
    const button = screen.getByRole("button", {
      name: "Field Tech, Mon 2026-10-26: 10.0 hours, lunch -0.5",
    });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Field Tech, Tue 2026-10-27: no time" })).toBeInTheDocument();

    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(await screen.findByText("Entries for 2026-10-26")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(screen.queryByText("Entries for 2026-10-26")).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a day with a stored lunch and shows its entries, with no way to set No lunch", async () => {
    const calls = stubTimesheet({
      rows: [day({ unpaid_meal_minutes: "30.00" })],
      entries: [{ id: "b1", entry_type: "break", status: "completed", duration_minutes: "45.00" }],
    });
    await mount();
    fireEvent.click(screen.getAllByText("10.0")[0]);
    await waitFor(() => expect(screen.getByText("Entries for 2026-10-26")).toBeInTheDocument());
    expect(screen.queryByTestId("day-lunch-panel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /no lunch/i })).not.toBeInTheDocument();
    expect(calls.some(([u]) => u.includes("/no-lunch"))).toBe(false);
  });
});

describe("approvals tab", () => {
  const week = (extra) => ({
    technician_id: "tech-1",
    tech_name: "Field Tech",
    status: "pending",
    total_shift_minutes: "2520.00",
    regular_minutes: "2400.00",
    overtime_minutes: "0.00",
    job_count: 12,
    total_revenue: "3000.00",
    avg_rpmh: "50.00",
    utilization_pct: "60.00",
    ...extra,
  });
  const mount = async (weekly, dailies = []) => {
    vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).includes("/week-detail")
      ? json({ dailies, entries: [] })
      : json({ techs: [weekly] }))));
    render(<ApprovalsTab showToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Field Tech")).toBeInTheDocument());
  };

  it("shows paid hours and the unpaid lunch when the week has one", async () => {
    await mount(week({ unpaid_meal_minutes: "120.00" }));
    expect(screen.getByText("Paid hours")).toBeInTheDocument();
    expect(screen.getByText("40.0h")).toBeInTheDocument();
    expect(screen.getByText("Unpaid lunch")).toBeInTheDocument();
    expect(screen.getByText("2.0h")).toBeInTheDocument();
  });

  it("is today's Hours stat when the week has no unpaid lunch", async () => {
    await mount(week({ unpaid_meal_minutes: "0.00", overtime_minutes: "120.00" }));
    expect(screen.getByText("Hours")).toBeInTheDocument();
    expect(screen.getByText("42.0h")).toBeInTheDocument();
    expect(screen.queryByText("Unpaid lunch")).not.toBeInTheDocument();
  });

  it("lists the lunch per day in the daily breakdown", async () => {
    await mount(week({ unpaid_meal_minutes: "60.00" }), [
      day({ unpaid_meal_minutes: "30.00" }),
      day({ id: 2, work_date: "2026-10-27", no_lunch: true }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Lunch")).toBeInTheDocument();
    expect(screen.getByText("-0.5h")).toBeInTheDocument();
    expect(screen.getByText("No lunch")).toBeInTheDocument();
  });
});
