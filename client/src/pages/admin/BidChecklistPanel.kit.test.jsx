// @vitest-environment jsdom
// Bid kit status beside the Bid Desk checklist lines: shown only while the bid_kit flag is on and the kit loads; the
// checklist is unchanged otherwise; the panel never writes. Synthetic data only.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch, flag } = vi.hoisted(() => ({ adminFetch: vi.fn(), flag: { on: true } }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));
vi.mock("../../hooks/useFeatureFlag", () => ({ useFeatureFlag: (key) => (key === "bid_kit" ? flag.on : false) }));

import BidChecklistPanel from "./BidChecklistPanel";

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({ ok, status, json: async () => body });
const line = (n, template_key, over = {}) => ({ id: `i${n}`, bid_id: "b1", position: n, section: "base", label: `Line ${n}`, source_text: null, required: true, template_key, checked_at: null, notes: null, ...over });
const bid = { id: "b1", solicitation_type: "itb", estimate_id: null, job_walk_at: null, questions_due_at: null, job_walk_mandatory: false, scored: null, submitted_at: null, submission_confirmation: null };
const extras = {
  checklist: [line(1, "itb.business_license"), line(2, "itb.operator_statement"), line(3, "base.signer"), line(4, null, { section: "custom", label: "Typed line" }), line(5, "quote.references")],
  progress: { checked: 0, required: 5, total: 5 }, missing: 0, estimate: null, documents: [],
};
const kitReply = () => ({
  today: "2026-10-25",
  items: [
    { id: "kit-license", kind: "document", item_key: "business_license_copy", file: { name: "license.pdf" }, expires_on: "2027-06-30", attested_at: "2026-10-01T12:00:00Z", archived_at: null },
    { id: "kit-stmt", kind: "document", item_key: "cpco_fulltime_statement", file: { name: "template.pdf" }, expires_on: null, attested_at: "2026-10-01T12:00:00Z", archived_at: null },
    { id: "kit-r1", kind: "reference", item_key: "reference", details: { entity: "Sample County" }, permission_on: "2026-09-01", attested_at: "2026-10-01T12:00:00Z", archived_at: null },
  ],
});
const renderPanel = () => render(<MemoryRouter><BidChecklistPanel bidId="b1" bid={bid} extras={extras} save={vi.fn()} busy={false} invite={false} /></MemoryRouter>);
const writes = () => adminFetch.mock.calls.filter(([, options]) => options && options.method && options.method !== "GET");

beforeEach(() => { adminFetch.mockReset(); flag.on = true; });
afterEach(() => cleanup());

it("shows a pill on each line that needs a kit paper, linked to the kit item, and nothing on the others", async () => {
  adminFetch.mockImplementation((path) => (path === "/admin/bid-kit" ? reply(kitReply()) : reply({ error: "unexpected" }, { ok: false, status: 500 })));
  renderPanel();
  await screen.findByText("Kit: on file, signed off");
  const pills = screen.getAllByTestId("kit-pill");
  expect(pills.map((pill) => pill.textContent)).toEqual(["Kit: on file, signed off", "Kit: template on file", "Kit: 1 of 3 references"]);
  expect(pills[0]).toHaveAttribute("href", "/admin/bid-kit?item=kit-license");
  expect(pills[1]).toHaveAttribute("href", "/admin/bid-kit?item=kit-stmt");
  expect(pills[2]).toHaveAttribute("href", "/admin/bid-kit?item=kit-r1");
  // The signer line, the typed line: no pill. A pill never ticks anything.
  expect(screen.getByLabelText("Line 3").closest("li").querySelector("[data-testid=kit-pill]")).toBeNull();
  expect(screen.getByLabelText("Typed line").closest("li").querySelector("[data-testid=kit-pill]")).toBeNull();
  for (const label of ["Line 1", "Line 2", "Line 3", "Typed line", "Line 5"]) expect(screen.getByLabelText(label)).not.toBeChecked();
  expect(adminFetch.mock.calls.map(([path]) => path)).toEqual(["/admin/bid-kit"]);
  expect(writes()).toEqual([]);
});

it("does not read the kit and shows no pills while the bid_kit flag is off", async () => {
  flag.on = false;
  adminFetch.mockImplementation(() => reply({}, { ok: false, status: 500 }));
  renderPanel();
  await screen.findByLabelText("Line 1");
  expect(screen.queryAllByTestId("kit-pill")).toHaveLength(0);
  expect(adminFetch).not.toHaveBeenCalled();
});

it("shows the checklist as before, with no pills and no banner, when the kit request fails", async () => {
  adminFetch.mockImplementation(() => reply({ error: "boom" }, { ok: false, status: 500 }));
  renderPanel();
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/bid-kit"));
  await screen.findByLabelText("Line 1");
  expect(screen.queryAllByTestId("kit-pill")).toHaveLength(0);
  expect(screen.queryByText(/could not|not saved|failed/i)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows the checklist as before when the kit request throws or returns an unusable reply", async () => {
  adminFetch.mockImplementationOnce(() => Promise.reject(new Error("offline")));
  const first = renderPanel();
  await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));
  await screen.findByLabelText("Line 1");
  expect(screen.queryAllByTestId("kit-pill")).toHaveLength(0);
  first.unmount();
  adminFetch.mockReset();
  adminFetch.mockImplementation(() => reply({ nope: true }));
  renderPanel();
  await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));
  expect(screen.queryAllByTestId("kit-pill")).toHaveLength(0);
});

it("reads the kit once per panel", async () => {
  adminFetch.mockImplementation(() => reply(kitReply()));
  const view = renderPanel();
  await screen.findByText("Kit: template on file");
  view.rerender(<MemoryRouter><BidChecklistPanel bidId="b1" bid={{ ...bid, scored: "x" }} extras={extras} save={vi.fn()} busy={false} invite={false} /></MemoryRouter>);
  expect(adminFetch.mock.calls.filter(([path]) => path === "/admin/bid-kit")).toHaveLength(1);
});
