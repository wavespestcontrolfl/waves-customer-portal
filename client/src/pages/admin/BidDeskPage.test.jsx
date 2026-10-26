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

it("dark-ships the shared controls and preserves the preview while opening a bid", async () => {
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }) });
  const legacy = renderPage();
  await screen.findByText("Sample Ridge Residences");
  expect(screen.queryByRole("searchbox", { name: "Bid Desk search" })).toBeNull();
  expect(screen.queryByLabelText("Bid Desk rows per page")).toBeNull();
  legacy.unmount();

  route({
    "GET /admin/bid-desk/": () => reply({ bids: LIST }),
    "GET /admin/bid-desk/b1": () => reply({ bid: bid(), emails: [] }),
  });
  renderPage("/?tableControls=1");
  expect(await screen.findByRole("searchbox", { name: "Bid Desk search" })).toBeInTheDocument();
  expect(screen.getByLabelText("Status")).toHaveValue("open");
  expect(screen.getByLabelText("Earlier mail")).toHaveValue("show");
  expect(screen.getByLabelText("Sort")).toHaveValue("workflow");
  expect(screen.getByLabelText("Bid Desk rows per page")).toHaveValue("100");

  fireEvent.click(screen.getByRole("button", { name: "Open Sample Ridge Residences" }));
  expect(await screen.findByLabelText("Due date (Eastern time)")).toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: "Bid Desk search" })).toBeInTheDocument();
});

it("searches the known loaded bid text and applies the preview filters", async () => {
  const searchable = bid({
    id: "searchable", project_title: "Harbor Library", gc_or_agency: "Coastal Builders", source: "sam_gov",
    solicitation_number: "SOL-7788", location: "Sarasota Civic Campus",
  });
  route({ "GET /admin/bid-desk/": () => reply({ bids: [searchable, ...LIST] }) });
  renderPage("/?tableControls=1");
  const search = await screen.findByRole("searchbox", { name: "Bid Desk search" });
  for (const query of ["harbor library", "coastal builders", "pat sample", "sam.gov", "sol-7788", "sarasota civic"]) {
    fireEvent.change(search, { target: { value: query } });
    expect(screen.getByText("Harbor Library")).toBeInTheDocument();
  }

  fireEvent.change(search, { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Earlier mail"), { target: { value: "hide" } });
  expect(screen.queryByText("Earlier Mall")).toBeNull();
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "decided" } });
  expect(screen.getByText("Decided Plaza")).toBeInTheDocument();
  expect(screen.queryByText("Sample Ridge Residences")).toBeNull();
});

it("sorts the loaded bids while keeping unknown due dates last", async () => {
  const sortable = [
    bid({ id: "z", project_title: "Zulu Project", gc_or_agency: "Able Buyer", due_at: null }),
    bid({ id: "a", project_title: "Alpha Project", gc_or_agency: "Zulu Buyer", due_at: "2026-12-20T12:00:00.000Z" }),
    bid({ id: "b", project_title: "Beta Project", gc_or_agency: "Middle Buyer", due_at: "2026-11-10T12:00:00.000Z" }),
  ];
  route({ "GET /admin/bid-desk/": () => reply({ bids: sortable }) });
  renderPage("/?tableControls=1");
  await screen.findByText("Zulu Project");
  const rowOrder = () => screen.getAllByRole("button", { name: /^Open / }).map((button) => button.textContent);
  expect(rowOrder()).toEqual(["Zulu Project", "Alpha Project", "Beta Project"]);

  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "due" } });
  expect(rowOrder()).toEqual(["Beta Project", "Alpha Project", "Zulu Project"]);
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "project" } });
  expect(rowOrder()).toEqual(["Alpha Project", "Beta Project", "Zulu Project"]);
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "buyer" } });
  expect(rowOrder()).toEqual(["Zulu Project", "Beta Project", "Alpha Project"]);
});

it("resets paging when search or page size changes", async () => {
  const many = Array.from({ length: 101 }, (_, index) => bid({
    id: `p${index + 1}`,
    project_title: `Project ${String(index + 1).padStart(3, "0")}`,
  }));
  route({ "GET /admin/bid-desk/": () => reply({ bids: many }) });
  renderPage("/?tableControls=1");
  await screen.findByText("Project 001");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  expect(screen.getByText("Project 101")).toBeInTheDocument();

  fireEvent.change(screen.getByRole("searchbox", { name: "Bid Desk search" }), { target: { value: "Project 101" } });
  expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  expect(screen.getByText("Project 101")).toBeInTheDocument();

  fireEvent.change(screen.getByRole("searchbox", { name: "Bid Desk search" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "project" } });
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  expect(screen.getByText("Project 001")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.change(screen.getByLabelText("Bid Desk rows per page"), { target: { value: "500" } });
  expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  expect(screen.getByText("Project 001")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  expect(screen.getByLabelText("Status")).toHaveValue("open");
  expect(screen.getByLabelText("Sort")).toHaveValue("project");
  expect(screen.getByLabelText("Bid Desk rows per page")).toHaveValue("500");
});

it("clamps the page after a reload returns fewer loaded bids", async () => {
  const many = Array.from({ length: 101 }, (_, index) => bid({ id: `p${index + 1}`, project_title: `Project ${String(index + 1).padStart(3, "0")}` }));
  let listLoads = 0;
  route({
    "GET /admin/bid-desk/": () => reply({ bids: listLoads++ === 0 ? many : [many[0]] }),
    "POST /admin/bid-desk/from-email": () => reply({ created: false, bid_id: "p1" }),
    "GET /admin/bid-desk/p1": () => reply({ bid: many[0], emails: [] }),
  });
  renderPage("/?tableControls=1");
  await screen.findByText("Project 001");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Mark an email as a bid"), { target: { value: "mail-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Mark as bid" }));
  await waitFor(() => expect(listLoads).toBe(2));
  expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
  expect(screen.getAllByText("Project 001").length).toBeGreaterThan(0);
});

it("keeps the project action column and lets the other columns be hidden", async () => {
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }) });
  renderPage("/?tableControls=1");
  await screen.findByText("Sample Ridge Residences");
  const table = screen.getByRole("table");
  expect(table).toHaveClass("min-[1101px]:min-w-[var(--bid-desk-table-min-width)]");
  expect(table.style.getPropertyValue("--bid-desk-table-min-width")).toBe("1100px");
  fireEvent.click(screen.getByRole("button", { name: "Columns" }));
  expect(screen.getByLabelText("Project / action")).toBeChecked();
  expect(screen.getByLabelText("Project / action")).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Buyer"));
  fireEvent.click(screen.getByLabelText("Due"));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));

  expect(screen.getByRole("columnheader", { name: "Project" })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Buyer" })).toBeNull();
  expect(screen.queryByRole("columnheader", { name: "Due" })).toBeNull();
  expect(screen.getByRole("columnheader", { name: "Source" })).toBeInTheDocument();
  expect(screen.queryByText("Fixture Build Co")).toBeNull();
  expect(screen.getAllByRole("button", { name: /^Open / })).not.toHaveLength(0);
  expect(table.style.getPropertyValue("--bid-desk-table-min-width")).toBe("680px");
});

it("warns that the capped response contains only the first 500 loaded bids", async () => {
  const capped = Array.from({ length: 500 }, (_, index) => bid({ id: `c${index}`, project_title: `Capped ${index}` }));
  route({ "GET /admin/bid-desk/": () => reply({ bids: capped }) });
  renderPage("/?tableControls=1");
  expect(await screen.findByText("Only the first 500 bids are loaded. Search and filters apply to this set.")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("1–100 of 500 loaded bids");
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

it("an untouched date field shows the saved date after a decision save", async () => {
  const patch = vi.fn(() => reply({ ok: true, bid: bid({ status: "bid", due_at: "2026-10-28T18:00:00.000Z" }) }));
  route({ "GET /admin/bid-desk/": () => reply({ bids: LIST }), "GET /admin/bid-desk/b1": () => reply({ bid: bid(), emails: [] }), "PATCH /admin/bid-desk/b1": patch });
  renderPage("/?bid=b1");
  await screen.findByLabelText("Due date (Eastern time)");
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "bid" } });
  fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
  await waitFor(() => expect(screen.getByLabelText("Due date (Eastern time)")).toHaveValue("2026-10-28T14:00"));
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

it("a SAM.gov bid shows its source, solicitation and notice link, and no email list", async () => {
  const samBid = bid({
    id: "s1", source: "sam_gov", project_title: "Pest Control Services, Sample Cemetery", gc_or_agency: "Sample Agency",
    buyer_name: null, buyer_email: null, solicitation_number: "SOL-0001", external_url: "https://sam.gov/opp/abc/view",
    due_source_line: "SAM.gov response deadline: 2026-11-05T14:00:00-05:00",
  });
  route({ "GET /admin/bid-desk/": () => reply({ bids: [samBid] }), "GET /admin/bid-desk/s1": () => reply({ bid: samBid, emails: [] }) });
  renderPage("/?bid=s1");
  expect(await screen.findByText("Solicitation:")).toBeInTheDocument();
  expect(screen.getByText("SOL-0001")).toBeInTheDocument();
  expect(screen.getByText("Read from SAM.gov:")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open the notice on SAM.gov" })).toHaveAttribute("href", "https://sam.gov/opp/abc/view");
  expect(screen.queryByText("Emails on this bid")).toBeNull();
});

it("a flagged SAM.gov bid says the source line names what changed, not that a new deadline was posted", async () => {
  const samBid = bid({ id: "s3", source: "sam_gov", needs_date_confirmation: true, due_source_line: "SAM.gov no longer lists this notice as active" });
  route({ "GET /admin/bid-desk/": () => reply({ bids: [samBid] }), "GET /admin/bid-desk/s3": () => reply({ bid: samBid, emails: [] }) });
  renderPage("/?bid=s3");
  expect(await screen.findByText(/SAM\.gov changed this notice: the line above says what changed/)).toBeInTheDocument();
  expect(screen.getByText(/SAM\.gov no longer lists this notice as active/)).toBeInTheDocument();
});

it("a notice link off sam.gov is not shown", async () => {
  const samBid = bid({ id: "s2", source: "sam_gov", external_url: "https://evil.example/opp" });
  route({ "GET /admin/bid-desk/": () => reply({ bids: [samBid] }), "GET /admin/bid-desk/s2": () => reply({ bid: samBid, emails: [] }) });
  renderPage("/?bid=s2");
  expect(await screen.findByText("Read from SAM.gov:")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open the notice on SAM.gov" })).toBeNull();
});
