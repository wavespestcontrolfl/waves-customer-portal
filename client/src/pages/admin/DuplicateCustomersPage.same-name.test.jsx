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

const sameNameGroup = {
  kind: "same_name",
  winner: {
    id: "sn-winner", first_name: "Robin", last_name: "Sampleton", phone: "+19415550101", upcoming_visits: 2,
    address_line1: "1584 Sample Crest Loop", city: "Sarasota", zip: "34231", created_at: "2026-09-01T00:00:00Z", has_stripe: true,
  },
  candidates: [{
    customer: {
      id: "sn-loser", first_name: "Robin", last_name: "Sampleton", phone: "+19415550202", upcoming_visits: 0,
      address_line1: "15-84 Sample Crest Loop", city: "Sarasota", zip: "34231", created_at: "2026-09-20T16:00:00Z",
    },
    tier: "yellow",
    reasons: ["same_name_different_phone", "address_conflict"],
    evidence: {
      kind: "same_name", phone_state: "both_usable", phones: { winner: "usable", loser: "usable" },
      phone_carry: { status: "carried", slot: 1 },
      phone_numbers: { winner: "+19415550101", loser: "+19415550202" },
      addresses: {
        winner: { address_line1: "1584 Sample Crest Loop", address_line2: null, city: "Sarasota", zip: "34231" },
        loser: { address_line1: "15-84 Sample Crest Loop", address_line2: null, city: "Sarasota", zip: "34231" },
      },
    },
  }],
};
const withSameName = { ...phoneOnly, sameNameGroups: [sameNameGroup] };

function mockApi({ list, mergeResult = { ok: true, journalId: "j1", propertyLinked: true, phoneCarry: { status: "carried", slot: 1 } } }) {
  rawAdminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") return response(mergeResult);
    if (path === "/admin/customer-duplicates") return response(list);
    if (path === "/admin/customer-duplicates/merges") return response({ merges: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
}

const renderPage = () => render(<MemoryRouter><DuplicateCustomersPage /></MemoryRouter>);
const posts = () => rawAdminFetch.mock.calls.filter(([, options]) => options?.method === "POST");
const loserCard = async () => (await screen.findAllByRole("link", { name: "Robin Sampleton" }))[1].closest("div.rounded-sm");

beforeEach(() => {
  rawAdminFetch.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows no same-name section when the API does not send one (gate off)", async () => {
  mockApi({ list: phoneOnly });
  renderPage();
  expect(await screen.findByText("Shared phone")).toBeInTheDocument();
  expect(screen.queryByText("Same name, different phone and address")).toBeNull();
  expect(screen.queryByText("Same name")).toBeNull();
});

it("lists same-name groups under their own heading with both phones and both addresses on the cards", async () => {
  mockApi({ list: withSameName });
  renderPage();
  expect(await screen.findByText("Same name, different phone and address", { selector: "span.text-ui-caption" })).toBeInTheDocument();
  expect(screen.getByText("review only · never merged automatically")).toBeInTheDocument();
  expect(screen.getByText("Same name")).toBeInTheDocument();
  expect(screen.getByText("(941) 555-0101 · 2 upcoming visits")).toBeInTheDocument();
  expect(screen.getByText("(941) 555-0202 · no upcoming visits")).toBeInTheDocument();
  expect(screen.getByText("1584 Sample Crest Loop, Sarasota, 34231")).toBeInTheDocument();
  expect(screen.getByText("15-84 Sample Crest Loop, Sarasota, 34231")).toBeInTheDocument();
  expect(screen.getByText("Same name, different phone")).toBeInTheDocument();
  expect(screen.getByText("Different addresses")).toBeInTheDocument();
  expect(screen.getAllByText("Keep")).toHaveLength(2); // one per section
});

it("offers both Merge into kept and Merge + keep address, and Not a duplicate", async () => {
  mockApi({ list: withSameName });
  renderPage();
  const card = await loserCard();
  expect(within(card).getByRole("button", { name: "Merge into kept" })).toBeInTheDocument();
  expect(within(card).getByRole("button", { name: "Merge + keep address" })).toBeInTheDocument();
  expect(within(card).getByRole("button", { name: "Not a duplicate" })).toBeInTheDocument();
});

it("Merge into kept names the kind, says which address stays and which is not saved, and reports where the phone went", async () => {
  mockApi({ list: withSameName });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const [path, options] = posts()[0];
  expect(path).toBe("/admin/customer-duplicates/merge");
  expect(JSON.parse(options.body)).toEqual({ winnerId: "sn-winner", loserId: "sn-loser", kind: "same_name" });
  const confirmText = window.confirm.mock.calls[0][0];
  expect(confirmText).toContain("keeps 1584 Sample Crest Loop, Sarasota, 34231");
  expect(confirmText).toContain("15-84 Sample Crest Loop, Sarasota, 34231 is NOT saved");
  expect(confirmText).toContain("phone number is saved as a contact");
  expect(await screen.findByText(/number \(941\) 555-0202 is saved as a contact on the kept customer/)).toBeInTheDocument();
  expect(screen.getByText(/held from automated texts — it has not agreed to receive them/)).toBeInTheDocument();
});

it("Merge + keep address posts to link-as-property with the kind and says the other address becomes a property", async () => {
  mockApi({ list: withSameName });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Merge + keep address" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const [path, options] = posts()[0];
  expect(path).toBe("/admin/customer-duplicates/link-as-property");
  expect(JSON.parse(options.body)).toEqual({ winnerId: "sn-winner", loserId: "sn-loser", kind: "same_name" });
  expect(window.confirm.mock.calls[0][0]).toContain("15-84 Sample Crest Loop, Sarasota, 34231 is saved as an additional property");
  expect(await screen.findByText(/Merged — address saved as a property\. .*is saved as a contact/)).toBeInTheDocument();
});

it("a merge with no free contact slot tells the office to add the number by hand", async () => {
  mockApi({ list: withSameName, mergeResult: { ok: true, journalId: "j1", phoneCarry: { status: "no_free_slot" } } });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  expect(await screen.findByText(/no free contact slot — add \(941\) 555-0202 to them manually/)).toBeInTheDocument();
});

it("link-as-property that could not save the address says so", async () => {
  mockApi({ list: withSameName, mergeResult: { ok: true, journalId: "j1", propertyLinked: false, phoneCarry: { status: "carried", slot: 1 } } });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Merge + keep address" }));
  expect(await screen.findByText(/the address could NOT be saved as a property/)).toBeInTheDocument();
});

it("a loser with no address offers the plain merge only, and a missing phone is labelled", async () => {
  const group = JSON.parse(JSON.stringify(sameNameGroup));
  group.candidates[0].customer = { ...group.candidates[0].customer, address_line1: null, city: null, zip: null, phone: "" };
  group.candidates[0].evidence = { ...group.candidates[0].evidence, phone_state: "one_missing", phones: { winner: "usable", loser: "none" }, phone_carry: { status: "not_applicable" } };
  group.candidates[0].reasons = ["same_name_phone_missing"];
  mockApi({ list: { ...phoneOnly, sameNameGroups: [group] } });
  renderPage();
  const card = await loserCard();
  expect(within(card).getByRole("button", { name: "Merge into kept" })).toBeInTheDocument();
  expect(within(card).queryByRole("button", { name: "Merge + keep address" })).toBeNull();
  expect(within(card).getByText("No phone on file · no upcoming visits")).toBeInTheDocument();
  expect(within(card).getByText("Same name — a phone number is missing")).toBeInTheDocument();
});

it("Not a duplicate on a same-name pair uses the existing dismiss endpoint with both ids", async () => {
  mockApi({ list: withSameName });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Not a duplicate" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const [path, options] = posts()[0];
  expect(path).toBe("/admin/customer-duplicates/dismiss");
  expect(JSON.parse(options.body)).toEqual({ customerIdA: "sn-winner", customerIdB: "sn-loser" });
});

it("an ordinary phone-group merge is unchanged: no kind in the body", async () => {
  mockApi({ list: withSameName, mergeResult: { ok: true, journalId: "j2" } });
  renderPage();
  const card = (await screen.findByText("Phone Loser")).closest("div.rounded-sm");
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(posts()[0][1].body)).toEqual({ winnerId: "p-winner", loserId: "p-loser" });
});

it("a failed same-name read shows its own error and leaves the phone groups", async () => {
  mockApi({ list: { ...phoneOnly, sameNameGroups: [], sameNameError: "Could not load same-name duplicates" } });
  renderPage();
  expect(await screen.findByText("Could not load same-name duplicates")).toBeInTheDocument();
  expect(screen.getByText("Shared phone")).toBeInTheDocument();
});

it("the same-address section and the same-name section render side by side", async () => {
  mockApi({
    list: {
      ...withSameName,
      sameAddressGroups: [{
        kind: "same_address",
        winner: { id: "sa-winner", first_name: "Alex", last_name: "Example", phone: "+19415550301", address_line1: "100 Example Loop" },
        candidates: [{ customer: { id: "sa-loser", first_name: "Blake", last_name: "Sample", phone: "+19415550302", address_line1: "100 Example Loop" }, tier: "yellow", reasons: ["same_address_different_phone"] }],
      }],
    },
  });
  renderPage();
  expect(await screen.findByText("Same address, different phone", { selector: "span.text-ui-caption" })).toBeInTheDocument();
  expect(screen.getByText("Same name, different phone and address", { selector: "span.text-ui-caption" })).toBeInTheDocument();
});

const withEvidence = (evidenceChanges, customerChanges = {}, winnerChanges = {}) => {
  const group = JSON.parse(JSON.stringify(sameNameGroup));
  group.winner = { ...group.winner, ...winnerChanges };
  group.candidates[0].customer = { ...group.candidates[0].customer, ...customerChanges };
  group.candidates[0].evidence = { ...group.candidates[0].evidence, ...evidenceChanges };
  return { ...phoneOnly, sameNameGroups: [group] };
};

it("a kept customer with no address takes the other address: the confirm says so and the keep-address action is not offered", async () => {
  mockApi({
    list: withEvidence({
      address_outcome: "copied",
      addresses: { winner: { address_line1: null, address_line2: null, city: null, zip: null }, loser: sameNameGroup.candidates[0].evidence.addresses.loser },
    }, {}, { address_line1: null, city: null, zip: null }),
  });
  renderPage();
  const card = await loserCard();
  expect(within(card).queryByRole("button", { name: "Merge + keep address" })).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  const text = window.confirm.mock.calls[0][0];
  expect(text).toContain("has no address on file, so 15-84 Sample Crest Loop, Sarasota, 34231 becomes their address");
  expect(text).not.toContain("NOT saved");
  expect(text).not.toContain("additional property");
});

it("when the kept customer has an address the confirm says the other one is NOT saved, and Merge + keep address calls it an additional property", async () => {
  mockApi({ list: withEvidence({ address_outcome: "kept" }) });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  expect(window.confirm.mock.calls[0][0]).toContain("is NOT saved");
  fireEvent.click(within(card).getByRole("button", { name: "Merge + keep address" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(2));
  expect(window.confirm.mock.calls[1][0]).toContain("is saved as an additional property");
});

it("a merge from a record with no address says nothing about saving an address", async () => {
  const noAddress = { address_line1: null, address_line2: null, city: null, zip: null };
  mockApi({
    list: withEvidence({ address_outcome: "kept", addresses: { winner: sameNameGroup.candidates[0].evidence.addresses.winner, loser: noAddress } }, noAddress),
  });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  const text = window.confirm.mock.calls[0][0];
  expect(text).toContain("keeps 1584 Sample Crest Loop, Sarasota, 34231.");
  expect(text).not.toContain("NOT saved");
});

it("shows the unit on both records so same-street, different-unit pairs are told apart", async () => {
  mockApi({
    list: withEvidence({
      addresses: {
        winner: { address_line1: "1584 Sample Crest Loop", address_line2: "Unit 4", city: "Sarasota", zip: "34231" },
        loser: { address_line1: "1584 Sample Crest Loop", address_line2: "Unit 9", city: "Sarasota", zip: "34231" },
      },
    }, { address_line1: "1584 Sample Crest Loop", address_line2: "Unit 9" }, { address_line2: "Unit 4" }),
  });
  renderPage();
  const card = await loserCard();
  expect(within(card).getByText("1584 Sample Crest Loop, Unit 9, Sarasota, 34231")).toBeInTheDocument();
  expect(screen.getByText("1584 Sample Crest Loop, Unit 4, Sarasota, 34231")).toBeInTheDocument();
});

it("a loser with no phone: the confirm says no number is saved, and a full contact list says to add it by hand", async () => {
  mockApi({ list: withEvidence({ phone_state: "one_missing", phones: { winner: "usable", loser: "none" }, phone_carry: { status: "not_applicable" } }, { phone: "" }) });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(window.confirm.mock.calls[0][0]).toContain("has no usable phone number on file, so no number is saved");
  expect(window.confirm.mock.calls[0][0]).not.toContain("is saved as a contact");
});

it("no free contact slot: the confirm warns the phone will NOT be saved", async () => {
  mockApi({ list: withEvidence({ phone_carry: { status: "no_free_slot" } }) });
  renderPage();
  const card = await loserCard();
  fireEvent.click(within(card).getByRole("button", { name: "Merge into kept" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(window.confirm.mock.calls[0][0]).toContain("will NOT be saved");
});
