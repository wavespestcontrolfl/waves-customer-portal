// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { rawAdminFetch } = vi.hoisted(() => ({ rawAdminFetch: vi.fn() }));

vi.mock("../../lib/adminFetch", () => ({ adminFetch: rawAdminFetch }));
vi.mock("../../hooks/useVisiblePageRefresh", () => ({ default: () => {} }));

import DuplicateCustomersPage from "./DuplicateCustomersPage";

function response(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: async () => body });
}

const phoneOnly = {
  groups: [{
    phone10: "9415550100",
    winner: { id: "p-winner", first_name: "Phone", last_name: "Winner" },
    candidates: [{ customer: { id: "p-loser", first_name: "Phone", last_name: "Loser" }, tier: "yellow", reasons: ["name_conflict"] }],
  }],
};

const withSameAddress = {
  ...phoneOnly,
  sameAddressGroups: [{
    kind: "same_address",
    winner: {
      id: "sa-winner", first_name: "Alex", last_name: "Example", phone: "+19415550101", upcoming_visits: 2,
      address_line1: "100 Example Loop", city: "Sarasota", zip: "34231", created_at: "2026-09-01T00:00:00Z", has_stripe: true,
    },
    candidates: [{
      customer: {
        id: "sa-loser", first_name: "Blake", last_name: "Sample", phone: "+19415550102", upcoming_visits: 0,
        address_line1: "100 Example Loop", city: "Sarasota", zip: "34231", created_at: "2026-09-20T16:00:00Z",
      },
      tier: "yellow",
      reasons: ["same_address_different_phone"],
    }],
  }],
};

function mockApi({ list, mergeResult = { ok: true, journalId: "j1", phoneCarry: { status: "carried", slot: 1 } } }) {
  rawAdminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") return response(mergeResult);
    if (path === "/admin/customer-duplicates") return response(list);
    if (path === "/admin/customer-duplicates/merges") return response({ merges: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
}

const renderPage = () => render(<MemoryRouter><DuplicateCustomersPage /></MemoryRouter>);
const posts = () => rawAdminFetch.mock.calls.filter(([, options]) => options?.method === "POST");

beforeEach(() => {
  rawAdminFetch.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows no same-address section when the API does not send one (gate off)", async () => {
  mockApi({ list: phoneOnly });
  renderPage();
  expect(await screen.findByText("Shared phone")).toBeInTheDocument();
  expect(screen.queryByText("Same address, different phone")).toBeNull();
  expect(screen.queryByText("Same address")).toBeNull();
});

it("lists same-address groups in their own section with phones, address, added date and what each has", async () => {
  mockApi({ list: withSameAddress });
  renderPage();
  expect(await screen.findByText("Same address, different phone", { selector: "span.text-ui-caption" })).toBeInTheDocument();
  expect(screen.getByText("Shared phone")).toBeInTheDocument();
  expect(screen.getByText("(941) 555-0101 · 2 upcoming visits")).toBeInTheDocument();
  expect(screen.getByText("(941) 555-0102 · no upcoming visits")).toBeInTheDocument();
  expect(screen.getAllByText("100 Example Loop, Sarasota, 34231").length).toBeGreaterThan(0);
  expect(screen.getByText(/added Sep 20, 2026/)).toBeInTheDocument();
  expect(screen.getByText("Stripe")).toBeInTheDocument();
  expect(screen.getAllByText("Keep")).toHaveLength(2); // one per section
});

it("Merge on a same-address pair names the kind and reports where the phone went", async () => {
  mockApi({ list: withSameAddress });
  renderPage();
  const card = (await screen.findByText("Blake Sample")).closest("div.rounded-sm");
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const [path, options] = posts()[0];
  expect(path).toBe("/admin/customer-duplicates/merge");
  expect(JSON.parse(options.body)).toEqual({ winnerId: "sa-winner", loserId: "sa-loser", kind: "same_address" });
  expect(await screen.findByText(/number \(941\) 555-0102 is saved as a contact on the kept customer/)).toBeInTheDocument();
  expect(screen.getByText(/held from automated texts — it has not agreed to receive them/)).toBeInTheDocument();
});

it("a merge with no free contact slot tells the office to add the number by hand", async () => {
  mockApi({ list: withSameAddress, mergeResult: { ok: true, journalId: "j1", phoneCarry: { status: "no_free_slot" } } });
  renderPage();
  const card = (await screen.findByText("Blake Sample")).closest("div.rounded-sm");
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  expect(await screen.findByText(/no free contact slot — add \(941\) 555-0102 to them manually/)).toBeInTheDocument();
});

it("Not a duplicate on a same-address pair uses the existing dismiss endpoint with both ids", async () => {
  mockApi({ list: withSameAddress });
  renderPage();
  const card = (await screen.findByText("Blake Sample")).closest("div.rounded-sm");
  fireEvent.click(within(card).getByRole("button", { name: "Not a duplicate" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const [path, options] = posts()[0];
  expect(path).toBe("/admin/customer-duplicates/dismiss");
  expect(JSON.parse(options.body)).toEqual({ customerIdA: "sa-winner", customerIdB: "sa-loser" });
});

it("an ordinary phone-group merge is unchanged: no kind in the body", async () => {
  mockApi({ list: withSameAddress, mergeResult: { ok: true, journalId: "j2" } });
  renderPage();
  const card = (await screen.findByText("Phone Loser")).closest("div.rounded-sm");
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(posts()[0][1].body)).toEqual({ winnerId: "p-winner", loserId: "p-loser" });
});

it("a failed same-address read shows its own error and leaves the phone groups", async () => {
  mockApi({ list: { ...phoneOnly, sameAddressGroups: [], sameAddressError: "Could not load same-address duplicates" } });
  renderPage();
  expect(await screen.findByText("Could not load same-address duplicates")).toBeInTheDocument();
  expect(screen.getByText("Shared phone")).toBeInTheDocument();
});

const propertyMatch = {
  sameAddressGroups: [{
    kind: "same_address",
    winner: {
      id: "owner", first_name: "Owner", last_name: "Example", phone: "+19415550101",
      address_line1: "999 Elsewhere Rd", city: "Bradenton", zip: "34202",
    },
    candidates: [{
      customer: {
        id: "tenant", first_name: "Tenant", last_name: "Sample", phone: "+19415550102",
        address_line1: "100 Example Loop", city: "Sarasota", zip: "34231",
      },
      tier: "red",
      reasons: ["same_address_different_phone", "address_conflict"],
      evidence: {
        kind: "same_address",
        matched_address: {
          winner: { address_line1: "100 Example Loop", address_line2: null, city: "Sarasota", zip: "34231", via: "property" },
          loser: { address_line1: "100 Example Loop", address_line2: null, city: "Sarasota", zip: "34231", via: "primary" },
        },
      },
    }],
  }],
};

it("a pair matched through a saved property shows that matched address under Same address and labels the primary address", async () => {
  mockApi({ list: { groups: [], ...propertyMatch } });
  renderPage();
  const label = await screen.findByText("Same address");
  expect(label.parentElement).toHaveTextContent("Same address100 Example Loop, Sarasota, 34231");
  expect(screen.queryByText("999 Elsewhere Rd, Bradenton, 34202", { selector: "span" })).toBeNull();
  expect(screen.getByText("Matched at 100 Example Loop, Sarasota, 34231 (saved property)")).toBeInTheDocument();
  expect(screen.getByText(/Primary address:\s*999 Elsewhere Rd, Bradenton, 34202/)).toBeInTheDocument();
  // The occupant matched on its own address: no property wording on that line.
  expect(screen.getAllByText(/Matched at/)).toHaveLength(1);
});

it("a candidate the kept customer matched at a different address says so", async () => {
  const list = JSON.parse(JSON.stringify(propertyMatch));
  list.sameAddressGroups[0].candidates.push({
    customer: { id: "third", first_name: "Third", last_name: "Example", phone: "+19415550103", address_line1: "5 Other Ct", city: "Sarasota", zip: "34231" },
    tier: "yellow",
    reasons: ["same_address_different_phone"],
    evidence: {
      matched_address: {
        winner: { address_line1: "5 Other Ct", address_line2: null, city: "Sarasota", zip: "34231", via: "primary" },
        loser: { address_line1: "5 Other Ct", address_line2: null, city: "Sarasota", zip: "34231", via: "primary" },
      },
    },
  });
  mockApi({ list: { groups: [], ...list } });
  renderPage();
  expect(await screen.findByText(/Kept customer matched this one at 5 Other Ct, Sarasota, 34231/)).toBeInTheDocument();
});

it("phone-group cards render exactly as before (no matched-address wording)", async () => {
  mockApi({ list: phoneOnly });
  renderPage();
  await screen.findByText("Shared phone");
  expect(screen.queryByText(/Matched at/)).toBeNull();
  expect(screen.queryByText(/Primary address/)).toBeNull();
});

function listWithPhones({ winnerPhone = "+19415550101", loserPhone = "+19415550102", state, carry, winnerState, loserState }) {
  return {
    groups: [],
    sameAddressGroups: [{
      kind: "same_address",
      winner: { id: "w", first_name: "Alex", last_name: "Example", phone: winnerPhone, address_line1: "100 Example Loop", city: "Sarasota", zip: "34231" },
      candidates: [{
        customer: { id: "l", first_name: "Blake", last_name: "Sample", phone: loserPhone, address_line1: "100 Example Loop", city: "Sarasota", zip: "34231" },
        tier: "yellow",
        reasons: [state === "both_usable" ? "same_address_different_phone" : "same_address_phone_missing"],
        evidence: {
          phone_state: state,
          phones_differ: state === "both_usable",
          phones: { winner: winnerState, loser: loserState },
          phone_carry: { status: carry },
        },
      }],
    }],
  };
}

it("a phone-less member says 'No phone on file' where the number would show, and the pair is not called a different-phone pair", async () => {
  mockApi({ list: listWithPhones({ loserPhone: "", state: "one_missing", carry: "not_applicable", winnerState: "usable", loserState: "none" }) });
  renderPage();
  expect(await screen.findByText("No phone on file")).toBeInTheDocument();
  expect(screen.getByText("(941) 555-0101")).toBeInTheDocument();
  expect(screen.getByText("Same address — a phone number is missing")).toBeInTheDocument();
  expect(screen.queryByText("Same address, different phone", { selector: "span.text-ui-body" })).toBeNull();
});

it("both phone-less: both rows say so", async () => {
  mockApi({ list: listWithPhones({ winnerPhone: null, loserPhone: "12345", state: "both_missing", carry: "not_applicable", winnerState: "none", loserState: "none" }) });
  renderPage();
  expect(await screen.findAllByText("No phone on file")).toHaveLength(2);
  expect(screen.queryByText("12345")).toBeNull();
});

it.each([
  ["both_usable", "carried", /with different phones\. All history moves to the kept customer\. Blake Sample’s phone number is saved as a contact on them\./, "winner", "usable", "usable"],
  ["both_usable", "no_free_slot", /Blake Sample’s phone number will NOT be saved — add it by hand afterwards\./, "winner", "usable", "usable"],
  ["both_usable", "already_on_winner", /Blake Sample’s number is already saved on the kept customer\./, "winner", "usable", "usable"],
  ["one_missing", "not_applicable", /Blake Sample has no phone number on file\. All history moves to the kept customer\. Blake Sample has no usable phone number on file, so no number is saved\./, "loser", "usable", "none"],
  ["one_missing", "carried", /Alex Example has no phone number on file\./, "winner", "none", "usable"],
  ["both_missing", "not_applicable", /neither has a phone number on file\./, "both", "none", "none"],
])("the merge confirmation for %s / %s says exactly what will happen", async (state, carry, expected, _who, winnerState, loserState) => {
  mockApi({ list: listWithPhones({ state, carry, winnerState, loserState, winnerPhone: winnerState === "none" ? "" : "+19415550101", loserPhone: loserState === "none" ? "" : "+19415550102" }) });
  renderPage();
  const card = (await screen.findByText("Blake Sample")).closest("div.rounded-sm");
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(window.confirm.mock.calls[0][0]).toMatch(expected);
  if (state !== "both_usable") expect(window.confirm.mock.calls[0][0]).not.toMatch(/different phones/);
  if (carry === "not_applicable") expect(window.confirm.mock.calls[0][0]).not.toMatch(/saved as a contact/);
});

it.each([
  ["carried", /saved as a contact on the kept customer/],
  ["no_free_slot", /no free contact slot/],
  ["not_applicable", /Blake Sample had no usable phone number on file, so no number was saved\./],
  ["already_on_winner", /number was already saved on the kept customer\./],
])("the result toast for phoneCarry %s never promises a number it did not save", async (status, expected) => {
  mockApi({
    list: listWithPhones({ state: "both_usable", carry: "carried", winnerState: "usable", loserState: "usable" }),
    mergeResult: { ok: true, journalId: "j", phoneCarry: { status } },
  });
  renderPage();
  const card = (await screen.findByText("Blake Sample")).closest("div.rounded-sm");
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  const text = await screen.findByText(expected);
  expect(text).toBeInTheDocument();
  if (status !== "carried") expect(text.textContent).not.toMatch(/saved as a contact/);
});

it("a same-address pair that shares a phone (kept out of the phone list) says so, never 'different phones', and promises no number", async () => {
  const list = listWithPhones({ state: "both_usable", carry: "not_applicable", winnerState: "usable", loserState: "usable", loserPhone: "+19415550101" });
  list.sameAddressGroups[0].candidates[0].reasons = ["same_address_phone_shared"];
  list.sameAddressGroups[0].candidates[0].evidence.phone_state = "shared_phone";
  list.sameAddressGroups[0].candidates[0].evidence.phones_differ = false;
  mockApi({ list, mergeResult: { ok: true, journalId: "j", phoneCarry: { status: "not_applicable" } } });
  renderPage();
  expect(await screen.findByText(/Same address and the same phone/)).toBeInTheDocument();
  const card = screen.getByText("Blake Sample").closest("div.rounded-sm");
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  const text = window.confirm.mock.calls[0][0];
  expect(text).toMatch(/with the same phone number \(one record is not marked active/);
  expect(text).toMatch(/They already share a phone number, so there is no number to save\./);
  expect(text).not.toMatch(/different phones|saved as a contact|no usable phone/);
  expect(await screen.findByText(/Merged — They already share a phone number/)).toBeInTheDocument();
});
