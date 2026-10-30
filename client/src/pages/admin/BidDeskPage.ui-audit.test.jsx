// @vitest-environment jsdom
// Bid Desk screen fixes from the 2026-10-29 UI audit: opening a bid moves the page to it, a note save does not erase newer
// typing, a lost reply is not reported as "Not saved", a details save sends only what changed, and "Mark as bid" gives the
// right reason. Synthetic data only.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));
vi.mock("../../hooks/useFeatureFlag", () => ({ useFeatureFlag: () => false }));

import BidDeskPage from "./BidDeskPage";

const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
const bid = (over = {}) => ({
  id: "b1", source: "manual", status: "new", historical: false, project_title: "Fictional audit bid", due_at: null, due_confirmed: false,
  updated_at: "2026-10-29T12:00:00Z", solicitation_type: "itb", scored: false, job_walk_at: "2026-11-03T15:00:00Z", job_walk_confirmed: false,
  job_walk_mandatory: true, questions_due_at: "2026-11-01T15:00:00Z", estimate_id: null, ...over,
});
const line = (over = {}) => ({ id: "i1", label: "Example required document", position: 1, section: "base", required: true, checked_at: null, notes: "", ...over });
const detail = (lines = [line()]) => ({
  bid: bid(), emails: [], checklist_live: true, checklist: lines, checklist_progress: { checked: 0, required: lines.length, total: lines.length }, estimate: null, documents: [],
});
const renderPage = (url = "/?bid=b1") => render(<MemoryRouter initialEntries={[url]}><BidDeskPage /></MemoryRouter>);
const NOTE = "Note: Example required document";

let scrollIntoView;
let scrolled;
beforeEach(() => {
  adminFetch.mockReset();
  scrolled = [];
  scrollIntoView = vi.fn(function scroll() { scrolled.push(this); });
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => cleanup());

it("scrolls to the bid and focuses its heading after Open, and gives focus back to the row on Close", async () => {
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1") return reply(detail());
    throw new Error(`Unexpected ${path}`);
  });
  renderPage("/");
  const open = await screen.findByRole("button", { name: "Open Fictional audit bid" });
  fireEvent.click(open);
  const heading = await screen.findByRole("heading", { name: "Fictional audit bid" });
  await waitFor(() => expect(heading).toHaveFocus());
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
  expect(scrolled[0]).toBe(heading.closest("[data-bid-detail]"));

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Open Fictional audit bid" })).toHaveFocus());
});

it("does the same for a direct ?bid= link, and not again when the bid reloads", async () => {
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1" && options.method === "PATCH") return reply({ ok: true, bid: bid({ status: "bid" }) });
    if (path === "/admin/bid-desk/b1") return reply(detail());
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  const heading = await screen.findByRole("heading", { name: "Fictional audit bid" });
  await waitFor(() => expect(heading).toHaveFocus());
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
  await screen.findByText("Decision saved");
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

it("keeps a newer note draft when the earlier save's reload lands, and saves it on the next blur", async () => {
  let stored = "";
  const releases = [];
  const saved = [];
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1") return reply(detail([line({ notes: stored })]));
    if (path === "/admin/bid-desk/b1/checklist/i1") {
      saved.push(options.body.notes);
      return new Promise((resolve) => releases.push(() => { stored = options.body.notes; resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }); }));
    }
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  const input = await screen.findByLabelText(NOTE);
  input.focus();
  fireEvent.change(input, { target: { value: "First draft" } });
  input.blur();
  await waitFor(() => expect(releases).toHaveLength(1));
  input.focus();
  fireEvent.change(input, { target: { value: "First draft plus a later thought" } });
  await act(async () => { releases[0](); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Add line" }).closest("form")).toBeInTheDocument());
  await waitFor(() => expect(adminFetch.mock.calls.filter(([p]) => p === "/admin/bid-desk/b1").length).toBeGreaterThan(1));
  expect(input).toHaveValue("First draft plus a later thought");

  input.blur();
  await waitFor(() => expect(releases).toHaveLength(2));
  expect(saved).toEqual(["First draft", "First draft plus a later thought"]);
});

it("shows the unconfirmed message and reloads when a checklist reply is lost, so one line shows", async () => {
  let lines = [];
  let addCalls = 0;
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1") return reply(detail(lines));
    if (path === "/admin/bid-desk/b1/checklist" && options.method === "POST") {
      addCalls += 1;
      lines = [line({ id: "i9", label: "Bring the lift permit" })]; // the server wrote it; the reply never arrived
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  fireEvent.change(await screen.findByLabelText("New line"), { target: { value: "Bring the lift permit" } });
  fireEvent.click(screen.getByRole("button", { name: "Add line" }));
  expect(await screen.findByText("Could not confirm the save. The list below shows what the server has now.")).toBeInTheDocument();
  expect(screen.queryByText(/Not saved/)).toBeNull();
  expect(await screen.findAllByText("Bring the lift permit")).toHaveLength(1);
  expect(addCalls).toBe(1);
});

it("keeps 'Not saved: ...' for a refusal the server sent", async () => {
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1") return reply(detail());
    if (path === "/admin/bid-desk/b1/checklist" && options.method === "POST") return reply({ error: "Invalid checklist update" }, 400);
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  fireEvent.change(await screen.findByLabelText("New line"), { target: { value: "Anything" } });
  fireEvent.click(screen.getByRole("button", { name: "Add line" }));
  expect(await screen.findByText("Not saved: Invalid checklist update")).toBeInTheDocument();
  expect(screen.queryByText(/Could not confirm/)).toBeNull();
});

it("shows the unconfirmed message and reloads the bid when a bid save loses its reply", async () => {
  let reads = 0;
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1" && options.method === "PATCH") return Promise.reject(new TypeError("Failed to fetch"));
    if (path === "/admin/bid-desk/b1") { reads += 1; return reply(detail()); }
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Save decision" }));
  expect(await screen.findByText("Could not confirm the save. The list below shows what the server has now.")).toBeInTheDocument();
  await waitFor(() => expect(reads).toBe(2));
});

it("sends only the details the operator changed, and nothing when nothing changed", async () => {
  const patches = [];
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1" && options.method === "PATCH") { patches.push(options.body); return reply({ ok: true, bid: bid() }); }
    if (path === "/admin/bid-desk/b1") return reply(detail());
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  const save = await screen.findByRole("button", { name: "Save bid details" });
  fireEvent.click(save);
  expect(await screen.findByText("Nothing changed")).toBeInTheDocument();
  expect(patches).toHaveLength(0);

  fireEvent.change(screen.getByLabelText("Questions due (Eastern time)"), { target: { value: "2026-11-02T10:00" } });
  expect(screen.queryByText("Nothing changed")).toBeNull();
  fireEvent.click(save);
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ questionsDueAt: "2026-11-02T10:00" });
});

it("sends a changed type, judging and mandatory flag together", async () => {
  const patches = [];
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1" && options.method === "PATCH") { patches.push(options.body); return reply({ ok: true, bid: bid() }); }
    if (path === "/admin/bid-desk/b1") return reply(detail());
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  fireEvent.change(await screen.findByLabelText("Solicitation type"), { target: { value: "rfp" } });
  fireEvent.change(screen.getByLabelText("How it is judged"), { target: { value: "scored" } });
  fireEvent.click(screen.getByLabelText("Mandatory"));
  fireEvent.click(screen.getByRole("button", { name: "Save bid details" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ solicitationType: "rfp", scored: true, jobWalkMandatory: false });
});

it.each([
  [404, { error: "Email not found" }, "No email has that id"],
  [400, { error: "email_id required" }, "Enter the id from the email's address bar link (the id= part)"],
  [500, { error: "Database busy" }, "Could not mark it: Database busy. Try again."],
])("Mark as bid with a %s answer says: %s", async (status, body, text) => {
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [], checklist_live: true });
    if (path === "/admin/bid-desk/from-email" && options.method === "POST") return reply(body, status);
    throw new Error(`Unexpected ${path}`);
  });
  renderPage("/");
  const box = await screen.findByLabelText("Mark an email as a bid");
  fireEvent.change(box, { target: { value: "abc-123" } });
  fireEvent.click(screen.getByRole("button", { name: "Mark as bid" }));
  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(box).toHaveValue("abc-123");
});

it("Mark as bid with a dropped connection says it could not mark it, not that the id is wrong", async () => {
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [], checklist_live: true });
    if (path === "/admin/bid-desk/from-email" && options.method === "POST") return Promise.reject(new TypeError("Failed to fetch"));
    throw new Error(`Unexpected ${path}`);
  });
  renderPage("/");
  fireEvent.change(await screen.findByLabelText("Mark an email as a bid"), { target: { value: "abc-123" } });
  fireEvent.click(screen.getByRole("button", { name: "Mark as bid" }));
  expect(await screen.findByText("Could not mark it: Failed to fetch. Try again.")).toBeInTheDocument();
});

// In a browser the tap that blurs a note field starts the save before the tap's click lands. A save that locked the panel
// disabled the box under the finger and the tap was lost (seen in Chromium); a note save leaves the panel unlocked.
it("keeps the row's controls usable while a note save is in flight, and sends one note save at a time", async () => {
  const notePatches = [];
  const releases = [];
  const ticks = [];
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1") return reply(detail());
    if (path === "/admin/bid-desk/b1/checklist/i1" && "notes" in options.body) {
      notePatches.push(options.body.notes);
      return new Promise((resolve) => releases.push(() => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    }
    if (path === "/admin/bid-desk/b1/checklist/i1") { ticks.push(options.body); return reply({ ok: true }); }
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  const input = await screen.findByLabelText(NOTE);
  input.focus();
  fireEvent.change(input, { target: { value: "One" } });
  input.blur();
  await waitFor(() => expect(notePatches).toEqual(["One"]));

  const box = screen.getByLabelText("Example required document");
  expect(box).not.toBeDisabled();
  expect(screen.getByRole("button", { name: "Edit: Example required document" })).not.toBeDisabled();
  fireEvent.click(box);
  await waitFor(() => expect(ticks).toEqual([{ checked: true }]));

  input.focus();
  fireEvent.change(input, { target: { value: "One and two" } });
  input.blur();
  expect(notePatches).toEqual(["One"]); // not sent beside the one in flight
  await act(async () => { releases[0](); });
  await waitFor(() => expect(notePatches).toEqual(["One", "One and two"]));
});

it("sends a queued note draft even when a tick's reload brings back the older saved text after the field lost focus", async () => {
  let stored = "";
  const notePatches = [];
  const releases = [];
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/bid-desk/") return reply({ bids: [bid()], checklist_live: true });
    if (path === "/admin/bid-desk/b1") return reply(detail([line({ notes: stored })]));
    if (path === "/admin/bid-desk/b1/checklist/i1" && "notes" in options.body) {
      notePatches.push(options.body.notes);
      stored = options.body.notes; // committed on the server at once; only the reply is late
      return new Promise((resolve) => releases.push(() => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    }
    if (path === "/admin/bid-desk/b1/checklist/i1") return reply({ ok: true });
    throw new Error(`Unexpected ${path}`);
  });
  renderPage();
  const input = await screen.findByLabelText(NOTE);
  input.focus();
  fireEvent.change(input, { target: { value: "One" } });
  input.blur();
  await waitFor(() => expect(notePatches).toEqual(["One"]));

  input.focus();
  fireEvent.change(input, { target: { value: "One and two" } });
  input.blur(); // queued behind the save in flight; the field no longer has focus
  const reloads = adminFetch.mock.calls.filter(([p]) => p === "/admin/bid-desk/b1").length;
  fireEvent.click(screen.getByLabelText("Example required document")); // its reload returns the committed "One"
  await waitFor(() => expect(adminFetch.mock.calls.filter(([p]) => p === "/admin/bid-desk/b1").length).toBeGreaterThan(reloads));
  expect(input).toHaveValue("One and two");

  await act(async () => { releases[0](); });
  await waitFor(() => expect(notePatches).toEqual(["One", "One and two"]));
});
