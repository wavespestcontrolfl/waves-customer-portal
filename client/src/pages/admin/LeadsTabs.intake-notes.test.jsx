// @vitest-environment jsdom
// The New Lead form stores its Notes only in the "created" activity's metadata.
// The expanded lead's Activity Timeline must show them.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeadsSection } from "./LeadsTabs";

vi.mock("../../components/admin/customer360/CustomerSmsPanel", () => ({
  useCustomerSms: () => () => {},
  CustomerSmsProvider: ({ children }) => children,
  openEstimateMessages: vi.fn(),
}));

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const lead = { id: "lead-1", first_name: "Synthetic", last_name: "Lead", status: "new", service_interest: "Pest", first_contact_at: new Date().toISOString() };

function renderWithActivities(activities) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    if (path.includes("/admin/leads?")) return response({ leads: [lead], total: 1 });
    if (path.endsWith("/sources")) return response({ sources: [] });
    if (path.endsWith("/lead-1")) return response({ lead, activities, estimates: [], calls: [] });
    return response({});
  }));
  render(
    <MemoryRouter initialEntries={["/admin/pipeline?lead=lead-1"]}>
      <LeadsSection />
    </MemoryRouter>,
  );
}
const created = (metadata) => ({ id: "activity-1", activity_type: "created", description: "Lead created manually by Synthetic staff", metadata, created_at: new Date().toISOString() });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("manual lead intake notes in the activity timeline", () => {
  it("shows notes from object metadata on the created row", async () => {
    renderWithActivities([created({ notes: "Customer requests a call after 3pm." })]);
    await screen.findByText("Lead created manually by Synthetic staff");
    expect(await screen.findByText(/Notes: Customer requests a call after 3pm\./)).toBeInTheDocument();
  });

  it("shows notes from JSON-string metadata and keeps line breaks", async () => {
    renderWithActivities([created(JSON.stringify({ notes: "Line one\nLine two" }))]);
    const notes = await screen.findByText(/Notes: Line one/);
    expect(notes).toHaveTextContent("Line two");
    expect(notes.className).toContain("whitespace-pre-wrap");
  });

  it("shows no Notes line when the created row has no notes or unreadable metadata", async () => {
    renderWithActivities([created("{not json"), { ...created({ notes: "   " }), id: "activity-2" }]);
    await screen.findAllByText("Lead created manually by Synthetic staff");
    expect(screen.queryByText(/Notes:/)).not.toBeInTheDocument();
  });

  it("does not render notes for other activity types", async () => {
    renderWithActivities([{ ...created({ notes: "Should stay hidden." }), activity_type: "callback_requested", description: "Callback requested" }]);
    await screen.findByText("Callback requested");
    expect(screen.queryByText(/Should stay hidden\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/Notes:/)).not.toBeInTheDocument();
  });
});
