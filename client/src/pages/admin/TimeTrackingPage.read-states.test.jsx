// @vitest-environment jsdom
//
// Staff read states (team/staff audit 2026-10-30): a slow answer for one day or
// week never shows under another, and a failed read is never shown as an empty
// list or as the previous week's cards.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimeTrackingPage, { ApprovalsTab, TeamTab, TimesheetTab } from "./TimeTrackingPage";

vi.mock("../../hooks/useStaffDocumentsAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/usePayGrowthAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/usePayrollAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/useTechPayStubs", () => ({ default: () => ({ status: "off" }) }));
vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const TECH = { id: "tech-1", name: "Field Tech", role: "technician", active: true };

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem("waves_admin_user", JSON.stringify({ id: "admin-1", role: "admin" }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("timesheet day entries", () => {
  const entry = (id, name) => ({
    id,
    entry_type: "job",
    status: "completed",
    duration_minutes: 60,
    customer_first_name: name,
  });

  function stubDays({ monday, tuesday }) {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = new URL(String(url), "http://localhost");
      if (u.pathname.endsWith("/daily")) {
        return json([
          { technician_id: "tech-1", tech_name: "Field Tech", work_date: "2026-10-26", total_shift_minutes: 480, overtime_minutes: 0 },
          { technician_id: "tech-1", tech_name: "Field Tech", work_date: "2026-10-27", total_shift_minutes: 540, overtime_minutes: 0 },
        ]);
      }
      if (u.pathname.endsWith("/entries")) {
        return u.searchParams.get("startDate") === "2026-10-26" ? monday() : tuesday();
      }
      return json({ allTechs: [TECH], autoLunch: false });
    }));
  }

  it("keeps a slow earlier day's entries out of the day now open", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T15:00:00Z"));
    let finishMonday;
    const mondayResponse = new Promise((resolve) => { finishMonday = resolve; });
    stubDays({
      monday: () => mondayResponse,
      tuesday: () => json({ entries: [entry("e-tue", "Tuesday customer")] }),
    });
    render(<TimesheetTab showToast={() => {}} onOpenApprovals={() => {}} />);

    fireEvent.click(await screen.findByText("8.0"));
    expect(await screen.findByText("Entries for 2026-10-26")).toBeInTheDocument();
    fireEvent.click(screen.getByText("9.0"));
    expect(await screen.findByText("Tuesday customer")).toBeInTheDocument();

    await act(async () => { finishMonday(json({ entries: [entry("e-mon", "Monday customer")] })); });
    expect(screen.getByText("Entries for 2026-10-27")).toBeInTheDocument();
    expect(screen.getByText("Tuesday customer")).toBeInTheDocument();
    expect(screen.queryByText("Monday customer")).not.toBeInTheDocument();
  });

  it("says a day's entries could not load instead of No entries, and Retry reads them again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T15:00:00Z"));
    let fail = true;
    stubDays({
      monday: () => (fail
        ? json({ error: "Synthetic outage" }, 503)
        : json({ entries: [entry("e-mon", "Monday customer")] })),
      tuesday: () => json({ entries: [] }),
    });
    render(<TimesheetTab showToast={() => {}} onOpenApprovals={() => {}} />);

    fireEvent.click(await screen.findByText("8.0"));
    expect(await screen.findByText("Could not load this day's entries.")).toBeInTheDocument();
    expect(screen.queryByText("No entries")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Monday customer")).toBeInTheDocument();
    expect(screen.queryByText("Could not load this day's entries.")).not.toBeInTheDocument();
  });
});

describe("approvals week switch", () => {
  const week = (name, token) => ({
    technician_id: "tech-1",
    tech_name: name,
    status: "pending",
    total_shift_minutes: 1800,
    regular_minutes: 1800,
    overtime_minutes: 0,
    review_token: token,
  });

  it("shows no card or bulk action from the previous week after a failed switch, and Retry reads the new week", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T15:00:00Z"));
    const toast = vi.fn();
    let failNextWeek = true;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = new URL(String(url), "http://localhost");
      if (u.searchParams.get("weekStart") === "2026-10-19") {
        return json({ techs: [week("Previous week technician", "previous-week-token")] });
      }
      return failNextWeek
        ? json({ error: "Synthetic week outage" }, 503)
        : json({ techs: [week("This week technician", "this-week-token")] });
    }));
    render(<ApprovalsTab showToast={toast} />);

    expect(await screen.findByText("Previous week technician")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Approve 1 selected" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("Load failed")));
    expect(screen.getByText("Week of 2026-10-26")).toBeInTheDocument();
    expect(screen.queryByText("Previous week technician")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select all pending" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /selected/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByText(/No timesheets for week of/)).not.toBeInTheDocument();
    expect(screen.getByText("Could not load timesheets for week of 2026-10-26.")).toBeInTheDocument();

    failNextWeek = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("This week technician")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load timesheets/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /selected/ })).not.toBeInTheDocument();
  });

  it("closes the previous week's open detail when the week changes, even if its read lands late", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T15:00:00Z"));
    let finishOldDetail;
    const oldDetail = new Promise((resolve) => { finishOldDetail = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = new URL(String(url), "http://localhost");
      if (u.pathname.endsWith("/week-detail")) {
        return u.searchParams.get("weekStart") === "2026-10-19"
          ? oldDetail
          : json({ dailies: [], entries: [] });
      }
      return json({ techs: [week("Field Tech", `token-${u.searchParams.get("weekStart")}`)] });
    }));
    render(<ApprovalsTab showToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(screen.getByText("Loading detail…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(screen.getByText("Week of 2026-10-26")).toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Details" })).toBeInTheDocument();

    await act(async () => {
      finishOldDetail(json({
        dailies: [{ id: "d-old", work_date: "2026-10-19", total_shift_minutes: 480, overtime_minutes: 0 }],
        entries: [],
      }));
    });
    expect(screen.queryByText("Daily breakdown")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-10-19")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();
  });
});

describe("failed reads are not empty lists", () => {
  it("a failed first roster read says so, offers Retry, and does not invite adding a first technician", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => (fail
      ? json({ error: "Synthetic roster outage" }, 503)
      : json({ technicians: [TECH] }))));
    render(<TeamTab showToast={() => {}} />);

    expect(await screen.findByText("Could not load the team.")).toBeInTheDocument();
    expect(screen.queryByText(/No technicians found/)).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Field Tech")).toBeInTheDocument();
    expect(screen.queryByText("Could not load the team.")).not.toBeInTheDocument();
  });

  it("an empty roster read still shows the add-your-first invitation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ technicians: [] })));
    render(<TeamTab showToast={() => {}} />);
    expect(await screen.findByText(/No technicians found/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });

  it("a failed document read says so instead of No documents yet, and Retry reads them again", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("/technicians")) return json({ technicians: [TECH] });
      return fail
        ? json({ error: "Synthetic document outage" }, 503)
        : json({ documents: [] });
    }));
    render(
      <MemoryRouter initialEntries={["/admin/timetracking?tab=documents"]}>
        <TimeTrackingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Could not load documents.")).toBeInTheDocument();
    expect(screen.queryByText("No documents yet")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No documents yet")).toBeInTheDocument();
    expect(screen.queryByText("Could not load documents.")).not.toBeInTheDocument();
  });
});
