// @vitest-environment jsdom
//
// Entries tab, refused changes (daily-work audit 2026-11-06): the server
// refuses an edit or void of an entry in an approved or paid week with its own
// reason. That reason reaches the office (the edit form keeps the draft open),
// an approved entry says so before anyone types, and both point at the entry's
// week in Approvals, where the week is unlocked.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimeTrackingPage, { EntriesTab } from "./TimeTrackingPage";

vi.mock("../../hooks/useStaffDocumentsAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/usePayGrowthAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/usePayrollAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/useTechPayStubs", () => ({ default: () => ({ status: "off" }) }));
vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const REFUSAL = "Unlock the approved week before changing its entries.";
// Tue Jul 7 2026, 8:00 AM to 4:00 PM Eastern. Its payroll week starts Mon Jul 6.
const ENTRY = {
  id: "entry-1",
  technician_id: "tech-1",
  tech_name: "Field Tech",
  entry_type: "shift",
  status: "completed",
  approval_status: "pending",
  clock_in: "2026-07-07T12:00:00.000Z",
  clock_out: "2026-07-07T20:00:00.000Z",
  duration_minutes: 480,
};
const WEEK_LINK = "Open week of 2026-07-06 in Approvals";

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem("waves_admin_user", JSON.stringify({ id: "admin-1", role: "admin" }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function stub({ entry = ENTRY, put = () => json(entry), del = () => json(entry) } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push([u, options]);
    if (options.method === "PUT") return put();
    if (options.method === "DELETE") return del();
    if (u.includes("/admin/timetracking/entries?")) return json({ entries: [entry], total: 1 });
    if (u.includes("/admin/timesheets/pending")) return json({ techs: [] });
    return json({ allTechs: [{ id: "tech-1", name: "Field Tech" }] });
  }));
  return calls;
}

async function entryRow() {
  const cell = await screen.findByText("Field Tech", { selector: "td" });
  return cell.closest("tr");
}

async function openEdit() {
  fireEvent.click(within(await entryRow()).getByRole("button", { name: "Edit" }));
  return screen.getByRole("dialog", { name: "Edit time entry" });
}

describe("entries the server refuses to change", () => {
  it("marks an approved entry and links its edit form to the week in Approvals", async () => {
    stub({ entry: { ...ENTRY, approval_status: "approved" } });
    const onOpenApprovals = vi.fn();
    render(<EntriesTab showToast={vi.fn()} onOpenApprovals={onOpenApprovals} />);

    expect(within(await entryRow()).getByText("approved")).toBeInTheDocument();
    const dialog = await openEdit();
    expect(dialog).toHaveTextContent("This entry's week is approved. Unlock the week in Approvals before you change it.");
    fireEvent.click(within(dialog).getByRole("button", { name: WEEK_LINK }));
    expect(onOpenApprovals).toHaveBeenCalledWith("2026-07-06");
  });

  it("shows the server's reason for a refused save and keeps the draft open", async () => {
    const calls = stub({ put: () => json({ error: REFUSAL }, 409) });
    const showToast = vi.fn();
    render(<EntriesTab showToast={showToast} onOpenApprovals={vi.fn()} />);

    const dialog = await openEdit();
    expect(within(dialog).queryByRole("button", { name: WEEK_LINK })).not.toBeInTheDocument();
    const reason = within(dialog).getByPlaceholderText("Why is this being changed?");
    fireEvent.change(reason, { target: { value: "Clock-out was late" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Changes" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(REFUSAL);
    expect(within(alert).getByRole("button", { name: WEEK_LINK })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit time entry" })).toBeInTheDocument();
    expect(reason).toHaveValue("Clock-out was late");
    expect(within(dialog).getByRole("button", { name: "Save Changes" })).toBeEnabled();
    expect(showToast).not.toHaveBeenCalledWith("Entry updated");
    expect(showToast).not.toHaveBeenCalledWith("Edit failed");
    expect(calls.filter(([, o]) => o.method === "PUT")).toHaveLength(1);
  });

  it("closes the form and reloads after a save the server accepts", async () => {
    const calls = stub();
    const showToast = vi.fn();
    render(<EntriesTab showToast={showToast} />);

    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByPlaceholderText("Why is this being changed?"), {
      target: { value: "Typo in the notes" },
    });
    const loadsBefore = calls.filter(([u]) => u.includes("/entries?")).length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Entry updated"));
    expect(screen.queryByRole("dialog", { name: "Edit time entry" })).not.toBeInTheDocument();
    await waitFor(() => expect(calls.filter(([u]) => u.includes("/entries?")).length).toBeGreaterThan(loadsBefore));
  });

  it("shows the server's reason for a refused void", async () => {
    stub({ del: () => json({ error: REFUSAL }, 409) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const showToast = vi.fn();
    render(<EntriesTab showToast={showToast} />);

    fireEvent.click(within(await entryRow()).getByRole("button", { name: "Void" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(`Void failed: ${REFUSAL}`));
    expect(showToast).not.toHaveBeenCalledWith("Entry voided");
  });

  it("the week link opens Approvals on that week", async () => {
    const calls = stub({ entry: { ...ENTRY, approval_status: "approved" } });
    render(
      <MemoryRouter initialEntries={["/admin/timetracking?tab=entries"]}>
        <TimeTrackingPage />
      </MemoryRouter>,
    );

    const dialog = await openEdit();
    fireEvent.click(within(dialog).getByRole("button", { name: WEEK_LINK }));

    expect(await screen.findByText("Week of 2026-07-06")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Edit time entry" })).not.toBeInTheDocument();
    await waitFor(() => expect(calls.some(([u]) => u.includes("/admin/timesheets/pending?weekStart=2026-07-06"))).toBe(true));
  });
});
