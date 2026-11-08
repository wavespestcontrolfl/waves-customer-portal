// @vitest-environment jsdom
// Link… dialog search: a search reply belongs to the tab and text it was
// sent for. A late reply never replaces the open tab's rows, and a row
// links as the record type it came from. Before this, a slow Lead reply
// could fill the Customer tab, and a click sent the lead's id as
// customer_id ("Customer not found").
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import PhotoAssessmentDetailSheet from "./PhotoAssessmentDetailSheet";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

const ASSESSMENT = "aaaaaaaa-0000-4000-8000-000000000001";
const LEAD = "bbbbbbbb-0000-4000-8000-000000000002";
const CUSTOMER = "cccccccc-0000-4000-8000-000000000003";
const OLDER = "dddddddd-0000-4000-8000-000000000004";
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const DETAIL = { assessment: { id: ASSESSMENT, status: "analyzed", source: "admin", can_release: true, contact: {} }, photos: [] };

afterEach(() => { cleanup(); vi.resetAllMocks(); });

// Every other request: the sheet's own detail read.
function route(handlers) {
  adminFetch.mockImplementation((path, options = {}) => {
    for (const [match, reply] of handlers) {
      if (match(path, options)) return reply(path, options);
    }
    return Promise.resolve(ok(DETAIL));
  });
}

async function openLinkDialog() {
  render(
    <MemoryRouter>
      <PhotoAssessmentDetailSheet open type="lawn" id={ASSESSMENT} onClose={() => {}} onChanged={() => {}} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Link…" }));
}

it("drops a late Lead reply after the switch to Customer, and the click links the customer", async () => {
  let finishLeads;
  route([
    [(p) => p.startsWith("/admin/leads?"), () => new Promise((resolve) => { finishLeads = resolve; })],
    [(p) => p.startsWith("/admin/customers?"), () => Promise.resolve(ok({ customers: [{ id: CUSTOMER, first_name: "Synthetic", last_name: "Customer" }] }))],
    [(p, o) => o.method === "POST", () => Promise.resolve(ok({ success: true, customer_id: CUSTOMER }))],
  ]);
  await openLinkDialog();
  fireEvent.change(screen.getByPlaceholderText("Search leads by name, phone, email…"), { target: { value: "Synthetic" } });
  await waitFor(() => expect(finishLeads).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("tab", { name: "Customer", exact: true }));
  const dialog = within(screen.getByRole("dialog", { name: "Link to customer" }));
  expect(await dialog.findByRole("button", { name: /Synthetic Customer/ })).toBeInTheDocument();

  await act(async () => finishLeads(ok({ leads: [{ id: LEAD, first_name: "Synthetic", last_name: "Lead" }] })));
  expect(dialog.queryByRole("button", { name: /Synthetic Lead/ })).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole("button", { name: /Synthetic Customer/ }));
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(`/admin/photo-assessments/lawn/${ASSESSMENT}/link`, {
    method: "POST", body: { customer_id: CUSTOMER },
  }));
  expect(adminFetch).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: { customer_id: LEAD } }));
});

it("hides the Lead rows the moment the Customer tab opens, and says No matches only after the customer search", async () => {
  let finishCustomers;
  route([
    [(p) => p.startsWith("/admin/leads?"), () => Promise.resolve(ok({ leads: [{ id: LEAD, first_name: "Synthetic", last_name: "Lead" }] }))],
    [(p) => p.startsWith("/admin/customers?"), () => new Promise((resolve) => { finishCustomers = resolve; })],
  ]);
  await openLinkDialog();
  fireEvent.change(screen.getByPlaceholderText("Search leads by name, phone, email…"), { target: { value: "Synthetic" } });
  expect(await screen.findByRole("button", { name: /Synthetic Lead/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("tab", { name: "Customer", exact: true }));
  expect(screen.queryByRole("button", { name: /Synthetic Lead/ })).not.toBeInTheDocument();
  expect(screen.queryByText("No matches.")).not.toBeInTheDocument();
  await waitFor(() => expect(finishCustomers).toBeTypeOf("function"));
  await act(async () => finishCustomers(ok({ customers: [] })));
  expect(screen.getByText("No matches.")).toBeInTheDocument();
});

it("keeps the newest search when an older search answers last", async () => {
  let finishOlder;
  route([
    [(p) => p.startsWith("/admin/customers?search=Sy&"), () => new Promise((resolve) => { finishOlder = resolve; })],
    [(p) => p.startsWith("/admin/customers?search=Synthetic&"), () => Promise.resolve(ok({ customers: [{ id: CUSTOMER, first_name: "Synthetic", last_name: "Customer" }] }))],
  ]);
  await openLinkDialog();
  fireEvent.click(screen.getByRole("tab", { name: "Customer", exact: true }));
  const input = screen.getByPlaceholderText("Search customers by name, phone, email…");
  fireEvent.change(input, { target: { value: "Sy" } });
  await waitFor(() => expect(finishOlder).toBeTypeOf("function"));
  fireEvent.change(input, { target: { value: "Synthetic" } });
  expect(await screen.findByRole("button", { name: /Synthetic Customer/ })).toBeInTheDocument();

  await act(async () => finishOlder(ok({ customers: [{ id: OLDER, first_name: "Synthetic", last_name: "Older" }] })));
  expect(screen.queryByRole("button", { name: /Synthetic Older/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Synthetic Customer/ })).toBeInTheDocument();
});
