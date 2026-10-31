// @vitest-environment jsdom
// Bid Desk checklist section (GATE_BID_CHECKLIST): shown only when the server says the gate is on; the list chip, the
// details form, the estimate link, the documents, the checklist and the submission record. Synthetic data only.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

import BidDeskPage from "./BidDeskPage";

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({ ok, status, json: async () => body, blob: async () => new Blob(["x"]) });

const bid = (over = {}) => ({
  id: "b1", source: "buildingconnected", status: "new", historical: false, project_title: "Sample Ridge Residences",
  gc_or_agency: "Fixture Build Co", due_at: "2026-10-21T03:59:00.000Z", due_confirmed: true, needs_date_confirmation: false,
  job_walk_at: null, questions_due_at: null, job_walk_mandatory: false, job_walk_confirmed: false, decision_note: null, days_left: 19, email_count: 1,
  first_subject: "Invite", updated_at: "2026-10-02T12:00:00.000Z", solicitation_type: null, scored: null, estimate_id: null,
  submitted_at: null, submission_confirmation: null, checklist_progress: { checked: 7, required: 12 }, ...over,
});
const item = (n, over = {}) => ({ id: `i${n}`, bid_id: "b1", position: n, section: "base", label: `Line ${n}`, source_text: null, required: true, checked_at: null, notes: null, ...over });
const detail = (over = {}) => ({
  bid: bid(), emails: [], checklist_live: true, checklist: [], checklist_progress: { checked: 0, required: 0, total: 0 }, estimate: null, documents: [], ...over,
});

function route(handlers) {
  adminFetch.mockImplementation((path, options = {}) => {
    const key = `${options.method || "GET"} ${path}`;
    const handler = handlers[key];
    if (!handler) return reply({ error: `unexpected ${key}` }, { ok: false, status: 500 });
    return handler(options);
  });
}
const LIST_ON = () => reply({ checklist_live: true, bids: [bid()] });
const renderPage = (url = "/?bid=b1") => render(<MemoryRouter initialEntries={[url]}><BidDeskPage /></MemoryRouter>);

beforeEach(() => adminFetch.mockReset());
afterEach(() => cleanup());

it("shows none of the new sections while the gate is off", async () => {
  route({ "GET /admin/bid-desk/": () => reply({ bids: [bid()] }), "GET /admin/bid-desk/b1": () => reply({ bid: bid(), emails: [] }) });
  renderPage();
  await screen.findByLabelText("Due date (Eastern time)");
  expect(screen.queryByTestId("bid-checklist-panel")).toBeNull();
  expect(screen.queryByText("Start checklist")).toBeNull();
  expect(screen.queryByText("7/12")).toBeNull();
  expect(screen.getByText(/7 and 2 days before a confirmed date/)).toBeInTheDocument();
});

it("shows a progress chip in the list when the gate is on", async () => {
  route({ "GET /admin/bid-desk/": LIST_ON });
  renderPage("/");
  expect(await screen.findByText("7/12")).toBeInTheDocument();
  expect(screen.getByText(/14, 7 and 2 days before a confirmed date/)).toBeInTheDocument();
});

it("starts a checklist from the bid's type, then ticks a line", async () => {
  let lines = [];
  const start = vi.fn(() => { lines = [item(1), item(2, { source_text: "Section 3.2, page 4" })]; return reply({ ok: true, added: 2 }, { status: 201 }); });
  const tick = vi.fn(() => { lines = [item(1, { checked_at: "2026-10-23T12:00:00Z" }), lines[1]]; return reply({ ok: true }); });
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ bid: bid({ solicitation_type: "itb" }), checklist: lines, checklist_progress: { checked: lines.filter((l) => l.checked_at).length, required: lines.length, total: lines.length } })),
    "POST /admin/bid-desk/b1/checklist/start": start,
    "PATCH /admin/bid-desk/b1/checklist/i1": tick,
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Start checklist" }));
  await waitFor(() => expect(start).toHaveBeenCalled());
  expect(start.mock.calls[0][0].body).toEqual({ type: "itb" });
  expect(await screen.findByText("Line 1")).toBeInTheDocument();
  expect(screen.getByText(/Section 3.2, page 4/)).toBeInTheDocument();
  const panel = () => within(screen.getByTestId("bid-checklist-panel"));
  expect(panel().getByText("0/2")).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Line 1"));
  await waitFor(() => expect(tick).toHaveBeenCalled());
  expect(tick.mock.calls[0][0].body).toEqual({ checked: true });
  await waitFor(() => expect(panel().getByText("1/2")).toBeInTheDocument());
});

it("adds a custom line with its source text", async () => {
  const add = vi.fn(() => reply({ ok: true }, { status: 201 }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ checklist: [item(1)], checklist_progress: { checked: 0, required: 1, total: 1 } })),
    "POST /admin/bid-desk/b1/checklist": add,
  });
  renderPage();
  await screen.findByText("Line 1");
  fireEvent.change(screen.getByLabelText("New line"), { target: { value: "Bring the lift permit" } });
  fireEvent.change(screen.getByLabelText("Quote or page from the solicitation"), { target: { value: "Page 9, item 4" } });
  fireEvent.click(screen.getByRole("button", { name: "Add line" }));
  await waitFor(() => expect(add).toHaveBeenCalled());
  expect(add.mock.calls[0][0].body).toEqual({ label: "Bring the lift permit", sourceText: "Page 9, item 4" });
});

it("saves the type, the dates and the mandatory walk in one request", async () => {
  const patch = vi.fn(() => reply({ ok: true, bid: bid({ solicitation_type: "rfp" }) }));
  route({ "GET /admin/bid-desk/": LIST_ON, "GET /admin/bid-desk/b1": () => reply(detail()), "PATCH /admin/bid-desk/b1": patch });
  renderPage();
  fireEvent.change(await screen.findByLabelText("Solicitation type"), { target: { value: "rfp" } });
  fireEvent.change(screen.getByLabelText("How it is judged"), { target: { value: "scored" } });
  fireEvent.change(screen.getByLabelText(/Questions due/), { target: { value: "2026-10-10T17:00" } });
  fireEvent.change(screen.getByLabelText(/Site visit or job walk/), { target: { value: "2026-10-12T09:30" } });
  fireEvent.click(screen.getByLabelText("Mandatory"));
  fireEvent.click(screen.getByRole("button", { name: "Save bid details" }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch.mock.calls[0][0].body).toEqual({
    solicitationType: "rfp", scored: true, questionsDueAt: "2026-10-10T17:00", jobWalkAt: "2026-10-12T09:30", jobWalkMandatory: true,
  });
});

it("lists the documents and links an estimate to its proposal", async () => {
  const link = vi.fn(() => reply({ ok: true, bid: bid({ estimate_id: "e1" }) }));
  let linked = false;
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({
      bid: bid({ estimate_id: linked ? "e1" : null }),
      estimate: linked ? { id: "e1", slug: "EST-1001", name: "Fixture Build Co", status: "draft", proposal_path: "/admin/estimates/e1/proposal" } : null,
      documents: [{ id: "a1", name: "bid-form.pdf", size: 2048, email_id: "m1", email_subject: "Invite", gmail_attachment_id: "g1" }],
    })),
    "GET /admin/bid-desk/estimates?q=EST-1001": () => reply({ estimates: [{ id: "e1", slug: "EST-1001", name: "Fixture Build Co", proposal_path: "/admin/estimates/e1/proposal" }] }),
    "PATCH /admin/bid-desk/b1": (options) => { linked = true; return link(options); },
  });
  renderPage();
  expect(await screen.findByText("bid-form.pdf")).toBeInTheDocument();
  expect(screen.getByText("2 KB")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download bid-form.pdf" })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Find the estimate"), { target: { value: "EST-1001" } });
  fireEvent.click(screen.getByRole("button", { name: "Search estimates" }));
  fireEvent.click(await screen.findByRole("button", { name: "Link" }));
  await waitFor(() => expect(link).toHaveBeenCalled());
  expect(link.mock.calls[0][0].body).toEqual({ estimateId: "e1" });
  const open = await screen.findByRole("link", { name: "Open proposal" });
  expect(open).toHaveAttribute("href", "/admin/estimates/e1/proposal");
});

it("invites the submission record when Submitted is chosen, and saves it without requiring anything else", async () => {
  const patch = vi.fn(() => reply({ ok: true, bid: bid({ status: "submitted" }) }));
  route({ "GET /admin/bid-desk/": LIST_ON, "GET /admin/bid-desk/b1": () => reply(detail({ checklist: [item(1)], checklist_progress: { checked: 0, required: 1, total: 1 } })), "PATCH /admin/bid-desk/b1": patch });
  renderPage();
  await screen.findByText("Line 1");
  expect(screen.queryByText(/Record when the bid was handed in/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "submitted" } });
  expect(screen.getByText(/Record when the bid was handed in/)).toBeInTheDocument();
  expect(screen.getByText(/1 required lines are not checked yet/)).toBeInTheDocument();
  // Submitting with nothing typed is allowed.
  fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0][0].body).toEqual({ status: "submitted", decision_note: "" });
  fireEvent.change(screen.getByLabelText("Confirmation number or receipt"), { target: { value: "Receipt 55" } });
  fireEvent.click(screen.getByRole("button", { name: "Save submission" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][0].body).toEqual({ submittedAt: null, submissionConfirmation: "Receipt 55" });
  expect(within(screen.getByTestId("bid-checklist-panel")).getByText("Submission record")).toBeInTheDocument();
});

it("shows a template-read site visit date as unconfirmed and confirms it without retyping", async () => {
  const confirm = vi.fn(() => reply({ ok: true, bid: bid({ job_walk_at: "2026-10-09T13:30:00.000Z", job_walk_confirmed: true }) }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ bid: bid({ job_walk_at: "2026-10-09T13:30:00.000Z", job_walk_confirmed: false }) })),
    "PATCH /admin/bid-desk/b1": confirm,
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm site visit date" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(confirm.mock.calls[0][0].body).toEqual({ jobWalkConfirmed: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm site visit date" })).toBeNull());
});

it("shows no confirm button for a confirmed site visit date or when there is none", async () => {
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ bid: bid({ job_walk_at: "2026-10-09T13:30:00.000Z", job_walk_confirmed: true }) })),
  });
  renderPage();
  await screen.findByLabelText(/Site visit or job walk/);
  expect(screen.queryByRole("button", { name: "Confirm site visit date" })).toBeNull();
});

it("lists the stop checks first and marks them apart from the other lines", async () => {
  const lines = [item(1, { section: "stop", label: "Stop check: we hold the license" }), item(2, { section: "base", label: "Bid form used exactly as issued" })];
  route({ "GET /admin/bid-desk/": LIST_ON, "GET /admin/bid-desk/b1": () => reply(detail({ checklist: lines, checklist_progress: { checked: 0, required: 2, total: 2 } })) });
  renderPage();
  const stop = (await screen.findByLabelText("Stop check: we hold the license")).closest("li");
  const base = screen.getByLabelText("Bid form used exactly as issued").closest("li");
  expect(stop).toHaveAttribute("data-section", "stop");
  expect(base).toHaveAttribute("data-section", "base");
  expect(stop.compareDocumentPosition(base) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("saving only the type does not send the prefilled site visit or questions dates", async () => {
  const patch = vi.fn(() => reply({ ok: true, bid: bid({ solicitation_type: "itb" }) }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ bid: bid({ job_walk_at: "2026-10-09T13:30:00.000Z", job_walk_confirmed: false, questions_due_at: "2026-10-08T21:00:00.000Z" }) })),
    "PATCH /admin/bid-desk/b1": patch,
  });
  renderPage();
  fireEvent.change(await screen.findByLabelText("Solicitation type"), { target: { value: "itb" } });
  fireEvent.click(screen.getByRole("button", { name: "Save bid details" }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  const body = patch.mock.calls[0][0].body;
  expect(body).toEqual({ solicitationType: "itb" });
  expect(body).not.toHaveProperty("jobWalkAt");
  expect(body).not.toHaveProperty("questionsDueAt");
});

it("sends a date only after the operator edits that field", async () => {
  const patch = vi.fn(() => reply({ ok: true, bid: bid() }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ bid: bid({ job_walk_at: "2026-10-09T13:30:00.000Z", job_walk_confirmed: false }) })),
    "PATCH /admin/bid-desk/b1": patch,
  });
  renderPage();
  fireEvent.change(await screen.findByLabelText(/Site visit or job walk/), { target: { value: "2026-10-10T10:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save bid details" }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch.mock.calls[0][0].body).toEqual({ jobWalkAt: "2026-10-10T10:00" });
});

it("ticking a checklist line moves the chip in the list row at once", async () => {
  let progress = { checked: 0, required: 2, total: 2 };
  const tick = vi.fn(() => { progress = { checked: 1, required: 2, total: 2 }; return reply({ ok: true }); });
  route({
    "GET /admin/bid-desk/": () => reply({ checklist_live: true, bids: [bid({ checklist_progress: { checked: 0, required: 2 } })] }),
    "GET /admin/bid-desk/b1": () => reply(detail({ checklist: [item(1), item(2)], checklist_progress: progress })),
    "PATCH /admin/bid-desk/b1/checklist/i1": tick,
  });
  renderPage();
  const row = (await screen.findByRole("table"));
  expect(within(row).getByText("0/2")).toBeInTheDocument();
  fireEvent.click(await screen.findByLabelText("Line 1"));
  await waitFor(() => expect(tick).toHaveBeenCalled());
  await waitFor(() => expect(within(screen.getByRole("table")).getByText("1/2")).toBeInTheDocument());
  expect(within(screen.getByRole("table")).queryByText("0/2")).toBeNull();
});

it("with no live lines left, still offers Add missing lines for the bid's type and starts from it", async () => {
  const add = vi.fn(() => reply({ ok: true, added: 18 }, { status: 201 }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ bid: bid({ solicitation_type: "quote" }), checklist_missing: 18 })),
    "POST /admin/bid-desk/b1/checklist/start?add=missing": add,
  });
  renderPage();
  expect(await screen.findByRole("button", { name: "Start checklist" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add missing lines for this type" }));
  await waitFor(() => expect(add).toHaveBeenCalled());
  expect(add.mock.calls[0][0].body).toEqual({ type: "quote" });
});

it("offers no Add missing lines when nothing is missing, and shows the server's message when every template line was removed", async () => {
  const start = vi.fn(() => reply({ ok: true, added: 0, allRemoved: true, message: "All template lines for this type were removed. Add lines by hand." }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ bid: bid({ solicitation_type: "quote" }), checklist_missing: 0 })),
    "POST /admin/bid-desk/b1/checklist/start": start,
  });
  renderPage();
  const startButton = await screen.findByRole("button", { name: "Start checklist" });
  expect(screen.queryByRole("button", { name: "Add missing lines for this type" })).toBeNull();
  fireEvent.click(startButton);
  expect(await screen.findByText("All template lines for this type were removed. Add lines by hand.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add line" })).toBeInTheDocument();
});

it("downloads a document through the email attachment route, built by the page from the email id and the Gmail attachment id", async () => {
  URL.createObjectURL = vi.fn(() => "blob:fixture");
  URL.revokeObjectURL = vi.fn();
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ documents: [
      { id: "a1", name: "bid-form.pdf", size: 2048, email_id: "m1", email_subject: "Invite", gmail_attachment_id: "g/1" },
      { id: "a2", name: "no-download.txt", size: null, email_id: "m1", email_subject: "Invite", gmail_attachment_id: null },
    ] })),
    "GET /admin/email/message/m1/attachment/g%2F1": () => reply({}),
  });
  renderPage();
  expect(await screen.findByText("no-download.txt")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download no-download.txt" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download bid-form.pdf" }));
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  expect(adminFetch).toHaveBeenCalledWith("/admin/email/message/m1/attachment/g%2F1", { skipContentType: true });
});

it("offers Add missing lines once the type changes on a checklist that is already started", async () => {
  let type = "quote";
  const lines = [item(1, { template_key: "base.bid_form" }), item(2)];
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({
      bid: bid({ solicitation_type: type }), checklist: lines, checklist_progress: { checked: 0, required: 2, total: 2 },
      checklist_missing: type === "quote" ? 0 : 15,
    })),
    "PATCH /admin/bid-desk/b1": () => { type = "itb"; return reply({ ok: true, bid: bid({ solicitation_type: "itb" }) }); },
  });
  renderPage();
  await screen.findByLabelText("Line 1");
  expect(screen.queryByRole("button", { name: "Add missing lines for this type" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Solicitation type"), { target: { value: "itb" } });
  fireEvent.click(screen.getByRole("button", { name: "Save bid details" }));
  expect(await screen.findByRole("button", { name: "Add missing lines for this type" })).toBeInTheDocument();
});

it("edits a line's wording, source text and required flag", async () => {
  const edit = vi.fn(() => reply({ ok: true }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ checklist: [item(1, { source_text: "Page 3" })], checklist_progress: { checked: 0, required: 1, total: 1 } })),
    "PATCH /admin/bid-desk/b1/checklist/i1": edit,
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Edit: Line 1" }));
  const form = within(screen.getByLabelText("Line").closest("form"));
  fireEvent.change(screen.getByLabelText("Line"), { target: { value: "Line one, reworded" } });
  fireEvent.change(form.getByLabelText("Quote or page from the solicitation"), { target: { value: "Page 4, item 2" } });
  fireEvent.click(screen.getByLabelText("Required"));
  fireEvent.click(screen.getByRole("button", { name: "Save line" }));
  await waitFor(() => expect(edit).toHaveBeenCalled());
  expect(edit.mock.calls[0][0].body).toEqual({ label: "Line one, reworded", sourceText: "Page 4, item 2", required: false });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save line" })).toBeNull());
});

it("keeps the edit form open and shows the server's answer when a line cannot be saved", async () => {
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ checklist: [item(1)], checklist_progress: { checked: 0, required: 1, total: 1 } })),
    "PATCH /admin/bid-desk/b1/checklist/i1": () => reply({ error: "Invalid checklist update" }, { ok: false, status: 400 }),
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Edit: Line 1" }));
  fireEvent.change(screen.getByLabelText("Line"), { target: { value: "Changed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save line" }));
  expect(await screen.findByText("Not saved: Invalid checklist update")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save line" })).toBeInTheDocument();
});

it("offers Add missing lines for a bid with no solicitation type when template lines are missing", async () => {
  const add = vi.fn(() => reply({ ok: true, added: 10 }, { status: 201 }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => reply(detail({ bid: bid({ solicitation_type: null }), checklist: [item(1, { section: "custom", label: "By hand" })], checklist_progress: { checked: 0, required: 1, total: 1 }, checklist_missing: 10 })),
    "POST /admin/bid-desk/b1/checklist/start?add=missing": add,
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Add missing lines for this type" }));
  await waitFor(() => expect(add).toHaveBeenCalled());
  expect(add.mock.calls[0][0].body).toEqual({});
});

it("shows a plain error when the checklist cannot be reloaded, and clears it on the next success", async () => {
  let reloads = 0;
  const tick = vi.fn(() => reply({ ok: true }));
  route({
    "GET /admin/bid-desk/": LIST_ON,
    "GET /admin/bid-desk/b1": () => {
      reloads += 1;
      if (reloads === 2) return reply({ error: "boom" }, { ok: false, status: 500 }); // the reload after the first tick
      if (reloads === 3) return Promise.reject(new Error("network")); // the reload after the second
      return reply(detail({ checklist: [item(1)], checklist_progress: { checked: 0, required: 1, total: 1 } }));
    },
    "PATCH /admin/bid-desk/b1/checklist/i1": tick,
  });
  renderPage();
  fireEvent.click(await screen.findByLabelText("Line 1"));
  expect(await screen.findByText(/Could not reload the checklist/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Line 1"));
  await waitFor(() => expect(tick).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/Could not reload the checklist/)).toBeInTheDocument(); // a network failure shows it too
  fireEvent.click(screen.getByLabelText("Line 1"));
  await waitFor(() => expect(tick).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryByText(/Could not reload the checklist/)).toBeNull());
});
