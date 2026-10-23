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
  attested_by: null, attested_at: null, notes: null, archived_at: null, credential: null, status: "unattested", updated_at: "2026-10-02T12:00:00.000Z", ...over,
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
  summary: summarize(buildChecklist(items.map((item) => ({ ...item, has_file: !!item.file, credential_number: null })), { today: TODAY })),
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

it("a sign-off the server refuses as out of date says so and reloads", async () => {
  let reads = 0;
  route({
    "GET /admin/bid-kit/": () => { reads += 1; return reply(payload()); },
    "POST /admin/bid-kit/i1/attest": () => reply({ error: "This item changed since you opened it. Reload and check it again." }, { ok: false, status: 409 }),
  });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Sign off" }));
  expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument();
  expect(reads).toBe(2);
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

it("uploading a file on an item with no row creates the row first, then sends the file", async () => {
  const created = vi.fn(() => reply({ item: row({ id: "new1", item_key: "ipm_plan", file: null, status: "missing" }) }, { status: 201 }));
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
});

it("Open file asks for a signed link and opens it without keeping a reference to the page", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  route({ "GET /admin/bid-kit/": () => reply(payload()), "GET /admin/bid-kit/i1/file": () => reply({ url: "https://storage.example.test/signed", file_name: "license.pdf", expires_in: 300 }) });
  renderPage();
  await screen.findByText("FDACS business license copy");
  fireEvent.click(within(rowFor("FDACS business license copy")).getByRole("button", { name: "Open file" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("https://storage.example.test/signed", "_blank", "noopener,noreferrer"));
  open.mockRestore();
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

it("buildEntries lays the server's items over the catalog and sends custom rows to the last section", () => {
  const sections = buildEntries(catalogSections(), [...ITEMS, row({ id: "c1", item_key: "custom", label: "County vendor letter", status: "unattested" }), row({ id: "gone", item_key: "w9", archived_at: "2026-10-01T00:00:00Z" })]);
  expect(sections.map((section) => section.key)).toEqual(["sank_bids", "insurance", "registration_tax", "plans_company", "references", "facts", "other"]);
  expect(sections[0].entries.map((entry) => entry.status)).toEqual(["unattested", "expired", "missing", "missing", "missing"]);
  expect(sections[2].entries.find((entry) => entry.item.key === "business_tax_receipt").status).toBe("needs_expiry");
  expect(sections.at(-1).entries[0].row.label).toBe("County vendor letter");
  expect(sections[2].entries.find((entry) => entry.item.key === "w9").row.id).toBe("i4"); // the archived w9 row is not shown
});
