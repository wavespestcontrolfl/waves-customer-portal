// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

import BidDeskPage from "./BidDeskPage";

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({ ok, status, json: async () => body });

const bid = (over = {}) => ({
  id: "b1", source: "buildingconnected", status: "new", historical: false, project_title: "Sample Ridge Residences",
  gc_or_agency: "Fixture Build Co", buyer_name: "Pat Sample", buyer_email: "pat.sample@fixture-gc.example", location: "100 Fixture Way",
  due_at: "2026-10-21T03:59:00.000Z", due_source_line: "Bid Due: October 20, 2026", due_confirmed: false, needs_date_confirmation: false,
  job_walk_at: null, decision_note: null, days_left: 19, email_count: 1, first_subject: "Invite", updated_at: "2026-10-02T12:00:00.000Z", ...over,
});
const LIST = [
  bid(),
  bid({ id: "b2", project_title: null, gc_or_agency: null, buyer_name: null, buyer_email: null, first_subject: "RFP: Grounds pest control", first_from_name: "Sample HOA", source: "email_subject", due_at: null, due_source_line: null, days_left: null }),
  bid({ id: "b3", status: "no_bid", project_title: "Decided Plaza" }),
  bid({ id: "b4", historical: true, project_title: "Earlier Mall" }),
];

function route(handlers) {
  adminFetch.mockImplementation((path, options = {}) => {
    const key = `${options.method || "GET"} ${path}`;
    const handler = handlers[key];
    if (!handler) return reply({ error: `unexpected ${key}` }, { ok: false, status: 500 });
    return handler(options);
  });
}
const renderPage = (url = "/") => render(<MemoryRouter initialEntries={[url]}><BidDeskPage /></MemoryRouter>);

beforeEach(() => adminFetch.mockReset());
afterEach(() => cleanup());

it("lists open bids with the date, an Unconfirmed chip and the line it was read from", async () => {
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }) });
  renderPage();
  expect(await screen.findByText("Sample Ridge Residences")).toBeInTheDocument();
  expect(screen.getByText("RFP: Grounds pest control")).toBeInTheDocument(); // no template title: the email's own subject
  expect(screen.getByText("Sample HOA")).toBeInTheDocument();
  expect(screen.queryByText("Decided Plaza")).toBeNull();
  expect(screen.getAllByText("Unconfirmed").length).toBeGreaterThan(0);
  expect(screen.getAllByTitle("Read from: Bid Due: October 20, 2026").length).toBeGreaterThan(0);
  expect(screen.getByText("Not read")).toBeInTheDocument();
  expect(screen.getAllByText("19 days").length).toBeGreaterThan(0);
  expect(screen.getByText("Earlier")).toBeInTheDocument();
});

it("filters decided bids and hides earlier mail", async () => {
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }) });
  renderPage();
  await screen.findByText("Sample Ridge Residences");
  fireEvent.click(screen.getByRole("button", { name: "Hide earlier mail" }));
  expect(screen.queryByText("Earlier Mall")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Decided" }));
  expect(screen.getByText("Decided Plaza")).toBeInTheDocument();
  expect(screen.queryByText("Sample Ridge Residences")).toBeNull();
});

it("says so when the gate is off", async () => {
  route({ "GET /admin/bid-desk/": () => reply({ error: "Not found" }, { ok: false, status: 404 }) });
  renderPage();
  expect(await screen.findByText("Bid Desk is not turned on yet.")).toBeInTheDocument();
  expect(screen.queryByText("Mark an email as a bid")).toBeNull();
});

it("opens a bid from the link in its bell, shows its emails and saves a typed date as confirmed", async () => {
  const detail = { bid: bid({ needs_date_confirmation: true }), emails: [
    { email_id: "e1", kind: "invite", received_at: "2026-09-20T14:00:00.000Z", subject: "Invite", from_name: "BC", from_address: "i@x.test" },
    { email_id: "e2", kind: "addendum", received_at: "2026-09-25T14:00:00.000Z", subject: "Addendum 1", from_name: "BC", from_address: "i@x.test" },
  ] };
  const patch = vi.fn((options) => reply({ ok: true, bid: bid({ due_at: "2026-10-28T18:00:00.000Z", due_confirmed: true }) }));
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }), "GET /admin/bid-desk/b1": () => reply(detail), "PATCH /admin/bid-desk/b1": patch });
  renderPage("/?bid=b1");
  expect(await screen.findByText(/A later email may have changed the date/)).toBeInTheDocument();
  expect(screen.getByText("Addendum")).toBeInTheDocument();
  const open = screen.getAllByRole("link", { name: "Open email" });
  expect(open[1]).toHaveAttribute("href", "/admin/communications?id=e2#tab=email");

  fireEvent.change(screen.getByLabelText("Due date (Eastern time)"), { target: { value: "2026-10-28T14:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save as confirmed" }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch.mock.calls[0][0].body).toEqual({ due_at: "2026-10-28T14:00", expected_updated_at: "2026-10-02T12:00:00.000Z" });
  expect(await screen.findByText("Due date saved and confirmed")).toBeInTheDocument();
});

it("confirms a date as read and saves a decision with a note", async () => {
  const detail = { bid: bid(), emails: [] };
  const patch = vi.fn(() => reply({ ok: true, bid: bid({ due_confirmed: true, status: "no_bid" }) }));
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }), "GET /admin/bid-desk/b1": () => reply(detail), "PATCH /admin/bid-desk/b1": patch });
  renderPage("/?bid=b1");
  fireEvent.click(await screen.findByRole("button", { name: "Confirm date as read" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0][0].body).toEqual({ confirm_due: true, expected_updated_at: detail.bid.updated_at });
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "no_bid" } });
  fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Out of area" } });
  fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][0].body).toEqual({ status: "no_bid", decision_note: "Out of area" });
});

it("saving a decision keeps a due date the operator typed but has not saved", async () => {
  const patch = vi.fn(() => reply({ ok: true, bid: bid({ status: "bid" }) }));
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }), "GET /admin/bid-desk/b1": () => reply({ bid: bid(), emails: [] }), "PATCH /admin/bid-desk/b1": patch });
  renderPage("/?bid=b1");
  const due = await screen.findByLabelText("Due date (Eastern time)");
  fireEvent.change(due, { target: { value: "2026-10-30T09:00" } });
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "bid" } });
  fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByLabelText("Due date (Eastern time)")).toHaveValue("2026-10-30T09:00"));
});

it("a date typed before a decision save is saved against the version it was typed on", async () => {
  const patch = vi.fn()
    .mockImplementationOnce(() => reply({ ok: true, bid: bid({ status: "bid", updated_at: "2026-10-02T13:00:00.000Z" }) }))
    .mockImplementationOnce(() => reply({ error: "The due date changed since you opened this bid. Reload and check it again." }, { status: 409 }));
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }), "GET /admin/bid-desk/b1": () => reply({ bid: bid(), emails: [] }), "PATCH /admin/bid-desk/b1": patch });
  renderPage("/?bid=b1");
  fireEvent.change(await screen.findByLabelText("Due date (Eastern time)"), { target: { value: "2026-10-30T09:00" } });
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "bid" } });
  fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Save as confirmed" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][0].body).toEqual({ due_at: "2026-10-30T09:00", expected_updated_at: "2026-10-02T12:00:00.000Z" });
});

it("marks an email as a bid by id and opens the bid", async () => {
  const post = vi.fn(() => reply({ ok: true, bid_id: "b9", created: true }, { status: 201 }));
  route({
    "GET /admin/bid-desk/": () => reply({ bids: LIST }),
    "POST /admin/bid-desk/from-email": post,
    "GET /admin/bid-desk/b9": () => reply({ bid: bid({ id: "b9", project_title: "Marked Plaza" }), emails: [] }),
  });
  renderPage();
  await screen.findByText("Sample Ridge Residences");
  fireEvent.change(screen.getByLabelText("Mark an email as a bid"), { target: { value: " 11111111-2222-4333-8444-555555555555 " } });
  fireEvent.click(screen.getByRole("button", { name: "Mark as bid" }));
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post.mock.calls[0][0].body).toEqual({ email_id: "11111111-2222-4333-8444-555555555555" });
  expect(await screen.findByText("Marked Plaza")).toBeInTheDocument();
});
