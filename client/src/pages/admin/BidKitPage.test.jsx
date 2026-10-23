// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalogSections, buildChecklist, summarize } from "@bid-kit-catalog";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

import BidKitPage, { buildEntries } from "./BidKitPage";

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({ ok, status, json: async () => body });
const TODAY = "2026-10-23";

const row = (over = {}) => ({
  id: "i1", kind: "document", item_key: "business_license_copy", label: "FDACS business license copy", value: null, file: { name: "license.pdf", contentType: "application/pdf", size: 1200 },
  limits: null, details: null, source_document: "FDACS renewal letter", checked_on: "2026-10-01", expires_on: "2027-06-30", permission_on: null,
  attested_by: null, attested_at: null, notes: null, archived_at: null, status: "unattested", updated_at: "2026-10-02T12:00:00.000Z", ...over,
});
const ITEMS = [
  row(),
  row({ id: "i2", item_key: "cpco_certificate", label: "Certified operator certificate and current renewal", status: "expired", expires_on: "2026-09-01", source_document: null, checked_on: null }),
  row({ id: "i3", item_key: "insurance_certificate", label: "Certificate of insurance", status: "expiring", expires_on: "2026-11-05", attested_at: "2026-10-03T15:00:00.000Z", limits: { glEachOccurrence: 1000000, workersComp: "statutory" } }),
  row({ id: "i8", item_key: "business_tax_receipt", label: "Local business tax receipt", status: "needs_expiry", expires_on: null }),
  row({ id: "i4", item_key: "w9", label: "W-9", status: "ready", expires_on: null, attested_at: "2026-10-03T15:00:00.000Z" }),
  row({ id: "i5", kind: "reference", item_key: "reference", label: "Customer reference", file: null, status: "needs_permission", details: { entity: "Sample District", contactRole: "Facilities lead" }, expires_on: null }),
  row({ id: "i6", kind: "fact", item_key: "legal_name", label: "Legal name", file: null, value: "Example Pest Services LLC", status: "unattested", expires_on: null, source_document: null, checked_on: null }),
  row({ id: "i7", item_key: "ipm_plan", label: "IPM plan", file: null, status: "missing", expires_on: null }),
];
const payload = (items = ITEMS) => ({
  today: TODAY,
  catalog: catalogSections(),
  items,
  summary: summarize(buildChecklist(items.map((item) => ({ ...item, has_file: !!item.file })), { today: TODAY })),
});

function route(handlers) {
  adminFetch.mockImplementation((path, options = {}) => {
    const key = `${options.method || "GET"} ${path}`;
    const handler = handlers[key];
    if (!handler) return reply({ error: `unexpected ${key}` }, { ok: false, status: 500 });
    return handler(options);
  });
}
const renderPage = (url = "/") => render(<MemoryRouter initialEntries={[url]}><BidKitPage /></MemoryRouter>);
const rowFor = (label) => screen.getByRole("heading", { level: 3, name: label }).closest("li");

beforeEach(() => adminFetch.mockReset());
afterEach(() => cleanup());

it("shows each item's status chip in catalog order, with the summary line and the section counts", async () => {
  route({ "GET /admin/bid-kit/": () => reply(payload()) });
  renderPage();
  expect(await screen.findByText("FDACS business license copy")).toBeInTheDocument();

  // Ready and expiring count together as ready; expiring soon is shown beside it.
  const { overall } = payload().summary;
  expect(overall).toMatchObject({ ready: 2, expiring: 1, needs_expiry: 1 });
  expect(screen.getByTestId("bid-kit-summary")).toHaveTextContent(`${overall.ready} of ${overall.total} ready · 1 expiring soon`);
  expect(screen.getByTestId("bid-kit-summary")).toHaveTextContent("1 need an expiry date");

  expect(within(rowFor("FDACS business license copy")).getByText("Needs sign-off")).toBeInTheDocument();
  expect(within(rowFor("Certified operator certificate and current renewal")).getByText("Expired")).toBeInTheDocument();
  expect(within(rowFor("Certificate of insurance")).getByText("Expiring soon")).toBeInTheDocument();
  expect(within(rowFor("Local business tax receipt")).getByText("Add expiry date")).toBeInTheDocument();
  expect(within(rowFor("W-9")).getByText("Ready")).toBeInTheDocument();
  expect(within(rowFor("Customer reference")).getByText("Needs permission")).toBeInTheDocument();
  expect(within(rowFor("IPM plan")).getByText("Missing")).toBeInTheDocument();
  // An item with no row yet is listed as missing, with its reason.
  expect(within(rowFor("Notarized statement: the certified operator in charge works full-time for us")).getByText("Missing")).toBeInTheDocument();

  const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
  expect(headings.slice(0, 3).map((text) => text.replace(/\d+ of \d+ ready$/, ""))).toEqual(["Papers that sank bids", "Insurance", "Registration and tax"]);
  expect(screen.getAllByText("New one for each bid")).toHaveLength(2); // the notarized statement and the insurance certificate
  expect(screen.getByText("Notarized")).toBeInTheDocument();
  expect(within(rowFor("FDACS business license copy")).getByText(/FDACS renewal letter/)).toBeInTheDocument();
  expect(within(rowFor("FDACS business license copy")).getByText(/checked Oct 1, 2026/)).toBeInTheDocument();
  expect(screen.getAllByText(/\$1,000,000/).length).toBeGreaterThan(0);
});

it("the Sign off button works only for an item that is there, not expired and with an expiry date when it needs one", async () => {
  route({ "GET /admin/bid-kit/": () => reply(payload()) });
  renderPage();
  await screen.findByText("FDACS business license copy");
  const signOff = (label) => within(rowFor(label)).getByRole("button", { name: "Sign off" });
  expect(signOff("FDACS business license copy")).toBeEnabled();
  expect(signOff("Certificate of insurance")).toBeDisabled(); // signed off already, expiring soon
  expect(signOff("Customer reference")).toBeEnabled();
  expect(signOff("Certified operator certificate and current renewal")).toBeDisabled(); // expired
  expect(signOff("Certified operator certificate and current renewal")).toHaveAttribute("title", "This item has expired. Replace it before you sign off.");
  expect(signOff("Local business tax receipt")).toBeDisabled(); // no expiry date yet
  expect(signOff("Local business tax receipt")).toHaveAttribute("title", "Add the expiry date first.");
  expect(signOff("W-9")).toBeDisabled(); // already signed off
  expect(signOff("IPM plan")).toBeDisabled(); // missing
  expect(within(rowFor("Notarized statement: the certified operator in charge works full-time for us")).queryByRole("button", { name: "Sign off" })).toBeNull(); // no row yet
});

it("Sign off posts the version the owner looked at, then reads the kit again", async () => {
  const signed = ITEMS.map((item) => (item.id === "i1" ? { ...item, status: "ready", attested_at: "2026-10-23T16:00:00.000Z", updated_at: "2026-10-23T16:00:00.000Z" } : item));
  let reads = 0;
  const attest = vi.fn(() => reply({ item: signed[0] }));
  route({
    "GET /admin/bid-kit/": () => reply(payload(reads++ === 0 ? ITEMS : signed)),
    "POST /admin/bid-kit/i1/attest": attest,
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Sign off" }));
  await waitFor(() => expect(attest).toHaveBeenCalledTimes(1));
  expect(attest.mock.calls[0][0]).toMatchObject({ method: "POST", body: { expected_updated_at: "2026-10-02T12:00:00.000Z" } });
  await waitFor(() => expect(within(rowFor("FDACS business license copy")).getByText("Ready")).toBeInTheDocument());
  expect(screen.getByTestId("bid-kit-summary")).toHaveTextContent(/3 of \d+ ready · 1 expiring soon/);
  expect(screen.getByText("Signed off")).toBeInTheDocument();
});

const CONFLICT = "Someone else changed this item. Here is the latest version; make your change again.";

it("a sign-off the server refuses as out of date says so, closes any open editor and reloads", async () => {
  let reads = 0;
  route({
    "GET /admin/bid-kit/": () => { reads += 1; return reply(payload()); },
    "POST /admin/bid-kit/i1/attest": () => reply({ error: "This item changed since you opened it. Reload and check it again." }, { ok: false, status: 409 }),
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("W-9")).getByRole("button", { name: "Edit" })); // an editor open on another row
  expect(screen.getByRole("form", { name: "Edit W-9" })).toBeInTheDocument();
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Sign off" }));
  expect(await screen.findByText(CONFLICT)).toBeInTheDocument();
  expect(reads).toBe(2);
  expect(screen.queryByRole("form", { name: "Edit W-9" })).toBeNull();
});

it("a sign-off time is an instant shown in Eastern time with the zone named, while calendar dates stay plain days", async () => {
  // 3:30 AM UTC on Oct 24 is 11:30 PM Eastern on Oct 23: the date must not roll to the 24th.
  const late = ITEMS.map((item) => (item.id === "i4" ? { ...item, attested_at: "2026-10-24T03:30:00.000Z" } : item));
  route({ "GET /admin/bid-kit/": () => reply(payload(late)) });
  renderPage();
  await screen.findByText("FDACS business license copy");
  const w9 = rowFor("W-9");
  expect(within(w9).getByText("Signed off Oct 23, 2026 at 11:30 PM ET")).toBeInTheDocument();
  expect(within(w9).queryByText(/Oct 24/)).toBeNull();
  // A date column that arrives as a UTC-midnight instant stays the same calendar day: expires 2027-06-30, checked 2026-10-01.
  const license = rowFor("FDACS business license copy");
  expect(within(license).getByText("Jun 30, 2027")).toBeInTheDocument();
  expect(within(license).getByText(/checked Oct 1, 2026/)).toBeInTheDocument();
});

it("the editor will not take a check or permission date after today (Eastern), and an expiry may be ahead", async () => {
  route({ "GET /admin/bid-kit/": () => reply(payload()) });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Checked on")).toHaveAttribute("max", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  expect(screen.getByLabelText("Expires on")).not.toHaveAttribute("max");
  cleanup();
  renderPage();
  await screen.findByText("Customer reference");
  fireEvent.click(within(rowFor("Customer reference")).getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Permission given on")).toHaveAttribute("max", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
});

it("a 409 on save closes the editor, shows the latest version, and a second save cannot send the old fields", async () => {
  const theirs = ITEMS.map((item) => (item.id === "i1" ? { ...item, source_document: "Other admin's letter", updated_at: "2026-10-23T18:00:00.000Z" } : item));
  let reads = 0;
  const patch = vi.fn()
    .mockImplementationOnce(() => reply({ error: "This item changed since you opened it. Reload and check it again." }, { ok: false, status: 409 }))
    .mockImplementation(() => reply({ item: theirs[0] }));
  route({ "GET /admin/bid-kit/": () => reply(payload(reads++ === 0 ? ITEMS : theirs)), "PATCH /admin/bid-kit/i1": patch });
  renderPage();
  await screen.findByText("FDACS business license copy");

  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Source document"), { target: { value: "My own letter" } });
  fireEvent.change(screen.getByLabelText("Number or note"), { target: { value: "MY-NUMBER" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText(CONFLICT)).toBeInTheDocument();
  expect(patch).toHaveBeenCalledTimes(1);
  expect(patch.mock.calls[0][0].body).toMatchObject({ source_document: "My own letter", expected_updated_at: "2026-10-02T12:00:00.000Z" });
  // The editor is closed: there is no Save button that could send the old fields with the new version.
  expect(screen.queryByRole("form", { name: "Edit FDACS business license copy" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  // The row shows the latest version.
  await waitFor(() => expect(within(rowFor("FDACS business license copy")).getByText(/Other admin's letter/)).toBeInTheDocument());
  expect(screen.queryByText(/My own letter/)).toBeNull();

  // Opening Edit again starts from the fresh row; saving sends fresh values with the fresh version.
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Source document")).toHaveValue("Other admin's letter");
  expect(screen.getByLabelText("Number or note")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][0].body).toMatchObject({ source_document: "Other admin's letter", expected_updated_at: "2026-10-23T18:00:00.000Z" });
  expect(JSON.stringify(patch.mock.calls[1][0].body)).not.toMatch(/My own letter|MY-NUMBER/);
});

it("a 409 when adding a new item (it already exists) also closes the editor and says what happened", async () => {
  const create = vi.fn(() => reply({ error: "This item already exists. Edit it instead." }, { ok: false, status: 409 }));
  route({ "GET /admin/bid-kit/": () => reply(payload()), "POST /admin/bid-kit/": create });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("Notarized statement: the certified operator in charge works full-time for us")).getByRole("button", { name: "Add details" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(CONFLICT)).toBeInTheDocument();
  expect(screen.queryAllByRole("button", { name: "Save" })).toHaveLength(0);
});

it("an editor never outlives the version it was opened on: a reload that moves the row resets its fields", async () => {
  const signed = ITEMS.map((item) => (item.id === "i1" ? { ...item, status: "ready", attested_at: "2026-10-23T16:00:00.000Z", updated_at: "2026-10-23T16:00:00.000Z", source_document: "Newer letter" } : item));
  let reads = 0;
  route({
    "GET /admin/bid-kit/": () => reply(payload(reads++ === 0 ? ITEMS : signed)),
    "POST /admin/bid-kit/i1/attest": () => reply({ item: signed[0] }),
    "POST /admin/bid-kit/i1/file": () => reply({ item: signed[0] }),
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Source document"), { target: { value: "Typed but not saved" } });
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Sign off" }));
  await waitFor(() => expect(within(rowFor("FDACS business license copy")).getByText("Ready")).toBeInTheDocument());
  expect(screen.getByLabelText("Source document")).toHaveValue("Newer letter"); // fresh row, not the typed text
});

it("Edit saves against the loaded version and warns that a change clears the sign-off", async () => {
  const patch = vi.fn(() => reply({ item: ITEMS[0] }));
  route({ "GET /admin/bid-kit/": () => reply(payload()), "PATCH /admin/bid-kit/i1": patch });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Edit" }));
  expect(screen.getByText(/clears the sign-off/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Source document"), { target: { value: "FDACS renewal letter, Oct 2026" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0][0].body).toMatchObject({ source_document: "FDACS renewal letter, Oct 2026", expected_updated_at: "2026-10-02T12:00:00.000Z", expires_on: "2027-06-30" });
});

it("insurance limits are whole dollars: a decimal is caught before anything is sent", async () => {
  const patch = vi.fn(() => reply({ item: ITEMS[2] }));
  route({ "GET /admin/bid-kit/": () => reply(payload()), "PATCH /admin/bid-kit/i3": patch });
  renderPage();
  await screen.findByText("Certificate of insurance");
  fireEvent.click(within(rowFor("Certificate of insurance")).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("General liability, aggregate"), { target: { value: "2,000,000.50" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/must be a whole number of dollars/)).toBeInTheDocument();
  expect(patch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("General liability, aggregate"), { target: { value: "$2,000,000" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0][0].body.limits).toEqual({ glEachOccurrence: 1000000, glAggregate: 2000000, workersComp: "statutory" });
});

it("uploading a file on an item with no row creates the row first, then sends the file with that row's version", async () => {
  const blank = row({ id: "new1", item_key: "ipm_plan", file: null, status: "missing", updated_at: "2026-10-23T17:00:00.000Z" });
  const created = vi.fn(() => reply({ item: blank }, { status: 201 }));
  const uploaded = vi.fn(() => reply({ item: row({ id: "new1", item_key: "ipm_plan" }) }));
  route({ "GET /admin/bid-kit/": () => reply(payload(ITEMS.filter((item) => item.id !== "i7"))), "POST /admin/bid-kit/": created, "POST /admin/bid-kit/new1/file": uploaded });
  renderPage();
  await screen.findByText("FDACS business license copy");
  const input = within(rowFor("IPM plan")).getByLabelText("File for IPM plan");
  const file = new File(["%PDF-1.4"], "ipm.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(uploaded).toHaveBeenCalledTimes(1));
  expect(created.mock.calls[0][0].body).toEqual({ kind: "document", item_key: "ipm_plan" });
  expect(uploaded.mock.calls[0][0].body).toBeInstanceOf(FormData);
  expect(uploaded.mock.calls[0][0].body.get("file").name).toBe("ipm.pdf");
  expect(uploaded.mock.calls[0][0].body.get("expected_updated_at")).toBe("2026-10-23T17:00:00.000Z");
});

const ARCHIVE_I1 = "DELETE /admin/bid-kit/i1?expected_updated_at=2026-10-02T12%3A00%3A00.000Z";

it("Archive sends the version the page loaded, then reads the list again", async () => {
  let reads = 0;
  const archive = vi.fn(() => reply({ success: true }));
  route({ "GET /admin/bid-kit/": () => reply(payload(reads++ === 0 ? ITEMS : ITEMS.filter((item) => item.id !== "i1"))), [ARCHIVE_I1]: archive });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
  expect(archive.mock.calls[0][0].method).toBe("DELETE");
  expect(await screen.findByText("Archived")).toBeInTheDocument();
  await waitFor(() => expect(within(rowFor("FDACS business license copy")).getByText("Missing")).toBeInTheDocument()); // back to an empty slot
  expect(screen.queryByRole("form", { name: "Edit FDACS business license copy" })).toBeNull();
});

it("a 409 on Archive (another admin changed the item) archives nothing, closes the editor, reloads and shows the latest row", async () => {
  const theirs = ITEMS.map((item) => (item.id === "i1" ? { ...item, source_document: "Renewed by another admin", updated_at: "2026-10-23T18:00:00.000Z" } : item));
  let reads = 0;
  const archive = vi.fn(() => reply({ error: "This item changed since you opened it. Reload and check it again." }, { ok: false, status: 409 }));
  route({ "GET /admin/bid-kit/": () => reply(payload(reads++ === 0 ? ITEMS : theirs)), [ARCHIVE_I1]: archive });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect(await screen.findByText(CONFLICT)).toBeInTheDocument();
  expect(archive).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("form", { name: "Edit FDACS business license copy" })).toBeNull();
  await waitFor(() => expect(within(rowFor("FDACS business license copy")).getByText(/Renewed by another admin/)).toBeInTheDocument());
  expect(within(rowFor("FDACS business license copy")).getByText("Needs sign-off")).toBeInTheDocument(); // still there
  expect(screen.queryByText("Archived")).toBeNull();
});

// An item with no row yet: the page creates a blank row, then uploads to it. The row is never archived by the page.
const BLANK = row({ id: "new1", item_key: "ipm_plan", label: "IPM plan", file: null, status: "missing", updated_at: "2026-10-23T17:00:00.000Z" });
const WITHOUT_PLAN = ITEMS.filter((item) => item.id !== "i7");
const pdf = (name = "ipm.pdf") => new File(["%PDF-1.4"], name, { type: "application/pdf" });

it("a failed first upload leaves the created row in place, and a retry uploads to that same row: one row, file stored on it, nothing archived", async () => {
  let created = false;
  let tries = 0;
  const create = vi.fn(() => { created = true; return reply({ item: BLANK }, { status: 201 }); });
  const send = vi.fn(() => (tries++ === 0
    ? reply({ error: "File storage is not configured" }, { ok: false, status: 500 })
    : reply({ item: row({ ...BLANK, file: { name: "ipm.pdf", contentType: "application/pdf", size: 8 }, status: "unattested" }) })));
  const archive = vi.fn(() => reply({ success: true }));
  route({
    "GET /admin/bid-kit/": () => reply(payload(created ? [...WITHOUT_PLAN, BLANK] : WITHOUT_PLAN)),
    "POST /admin/bid-kit/": create,
    "POST /admin/bid-kit/new1/file": send,
    "DELETE /admin/bid-kit/new1": archive,
  });
  renderPage();
  await screen.findByText("FDACS business license copy");

  fireEvent.change(within(rowFor("IPM plan")).getByLabelText("File for IPM plan"), { target: { files: [pdf()] } });
  expect(await screen.findByText(/Not saved: File storage is not configured The item was added without a file/)).toBeInTheDocument();
  // The page read the list again: the created row is there, missing, with its own Upload file button, and was not archived.
  await waitFor(() => expect(document.getElementById("bid-kit-new1")).not.toBeNull());
  expect(within(rowFor("IPM plan")).getByText("Missing")).toBeInTheDocument();
  expect(archive).not.toHaveBeenCalled();

  // Retry: the upload goes to the same row, with that row's version, and no second row is created.
  fireEvent.change(within(rowFor("IPM plan")).getByLabelText("File for IPM plan"), { target: { files: [pdf()] } });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(create).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[1][0].body.get("expected_updated_at")).toBe("2026-10-23T17:00:00.000Z");
  expect(archive).not.toHaveBeenCalled();
  expect(screen.getAllByRole("heading", { level: 3, name: "IPM plan" })).toHaveLength(1);
});

it("another admin's update between the create and the upload: the upload's 409 archives nothing, closes the editors and shows the latest row", async () => {
  let created = false;
  const theirs = row({ ...BLANK, source_document: "Other admin's note", updated_at: "2026-10-23T17:05:00.000Z" });
  const archive = vi.fn(() => reply({ success: true }));
  route({
    "GET /admin/bid-kit/": () => reply(payload(created ? [...WITHOUT_PLAN, theirs] : WITHOUT_PLAN)),
    "POST /admin/bid-kit/": () => { created = true; return reply({ item: BLANK }, { status: 201 }); },
    "POST /admin/bid-kit/new1/file": () => reply({ error: "This item changed since you opened it. Reload and check it again." }, { ok: false, status: 409 }),
    "DELETE /admin/bid-kit/new1": archive,
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("W-9")).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(rowFor("IPM plan")).getByLabelText("File for IPM plan"), { target: { files: [pdf()] } });
  expect(await screen.findByText(CONFLICT)).toBeInTheDocument();
  await waitFor(() => expect(within(rowFor("IPM plan")).getByText(/Other admin's note/)).toBeInTheDocument());
  expect(archive).not.toHaveBeenCalled();
  expect(screen.queryByRole("form", { name: "Edit W-9" })).toBeNull();
});

it("a lost answer after a successful upload archives nothing: the reload shows the stored file", async () => {
  let created = false;
  let stored = false;
  const withFile = row({ ...BLANK, file: { name: "ipm.pdf", contentType: "application/pdf", size: 8 }, status: "unattested", updated_at: "2026-10-23T17:02:00.000Z" });
  const archive = vi.fn(() => reply({ success: true }));
  route({
    "GET /admin/bid-kit/": () => reply(payload(created ? [...WITHOUT_PLAN, stored ? withFile : BLANK] : WITHOUT_PLAN)),
    "POST /admin/bid-kit/": () => { created = true; return reply({ item: BLANK }, { status: 201 }); },
    // The server stored the file, but the answer never reached the page.
    "POST /admin/bid-kit/new1/file": () => { stored = true; return Promise.reject(new TypeError("Failed to fetch")); },
    "DELETE /admin/bid-kit/new1": archive,
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.change(within(rowFor("IPM plan")).getByLabelText("File for IPM plan"), { target: { files: [pdf()] } });
  expect(await screen.findByText("Could not confirm the save. The list below shows what the server has now.")).toBeInTheDocument();
  expect(screen.queryByText(/Not saved/)).toBeNull();
  await waitFor(() => expect(within(rowFor("IPM plan")).getByText("ipm.pdf")).toBeInTheDocument());
  expect(within(rowFor("IPM plan")).getByRole("button", { name: "Open file" })).toBeInTheDocument();
  expect(archive).not.toHaveBeenCalled();
});

it("a failed upload on a row that already exists reads the list again and never creates or archives anything", async () => {
  let reads = 0;
  const send = vi.fn(() => reply({ error: "The file is larger than 15 MB" }, { ok: false, status: 413 }));
  const unexpected = vi.fn(() => reply({}));
  route({ "GET /admin/bid-kit/": () => { reads += 1; return reply(payload()); }, "POST /admin/bid-kit/i7/file": send, "POST /admin/bid-kit/": unexpected, "DELETE /admin/bid-kit/i7": unexpected });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.change(within(rowFor("IPM plan")).getByLabelText("File for IPM plan"), { target: { files: [pdf("big.pdf")] } });
  expect(await screen.findByText(/Not saved: The file is larger than 15 MB/)).toBeInTheDocument();
  await waitFor(() => expect(reads).toBe(2));
  expect(unexpected).not.toHaveBeenCalled();
});

// A tab opened after an await is a pop-up the browser blocks, so the tab opens inside the click and the link goes in after.
const fakeTab = () => ({ opener: "page", location: { href: "" }, close: vi.fn() });

it("Open file opens the tab inside the click, then points it at the signed link", async () => {
  const tab = fakeTab();
  const open = vi.spyOn(window, "open").mockReturnValue(tab);
  let release;
  route({
    "GET /admin/bid-kit/": () => reply(payload()),
    "GET /admin/bid-kit/i1/file": () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ url: "https://storage.example.test/signed", file_name: "license.pdf", expires_in: 300 }) }); }),
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Open file" }));
  // The tab exists before the link has come back.
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith("", "_blank");
  expect(tab.opener).toBeNull();
  expect(tab.location.href).toBe("");
  await waitFor(() => expect(release).toBeTypeOf("function"));
  release();
  await waitFor(() => expect(tab.location.href).toBe("https://storage.example.test/signed"));
  expect(tab.close).not.toHaveBeenCalled();
  open.mockRestore();
});

it("Open file closes the tab it opened and says why when the link cannot be fetched", async () => {
  const tab = fakeTab();
  const open = vi.spyOn(window, "open").mockReturnValue(tab);
  route({ "GET /admin/bid-kit/": () => reply(payload()), "GET /admin/bid-kit/i1/file": () => reply({ error: "Not found" }, { ok: false, status: 404 }) });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Open file" }));
  expect(await screen.findByText(/Could not open the file: Not found/)).toBeInTheDocument();
  expect(tab.close).toHaveBeenCalledTimes(1);
  expect(tab.location.href).toBe("");
  open.mockRestore();
});

it("Open file says so when the browser blocks the tab, and asks the server for nothing", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const link = vi.fn(() => reply({ url: "https://storage.example.test/signed" }));
  route({ "GET /admin/bid-kit/": () => reply(payload()), "GET /admin/bid-kit/i1/file": link });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Open file" }));
  expect(await screen.findByText(/blocked the new tab/)).toBeInTheDocument();
  expect(link).not.toHaveBeenCalled();
  open.mockRestore();
});

it("a file replacement carries the version the page loaded, and a 409 closes the editors and reloads", async () => {
  let reads = 0;
  const send = vi.fn(() => reply({ error: "This item changed since you opened it. Reload and check it again." }, { ok: false, status: 409 }));
  route({ "GET /admin/bid-kit/": () => { reads += 1; return reply(payload()); }, "POST /admin/bid-kit/i1/file": send });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("W-9")).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(rowFor("FDACS business license copy")).getByLabelText("File for FDACS business license copy"), { target: { files: [new File(["%PDF-1.4"], "new.pdf", { type: "application/pdf" })] } });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const form = send.mock.calls[0][0].body;
  expect(form.get("expected_updated_at")).toBe("2026-10-02T12:00:00.000Z");
  expect(form.get("file").name).toBe("new.pdf");
  expect(await screen.findByText(CONFLICT)).toBeInTheDocument();
  expect(reads).toBe(2);
  expect(screen.queryByRole("form", { name: "Edit W-9" })).toBeNull();
});

it("the facts sheet lists each value with a Copy button and copies it", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  route({
    "GET /admin/bid-kit/": () => reply(payload()),
    "GET /admin/bid-kit/facts-sheet": () => reply({
      today: TODAY,
      facts: [
        { key: "legal_name", label: "Legal name", value: "Example Pest Services LLC", status: "unattested", signedOff: false, checkedOn: null },
        { key: "phone", label: "Phone", value: "941-555-0100", status: "ready", signedOff: true, checkedOn: "2026-10-01" },
        { key: "sam_uei", label: "SAM unique entity ID", value: null, status: "missing", signedOff: false, checkedOn: null },
      ],
      documents: [{ key: "business_license_copy", label: "FDACS business license copy", number: "JB000000", expiresOn: "2027-06-30", status: "ready", signedOff: true }],
    }),
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(screen.getByRole("button", { name: "Facts sheet" }));
  expect(await screen.findByText("Example Pest Services LLC")).toBeInTheDocument();
  expect(screen.getByText("Not signed off")).toBeInTheDocument(); // only the unsigned fact carries it
  expect(screen.getByText("Not filled in")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(4); // two facts, the license number and its expiry date
  fireEvent.click(screen.getByRole("button", { name: "Copy Phone" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("941-555-0100"));
  fireEvent.click(screen.getByRole("button", { name: "Copy FDACS business license copy expiry date" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("2027-06-30"));
});

it("opens at the item a bell linked to, and says so when the gate is off", async () => {
  route({ "GET /admin/bid-kit/": () => reply(payload()) });
  renderPage("/?item=i3");
  await screen.findByText("Certificate of insurance");
  expect(document.getElementById("bid-kit-i3")).toHaveClass("border-zinc-900");
  cleanup();
  route({ "GET /admin/bid-kit/": () => reply({ error: "Not found" }, { ok: false, status: 404 }) });
  renderPage();
  expect(await screen.findByText("Bid kit is not turned on yet.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Facts sheet" })).toBeNull();
});

it("adding a custom item shows the fields for the type picked, and updates when the type changes", async () => {
  const create = vi.fn(() => reply({ item: row({ id: "c9", item_key: "custom", label: "County vendor letter", status: "unattested" }) }, { status: 201 }));
  route({ "GET /admin/bid-kit/": () => reply(payload()), "POST /admin/bid-kit/": create });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(screen.getByRole("button", { name: "Add another item" }));
  const has = (label) => screen.queryByLabelText(label) !== null;

  // Document (the default): number, source, checked, expiry, limits; no reference fields.
  expect(screen.getByLabelText("Type")).toHaveValue("document");
  expect(has("Number or note")).toBe(true);
  expect(has("Expires on")).toBe(true);
  expect(has("General liability, aggregate")).toBe(true);
  expect(has("Entity")).toBe(false);
  expect(has("Permission given on")).toBe(false);

  // Reference: details and the permission date; no value, expiry or limits.
  fireEvent.change(screen.getByLabelText("Type"), { target: { value: "reference" } });
  expect(has("Entity")).toBe(true);
  expect(has("Permission given on")).toBe(true);
  expect(has("Source document")).toBe(true);
  expect(has("Number or note")).toBe(false);
  expect(has("Value")).toBe(false);
  expect(has("Expires on")).toBe(false);
  expect(has("General liability, aggregate")).toBe(false);

  // Fact: a value and a source; nothing else.
  fireEvent.change(screen.getByLabelText("Type"), { target: { value: "fact" } });
  expect(has("Value")).toBe(true);
  expect(has("Source document")).toBe(true);
  expect(has("Number or note")).toBe(false);
  expect(has("Expires on")).toBe(false);
  expect(has("Entity")).toBe(false);
  expect(has("Permission given on")).toBe(false);
  expect(has("General liability, aggregate")).toBe(false);

  // What is sent matches the type on screen at the time of Save.
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Insurance agent phone" } });
  fireEvent.change(screen.getByLabelText("Value"), { target: { value: "941-555-0100" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const body = create.mock.calls[0][0].body;
  expect(body).toMatchObject({ kind: "fact", item_key: "custom", label: "Insurance agent phone", value: "941-555-0100" });
  expect(body).not.toHaveProperty("expires_on");
  expect(body).not.toHaveProperty("limits");
  expect(body).not.toHaveProperty("details");
});

it("a custom reference is saved with its details and permission date, and no value", async () => {
  const create = vi.fn(() => reply({ item: row({ id: "c8", item_key: "custom", kind: "reference", label: "Sample HOA", status: "needs_permission" }) }, { status: 201 }));
  route({ "GET /admin/bid-kit/": () => reply(payload()), "POST /admin/bid-kit/": create });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(screen.getByRole("button", { name: "Add another item" }));
  fireEvent.change(screen.getByLabelText("Type"), { target: { value: "reference" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sample HOA" } });
  fireEvent.change(screen.getByLabelText("Entity"), { target: { value: "Sample HOA" } });
  fireEvent.change(screen.getByLabelText("Permission given on"), { target: { value: "2026-10-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const body = create.mock.calls[0][0].body;
  expect(body).toMatchObject({ kind: "reference", item_key: "custom", label: "Sample HOA", details: { entity: "Sample HOA" }, permission_on: "2026-10-01" });
  expect(body).not.toHaveProperty("value");
});

it("buildEntries lays the server's items over the catalog and sends custom rows to the last section", () => {
  const sections = buildEntries(catalogSections(), [...ITEMS, row({ id: "c1", item_key: "custom", label: "County vendor letter", status: "unattested" }), row({ id: "gone", item_key: "w9", archived_at: "2026-10-01T00:00:00Z" })]);
  expect(sections.map((section) => section.key)).toEqual(["sank_bids", "insurance", "registration_tax", "plans_company", "references", "facts", "other"]);
  expect(sections[0].entries.map((entry) => entry.status)).toEqual(["unattested", "expired", "missing", "missing", "missing"]);
  expect(sections[2].entries.find((entry) => entry.item.key === "business_tax_receipt").status).toBe("needs_expiry");
  expect(sections.at(-1).entries[0].row.label).toBe("County vendor letter");
  expect(sections[2].entries.find((entry) => entry.item.key === "w9").row.id).toBe("i4"); // the archived w9 row is not shown
});

it("a saved reference shows every detail and its permission date beside the Sign off button", async () => {
  const reference = row({
    id: "r1", kind: "reference", item_key: "reference", label: "Customer reference", file: null, status: "unattested", expires_on: null,
    source_document: null, checked_on: null, permission_on: "2026-10-10",
    details: {
      entity: "Sample District", contactRole: "Facilities lead", phone: "941-555-0100", email: "facilities@example.test", contractPeriod: "2024 to 2026",
      scope: "Quarterly interior pest control", annualValue: "$12,000", publicOrPrivate: "public",
    },
  });
  route({ "GET /admin/bid-kit/": () => reply(payload([reference])) });
  renderPage();
  await screen.findByText("Customer reference");
  const mine = within(rowFor("Customer reference"));
  expect(mine.getByRole("button", { name: "Sign off" })).toBeInTheDocument();
  const shown = rowFor("Customer reference").textContent;
  for (const text of [
    "Entity: Sample District", "Contact role: Facilities lead", "Phone: 941-555-0100", "Email: facilities@example.test", "Contract period: 2024 to 2026",
    "Scope of work: Quarterly interior pest control", "Annual value: $12,000", "Public or private: Public", "Permission given: Oct 10, 2026",
  ]) {
    expect(shown).toContain(text);
  }
  // An empty detail is left out, and a private reference reads Private.
  cleanup();
  const sparse = row({ ...reference, details: { entity: "Sample District", publicOrPrivate: "private" } });
  route({ "GET /admin/bid-kit/": () => reply(payload([sparse])) });
  renderPage();
  await screen.findByText("Customer reference");
  const second = within(rowFor("Customer reference"));
  expect(rowFor("Customer reference").textContent).toContain("Public or private: Private");
  expect(second.queryByText(/Phone/)).toBeNull();
  expect(second.queryByText(/Contract period/)).toBeNull();
});

it("a custom document shows a saved expiry date and never the missing-expiry warning; a catalog paper that needs one still warns", async () => {
  const custom = (over) => row({ id: "c1", item_key: "custom", label: "Vendor letter", status: "unattested", expires_on: null, ...over });
  const none = buildEntries(catalogSections(), [custom({})]).find((section) => section.key === "other");
  expect(none.entries[0].item.expires).toBe(false);

  route({ "GET /admin/bid-kit/": () => reply(payload([custom({})])) });
  renderPage();
  await screen.findByText("Vendor letter");
  expect(within(rowFor("Vendor letter")).queryByText(/No expiry date saved/)).toBeNull();
  cleanup();

  route({ "GET /admin/bid-kit/": () => reply(payload([custom({ expires_on: "2027-03-15" })])) });
  renderPage();
  await screen.findByText("Vendor letter");
  expect(within(rowFor("Vendor letter")).getByText("Mar 15, 2027")).toBeInTheDocument();
  expect(within(rowFor("Vendor letter")).queryByText(/No expiry date saved/)).toBeNull();
  cleanup();

  // A catalog paper that carries an expiry still warns when none is saved.
  const license = row({ status: "needs_expiry", expires_on: null });
  route({ "GET /admin/bid-kit/": () => reply(payload([license])) });
  renderPage();
  await screen.findByText("FDACS business license copy");
  expect(within(rowFor("FDACS business license copy")).getByText(/No expiry date saved/)).toBeInTheDocument();
});

it("a save with no answer from the server says it could not confirm and reads the list again; only a refusal says Not saved", async () => {
  const UNCONFIRMED = "Could not confirm the save. The list below shows what the server has now.";
  let reads = 0;
  let saves = 0;
  const outcomes = [() => Promise.reject(new TypeError("Failed to fetch")), () => reply({}, { ok: false, status: 502 }), () => reply({ error: "Legal name is too long" }, { ok: false, status: 400 })];
  route({
    "GET /admin/bid-kit/": () => { reads += 1; return reply(payload()); },
    "PATCH /admin/bid-kit/i6": () => outcomes[saves++](),
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  const save = async () => {
    fireEvent.click(within(rowFor("Legal name")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowFor("Legal name")).getByLabelText("Value"), { target: { value: `Example Pest Services ${saves}` } });
    fireEvent.click(within(rowFor("Legal name")).getByRole("button", { name: "Save" }));
  };
  await save(); // no answer at all
  expect(await screen.findByText(UNCONFIRMED)).toBeInTheDocument();
  expect(screen.queryByText(/Not saved/)).toBeNull();
  await waitFor(() => expect(reads).toBe(2));
  await save(); // a gateway error is not a refusal either
  await waitFor(() => expect(saves).toBe(2));
  expect(await screen.findByText(UNCONFIRMED)).toBeInTheDocument();
  await waitFor(() => expect(reads).toBe(3));
  await save(); // the server refused
  expect(await screen.findByText("Not saved: Legal name is too long")).toBeInTheDocument();
  expect(screen.queryByText(UNCONFIRMED)).toBeNull();
  await waitFor(() => expect(reads).toBe(4));
});

it("with no references yet, Add a reference opens the form and saving it creates the row", async () => {
  const withoutReferences = ITEMS.filter((entry) => entry.kind !== "reference");
  const created = row({ id: "ref1", kind: "reference", item_key: "reference", label: "Customer reference", file: null, status: "needs_permission", details: { entity: "Sample District" }, expires_on: null, source_document: null, checked_on: null });
  let saved = false;
  const create = vi.fn(() => { saved = true; return reply({ item: created }, { status: 201 }); });
  route({ "GET /admin/bid-kit/": () => reply(payload(saved ? [...withoutReferences, created] : withoutReferences)), "POST /admin/bid-kit/": create });
  renderPage();
  await screen.findByText("FDACS business license copy");
  expect(screen.queryByLabelText("Entity")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add a reference" }));
  const entity = await screen.findByLabelText("Entity");
  fireEvent.change(entity, { target: { value: "Sample District" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0].body).toMatchObject({ kind: "reference", item_key: "reference", details: { entity: "Sample District" } });
  await waitFor(() => expect(within(rowFor("Customer reference")).getByText(/Sample District/)).toBeInTheDocument());
  expect(screen.queryByLabelText("Entity")).toBeNull(); // the editor closed after the save
});
