// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { rawAdminFetch } = vi.hoisted(() => ({ rawAdminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch: rawAdminFetch }));

import NeighborhoodGateCodesPage from "./NeighborhoodGateCodesPage";

function response(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: async () => body });
}

const entry = (over = {}) => ({
  id: "e1", gateLabel: "Main gate", accessType: "keypad", code: "#4821", instructions: null,
  status: "active", source: "office", lastConfirmedAt: "2026-09-01T16:00:00.000Z", stale: false, conflict: false, ...over,
});
const ALL = {
  total: 2,
  neighborhoods: [
    { id: "n1", name: "Synthetic Oaks", county: "Manatee", propertyCount: 3, hasConflict: false, entries: [entry()] },
    {
      id: "n2", name: "Sample Pines", county: "Sarasota", propertyCount: 1, hasConflict: true,
      entries: [
        entry({ id: "e2", code: "1111", status: "needs_confirm", lastConfirmedAt: null, conflict: true }),
        entry({ id: "e3", gateLabel: "Back gate", accessType: "guard", code: null, instructions: "Stop at the booth", stale: true, lastConfirmedAt: "2025-01-05T16:00:00.000Z" }),
      ],
    },
  ],
};
const NEEDS = { total: 1, neighborhoods: [ALL.neighborhoods[1]] };

function renderPage(url = "/") {
  return render(<MemoryRouter initialEntries={[url]}><NeighborhoodGateCodesPage /></MemoryRouter>);
}

beforeEach(() => {
  rawAdminFetch.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("a live code nobody has confirmed yet says so but carries no Unconfirmed badge", async () => {
  // Only an entry waiting on the office (needs_confirm) is "Unconfirmed", the
  // Needs confirm filter's rule; a code filed from a profile turns Stale later.
  const fresh = { total: 1, neighborhoods: [{ id: "n9", name: "Fresh Grove", county: "Manatee", propertyCount: 1, hasConflict: false,
    entries: [entry({ id: "e9", code: "2468", source: "profile", lastConfirmedAt: null })] }] };
  rawAdminFetch.mockImplementation(() => response(fresh));
  renderPage();
  expect(await screen.findByText("Fresh Grove")).toBeInTheDocument();
  expect(screen.getByText("Never confirmed")).toBeInTheDocument();
  expect(screen.queryByText("Unconfirmed")).toBeNull();
});

it("shows who added a code on a visit and who reported one wrong", async () => {
  const field = { total: 1, neighborhoods: [{ id: "n8", name: "Field Glen", county: "Manatee", propertyCount: 2, hasConflict: false,
    entries: [
      entry({ id: "e7", code: "7070", source: "tech", addedBy: "Synthetic Tech" }),
      entry({ id: "e8", code: "8080", status: "needs_confirm", markedWrongAt: "2026-10-02T16:00:00.000Z", markedWrongBy: "Synthetic Tech" }),
    ] }] };
  rawAdminFetch.mockImplementation(() => response(field));
  renderPage();
  expect(await screen.findByText("Field Glen")).toBeInTheDocument();
  expect(screen.getByText("Last confirmed Sep 1, 2026 · Added on a visit by Synthetic Tech")).toBeInTheDocument();
  expect(screen.getByText("Reported wrong on a visit by Synthetic Tech, Oct 2, 2026")).toBeInTheDocument();
});

it("renders neighborhoods, entries and the stale / unconfirmed / conflict markers", async () => {
  rawAdminFetch.mockImplementation(() => response(ALL));
  renderPage();
  expect(await screen.findByText("Synthetic Oaks")).toBeInTheDocument();
  expect(screen.getByText("Manatee · 3 properties")).toBeInTheDocument();
  expect(screen.getByText("Sarasota · 1 property")).toBeInTheDocument();
  expect(screen.getByText("#4821")).toBeInTheDocument();
  expect(screen.getByText("Stop at the booth")).toBeInTheDocument();
  expect(screen.getByText("Conflicting codes")).toBeInTheDocument();
  expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
  expect(screen.getByText("Stale")).toBeInTheDocument();
  expect(screen.getByText("Last confirmed Sep 1, 2026")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Confirm" })).toHaveLength(3);
  expect(rawAdminFetch.mock.calls[0][0]).toContain("/admin/neighborhood-access?");
});

it("the Needs confirm toggle re-queries with the filter", async () => {
  rawAdminFetch.mockImplementation((path) => response(path.includes("filter=needs_confirm") ? NEEDS : ALL));
  renderPage();
  await screen.findByText("Synthetic Oaks");
  fireEvent.click(screen.getByRole("button", { name: "Needs confirm" }));
  await waitFor(() => expect(screen.queryByText("Synthetic Oaks")).not.toBeInTheDocument());
  expect(screen.getByText("Sample Pines")).toBeInTheDocument();
  expect(rawAdminFetch.mock.calls.some(([p]) => p.includes("filter=needs_confirm"))).toBe(true);
  expect(screen.getByRole("button", { name: "Needs confirm" })).toHaveAttribute("aria-pressed", "true");
});

it("Confirm sends the confirm action and reloads", async () => {
  rawAdminFetch.mockImplementation((path, options) => (options?.method === "PATCH" ? response({ id: "e2", status: "active" }) : response(ALL)));
  renderPage();
  await screen.findByText("Sample Pines");
  fireEvent.click(screen.getAllByRole("button", { name: "Confirm" })[1]);
  await screen.findByText("Confirmed");
  const patch = rawAdminFetch.mock.calls.find(([, o]) => o?.method === "PATCH");
  expect(patch[0]).toBe("/admin/neighborhood-access/entries/e2");
  expect(JSON.parse(patch[1].body)).toEqual({ action: "confirm" });
});

it("Add entry posts a keypad code and shows a server error inline", async () => {
  rawAdminFetch.mockImplementation((path, options) => (
    options?.method === "POST"
      ? response({ error: "That code is already on file for this neighborhood" }, { ok: false, status: 409 })
      : response(ALL)
  ));
  renderPage();
  await screen.findByText("Synthetic Oaks");
  fireEvent.click(screen.getAllByRole("button", { name: "Add entry" })[0]);
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: "2468" } });
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  expect(await screen.findByText("That code is already on file for this neighborhood")).toBeInTheDocument();
  const post = rawAdminFetch.mock.calls.find(([, o]) => o?.method === "POST");
  expect(post[0]).toBe("/admin/neighborhood-access/n1/entries");
  expect(JSON.parse(post[1].body)).toEqual({ gate_label: "Main gate", access_type: "keypad", code: "2468", gate_location: null });
});

it("a gate's map point shows on its row, prefills Edit, and travels on Add as gate_location", async () => {
  // Owner 2026-10-24: the office pins the main gate once; every visit's
  // Directions link in the neighborhood then routes through it.
  const pinned = { total: 1, neighborhoods: [{ id: "n1", name: "Synthetic Oaks", county: "Manatee", propertyCount: 3, hasConflict: false,
    entries: [entry({ gateLocation: { lat: 27.4321, lng: -82.4567 } })] }] };
  rawAdminFetch.mockImplementation((path, options) => (options?.method ? response({ id: "e1" }) : response(pinned)));
  renderPage();
  await screen.findByText("Synthetic Oaks");
  expect(screen.getByText(/Directions route through this gate/)).toBeInTheDocument();
  const pin = screen.getByRole("link", { name: "27.4321, -82.4567" });
  expect(pin.getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=27.4321%2C-82.4567");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Gate location")).toHaveValue("27.4321, -82.4567");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: "2468" } });
  fireEvent.change(screen.getByLabelText("Gate location"), { target: { value: " https://www.google.com/maps/@27.5,-82.6,17z " } });
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  await waitFor(() => expect(rawAdminFetch.mock.calls.some(([, o]) => o?.method === "POST")).toBe(true));
  const post = rawAdminFetch.mock.calls.find(([, o]) => o?.method === "POST");
  expect(JSON.parse(post[1].body)).toEqual({ gate_label: "Main gate", access_type: "keypad", code: "2468", gate_location: "https://www.google.com/maps/@27.5,-82.6,17z" });
});

it("shows the not-turned-on state when the API answers 404 enabled:false", async () => {
  rawAdminFetch.mockImplementation(() => response({ enabled: false }, { ok: false, status: 404 }));
  renderPage();
  expect(await screen.findByText("Gate codes are not turned on yet.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Search neighborhoods")).not.toBeInTheDocument();
});

const ONE_ID = "5d1e0b64-8f4f-4c61-9f0e-2f6a7d1c3b11";

it("?neighborhood= asks for just that neighborhood and Show all clears it", async () => {
  rawAdminFetch.mockImplementation((path) => response(path.includes("neighborhood=") ? { total: 1, neighborhoods: [ALL.neighborhoods[0]] } : ALL));
  renderPage(`/?neighborhood=${ONE_ID}`);
  expect(await screen.findByText("Synthetic Oaks")).toBeInTheDocument();
  expect(rawAdminFetch.mock.calls[0][0]).toContain(`neighborhood=${ONE_ID}`);
  expect(screen.getByText("Showing one neighborhood")).toBeInTheDocument();
  expect(screen.queryByText("Sample Pines")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show all" }));
  expect(await screen.findByText("Sample Pines")).toBeInTheDocument();
  expect(screen.queryByText("Showing one neighborhood")).toBeNull();
  expect(rawAdminFetch.mock.calls.at(-1)[0]).not.toContain("neighborhood=");
});

it("a linked neighborhood opens on its own: a filter set before never narrows it away", async () => {
  rawAdminFetch.mockImplementation((path) => response(path.includes("neighborhood=") ? { total: 1, neighborhoods: [ALL.neighborhoods[0]] } : ALL));
  renderPage(`/?neighborhood=${ONE_ID}`);
  expect(await screen.findByText("Synthetic Oaks")).toBeInTheDocument();
  const toggle = screen.queryByRole("button", { name: "Needs confirm" });
  if (toggle) fireEvent.click(toggle);
  await waitFor(() => expect(rawAdminFetch.mock.calls.at(-1)[0]).toContain(`neighborhood=${ONE_ID}`));
  for (const [url] of rawAdminFetch.mock.calls.filter(([u]) => u.includes("neighborhood="))) {
    expect(url).not.toContain("filter=");
    expect(url).not.toContain("q=");
  }
});

it("opening a linked neighborhood on the mounted page drops the previous rows at once, while its load is still pending", async () => {
  rawAdminFetch.mockImplementation((path) => (path.includes("neighborhood=")
    ? new Promise(() => {}) // a slow load that has not answered yet
    : response(ALL)));
  function GoToBell() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate(`/?neighborhood=${ONE_ID}`)}>Open bell link</button>;
  }
  render(<MemoryRouter initialEntries={["/"]}><GoToBell /><NeighborhoodGateCodesPage /></MemoryRouter>);
  expect(await screen.findByText("Sample Pines")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open bell link" }));
  await waitFor(() => expect(rawAdminFetch.mock.calls.at(-1)[0]).toContain(`neighborhood=${ONE_ID}`));
  await waitFor(() => expect(screen.queryByText("Sample Pines")).toBeNull());
  expect(screen.queryByText("Synthetic Oaks")).toBeNull();
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});

it("a malformed ?neighborhood= is ignored: everything lists, no control", async () => {
  rawAdminFetch.mockImplementation(() => response(ALL));
  renderPage("/?neighborhood=not-an-id");
  expect(await screen.findByText("Sample Pines")).toBeInTheDocument();
  expect(rawAdminFetch.mock.calls[0][0]).not.toContain("neighborhood=");
  expect(screen.queryByText("Showing one neighborhood")).toBeNull();
});

// ---- Found in messages (access codes section) ----

const FOUND_ROW = {
  id: "f1", customerId: "cust-1", customerName: "Pat Sample", kind: "door", code: "9876", instructions: null,
  life: "standing", scheduledServiceId: null, scheduledDate: null, status: "found", sourceType: "sms",
  sourceQuote: "Door code is 9876", sourceAt: "2026-10-03T15:00:00.000Z",
  visitChoices: [{ id: "v1", scheduled_date: "2026-10-08", service_type: "Pest control", status: "confirmed" }],
};

function foundRoutes(over = {}) {
  return (path, init = {}) => {
    if (path.startsWith("/admin/access-codes/found")) return over.found ? over.found() : response({ total: 1, items: [FOUND_ROW] });
    if (path.startsWith("/admin/access-codes/")) return response({ accessCode: { ...FOUND_ROW, status: "active" } });
    if (path.startsWith("/admin/customers/cust-1")) return response({ upcomingScheduled: [{ id: "v1", scheduled_date: "2026-10-08", service_type: "Pest control", status: "confirmed" }] });
    return response(ALL);
  };
}

it("has no Found in messages tab when the access codes section is off (404)", async () => {
  rawAdminFetch.mockImplementation((path) => (path.startsWith("/admin/access-codes/found")
    ? response({ enabled: false }, { ok: false, status: 404 })
    : response(ALL)));
  renderPage();
  expect(await screen.findByText("Synthetic Oaks")).toBeInTheDocument();
  await waitFor(() => expect(rawAdminFetch.mock.calls.some(([p]) => p.startsWith("/admin/access-codes/found"))).toBe(true));
  expect(screen.queryByRole("button", { name: /Found in messages/ })).toBeNull();
});

it("lists found codes with the customer linked, the client sentence and the code; Save posts accept", async () => {
  let items = [FOUND_ROW];
  rawAdminFetch.mockImplementation((path, init) => {
    if (path.startsWith("/admin/access-codes/found")) return response({ total: items.length, items });
    if (init?.method === "POST") { items = []; return response({ accessCode: {} }); }
    return foundRoutes()(path, init);
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  expect(await screen.findByText("Door code is 9876")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Pat Sample" })).toHaveAttribute("href", "/admin/customers?customerId=cust-1");
  expect(screen.getByLabelText("Code")).toHaveValue("9876");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByText("No codes are waiting.")).toBeInTheDocument());
  const post = rawAdminFetch.mock.calls.find(([, init]) => init?.method === "POST");
  expect(post[0]).toBe("/admin/access-codes/f1/accept");
  // Nothing edited: the save sends no field, so the server keeps the row as filed.
  expect(JSON.parse(post[1].body)).toEqual({});
});

it("Dismiss posts dismiss, and a one-visit code offers the visits that came with the list", async () => {
  rawAdminFetch.mockImplementation(foundRoutes());
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  await screen.findByText("Door code is 9876");
  fireEvent.click(screen.getByRole("button", { name: "This visit only" }));
  expect(await screen.findByRole("option", { name: "Thu, Oct 8 · Pest control" })).toBeInTheDocument();
  // The choices come with the found list: no customer record is loaded per card.
  expect(rawAdminFetch.mock.calls.some(([p]) => String(p).startsWith("/admin/customers/"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(rawAdminFetch.mock.calls.some(([p]) => p === "/admin/access-codes/f1/dismiss")).toBe(true));
});

it("a failed first load keeps the tab with a retry", async () => {
  let calls = 0;
  rawAdminFetch.mockImplementation((path, init) => (path.startsWith("/admin/access-codes/found")
    ? (++calls === 1 ? response({ error: "Server error" }, { ok: false, status: 500 }) : response({ total: 1, items: [FOUND_ROW] }))
    : foundRoutes()(path, init)));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /Found in messages/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Try again|Retry/ }));
  expect(await screen.findByText("Door code is 9876")).toBeInTheDocument();
});

it("a row the server changed starts a fresh draft, so Save never sends the old life back", async () => {
  let version = 1;
  rawAdminFetch.mockImplementation((path, init) => (path.startsWith("/admin/access-codes/found")
    ? response({ total: 1, items: [version === 1 ? FOUND_ROW : { ...FOUND_ROW, life: "visit", updatedAt: "2026-10-04T10:00:00.000Z" }] })
    : foundRoutes()(path, init)));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /Found in messages/ }));
  await screen.findByText("Door code is 9876");
  version = 2;
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "This visit only" })).toHaveAttribute("aria-pressed", "true"));
});

it("shows the server's message when a save is refused", async () => {
  rawAdminFetch.mockImplementation((path, init) => (init?.method === "POST"
    ? response({ error: "That customer already has this code", code: "duplicate_active" }, { ok: false, status: 409 })
    : foundRoutes()(path, init)));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByText("That customer already has this code")).toBeInTheDocument();
});

// ---- A code from a number with no customer record (owner ruling 2026-10-05) ----

const UNLINKED_ROW = {
  id: "f2", customerId: null, customerName: null, senderPhone: "+19415550188", kind: "pass", code: null,
  instructions: "View your pass: https://pass.example.com/v/abc123", life: "standing", scheduledServiceId: null, scheduledDate: null,
  status: "found", sourceType: "sms", sourceQuote: "Shared with you a Visitor Pass to visit 4455 Example Lane", sourceAt: "2026-10-03T15:00:00.000Z",
  suggestedCustomer: { id: "cust-9", name: "Pat Sample", address: "4455 Example Lane, Lakewood Ranch" },
};

function unlinkedRoutes({ linkedAfter = true } = {}) {
  let linked = false;
  return (path, init = {}) => {
    if (path.startsWith("/admin/access-codes/found")) {
      return response({ total: 1, items: [linked ? { ...UNLINKED_ROW, customerId: "cust-9", customerName: "Pat Sample", senderPhone: null, suggestedCustomer: null } : UNLINKED_ROW] });
    }
    if (path === "/admin/access-codes/f2/link" && init.method === "POST") { linked = linkedAfter; return response({ accessCode: {} }); }
    if (path.startsWith("/admin/customers?search=")) {
      return response({ customers: [{ id: "cust-7", firstName: "Lee", lastName: "Example", address: "12 Other Court", phone: "+19415550142" }] });
    }
    if (path.startsWith("/admin/customers/")) return response({ upcomingScheduled: [] });
    return response(ALL);
  };
}

it("a code from an unknown number shows the sender and a one-tap link to the suggested customer, with no Save until linked", async () => {
  rawAdminFetch.mockImplementation(unlinkedRoutes());
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  expect(await screen.findByText(/From \(941\) 555-0188, a number with no customer record/)).toBeInTheDocument();
  expect(screen.getByText("No customer yet")).toBeInTheDocument();
  expect(screen.getByText("4455 Example Lane, Lakewood Ranch")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Link to Pat Sample" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument());
  const post = rawAdminFetch.mock.calls.find(([, init]) => init?.method === "POST");
  expect(post[0]).toBe("/admin/access-codes/f2/link");
  expect(JSON.parse(post[1].body)).toEqual({ customerId: "cust-9" });
  // Linked: it is an ordinary found row now, under the customer's name.
  expect(screen.getByRole("link", { name: "Pat Sample" })).toHaveAttribute("href", "/admin/customers?customerId=cust-9");
  expect(screen.queryByText(/a number with no customer record/)).toBeNull();
});

it("a code from an email address with no customer shows the address, and the row says Email", async () => {
  rawAdminFetch.mockImplementation((path, init) => (path.startsWith("/admin/access-codes/found")
    ? response({ total: 1, items: [{ ...UNLINKED_ROW, senderPhone: null, senderEmail: "stranger@example.invalid", sourceType: "email", code: "#4821", kind: "neighborhood_gate", instructions: null,
      sourceQuote: "the gate code is #4821", suggestedCustomer: null }] })
    : unlinkedRoutes()(path, init)));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  expect(await screen.findByText(/From stranger@example.invalid, an address with no customer record/)).toBeInTheDocument();
  expect(screen.queryByText(/a number with no customer record/)).toBeNull();
  expect(screen.getByText(/^Email, /)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("with no suggestion the office finds a customer and links the one it picks", async () => {
  rawAdminFetch.mockImplementation((path, init) => (path.startsWith("/admin/access-codes/found")
    ? response({ total: 1, items: [{ ...UNLINKED_ROW, suggestedCustomer: null }] })
    : unlinkedRoutes()(path, init)));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  expect(screen.queryByRole("button", { name: /^Link to / })).toBeNull();
  fireEvent.change(await screen.findByLabelText("Find a customer"), { target: { value: "Example" } });
  const pick = await screen.findByRole("button", { name: "Lee Example · 12 Other Court · +19415550142" });
  expect(rawAdminFetch.mock.calls.some(([p]) => p === "/admin/customers?search=Example&limit=8&sort=name")).toBe(true);
  fireEvent.click(pick);
  await waitFor(() => expect(rawAdminFetch.mock.calls.some(([p, init]) => p === "/admin/access-codes/f2/link" && init?.method === "POST")).toBe(true));
  const post = rawAdminFetch.mock.calls.find(([p]) => p === "/admin/access-codes/f2/link");
  expect(JSON.parse(post[1].body)).toEqual({ customerId: "cust-7" });
});

it("an unlinked code can be dismissed, and a refused link shows the server's message", async () => {
  rawAdminFetch.mockImplementation((path, init) => (path === "/admin/access-codes/f2/link"
    ? response({ error: "That code already belongs to a customer", code: "not_unlinked" }, { ok: false, status: 409 })
    : unlinkedRoutes()(path, init)));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  fireEvent.click(await screen.findByRole("button", { name: "Link to Pat Sample" }));
  expect(await screen.findByText("That code already belongs to a customer")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(rawAdminFetch.mock.calls.some(([p]) => p === "/admin/access-codes/f2/dismiss")).toBe(true));
});

it("a new search term clears the old results at once and no result can be picked while a search runs", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  rawAdminFetch.mockImplementation((path, init) => {
    if (path.startsWith("/admin/access-codes/found")) return response({ total: 1, items: [{ ...UNLINKED_ROW, suggestedCustomer: null }] });
    if (path === "/admin/customers?search=Example&limit=8&sort=name") {
      return response({ customers: [{ id: "cust-7", firstName: "Lee", lastName: "Example", address: "12 Other Court", phone: "+19415550142" }] });
    }
    if (path === "/admin/customers?search=Examples&limit=8&sort=name") return pending.then(() => response({ customers: [] }));
    return unlinkedRoutes()(path, init);
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  const box = await screen.findByLabelText("Find a customer");
  fireEvent.change(box, { target: { value: "Example" } });
  expect(await screen.findByRole("button", { name: /Lee Example/ })).toBeEnabled();
  fireEvent.change(box, { target: { value: "Examples" } });
  expect(screen.queryByRole("button", { name: /Lee Example/ })).toBeNull();
  release();
  await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
  expect(screen.queryByRole("button", { name: /Lee Example/ })).toBeNull();
});

const SEARCH_EXAMPLE = "/admin/customers?search=Example&limit=8&sort=name";
const LEE = { id: "cust-7", firstName: "Lee", lastName: "Example", address: "12 Other Court", phone: "+19415550142" };
const noSuggestion = (route) => (path, init) => (path.startsWith("/admin/access-codes/found")
  ? response({ total: 1, items: [{ ...UNLINKED_ROW, suggestedCustomer: null }] })
  : route(path, init));

it("a failed customer search says so with Try again, which reruns the same term", async () => {
  let fail = true;
  rawAdminFetch.mockImplementation(noSuggestion((path, init) => {
    if (path === SEARCH_EXAMPLE) return fail ? response({}, { ok: false, status: 503 }) : response({ customers: [LEE] });
    return unlinkedRoutes()(path, init);
  }));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  fireEvent.change(await screen.findByLabelText("Find a customer"), { target: { value: "Example" } });
  // A failure never reads as "no one matched".
  expect(await screen.findByText("Could not search customers")).toBeInTheDocument();
  expect(screen.queryByText("No customer matches.")).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: /Lee Example/ })).toBeEnabled();
  expect(screen.queryByText("Could not search customers")).toBeNull();
  expect(rawAdminFetch.mock.calls.filter(([p]) => p === SEARCH_EXAMPLE)).toHaveLength(2);
});

it("a search that finds no one says No customer matches, with no error", async () => {
  rawAdminFetch.mockImplementation(noSuggestion((path, init) => (path === "/admin/customers?search=Nobody&limit=8&sort=name"
    ? response({ customers: [] })
    : unlinkedRoutes()(path, init))));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  fireEvent.change(await screen.findByLabelText("Find a customer"), { target: { value: "Nobody" } });
  expect(await screen.findByText("No customer matches.")).toBeInTheDocument();
  expect(screen.queryByText("Could not search customers")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("a failure that answers after the term changed never shows over the new term's results", async () => {
  let failOld;
  const old = new Promise((resolve) => { failOld = resolve; });
  rawAdminFetch.mockImplementation(noSuggestion((path, init) => {
    if (path === "/admin/customers?search=Exam&limit=8&sort=name") return old.then(() => response({}, { ok: false, status: 503 }));
    if (path === SEARCH_EXAMPLE) return response({ customers: [LEE] });
    return unlinkedRoutes()(path, init);
  }));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  const box = await screen.findByLabelText("Find a customer");
  fireEvent.change(box, { target: { value: "Exam" } });
  await waitFor(() => expect(rawAdminFetch.mock.calls.some(([p]) => p === "/admin/customers?search=Exam&limit=8&sort=name")).toBe(true));
  fireEvent.change(box, { target: { value: "Example" } });
  expect(await screen.findByRole("button", { name: /Lee Example/ })).toBeEnabled();
  failOld();
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(screen.queryByText("Could not search customers")).toBeNull();
  expect(screen.getByRole("button", { name: /Lee Example/ })).toBeEnabled();
});

// ---- The found-codes bell links here with ?view=found ----

it("a bell link (?view=found) opens Found in messages without a click", async () => {
  rawAdminFetch.mockImplementation(foundRoutes());
  renderPage("/?view=found");
  expect(await screen.findByText("Door code is 9876")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Found in messages (1)" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText("Synthetic Oaks")).toBeNull();
});

it("a bell link with the access codes section off shows the neighborhoods", async () => {
  rawAdminFetch.mockImplementation((path) => (path.startsWith("/admin/access-codes/found")
    ? response({ enabled: false }, { ok: false, status: 404 })
    : response(ALL)));
  renderPage("/?view=found");
  expect(await screen.findByText("Synthetic Oaks")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Found in messages/ })).toBeNull();
});

it("a bell link on a page already open switches to Found in messages with a fresh read, and works again", async () => {
  rawAdminFetch.mockImplementation(foundRoutes());
  function GoToBell() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate("/?view=found")}>Open found bell</button>;
  }
  render(<MemoryRouter initialEntries={["/"]}><GoToBell /><NeighborhoodGateCodesPage /></MemoryRouter>);
  expect(await screen.findByText("Synthetic Oaks")).toBeInTheDocument();
  const foundReads = () => rawAdminFetch.mock.calls.filter(([p]) => p.startsWith("/admin/access-codes/found")).length;
  await waitFor(() => expect(foundReads()).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Open found bell" }));
  expect(await screen.findByText("Door code is 9876")).toBeInTheDocument();
  await waitFor(() => expect(foundReads()).toBe(2));
  // Back to the neighborhoods, then the bell again: the marker was dropped, so it opens again.
  fireEvent.click(screen.getByRole("button", { name: "Neighborhoods" }));
  expect(await screen.findByText("Synthetic Oaks")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open found bell" }));
  expect(await screen.findByText("Door code is 9876")).toBeInTheDocument();
  await waitFor(() => expect(foundReads()).toBe(3));
});

// Neighborhood merge (GATE_NEIGHBORHOOD_MERGE, owner 2026-10-25).
const MERGE_LIST = {
  total: 1,
  mergeEnabled: true,
  neighborhoods: [{ ...ALL.neighborhoods[0], mergedIn: [] }],
};
const PICKS = {
  total: 3,
  neighborhoods: [
    { id: "n1", name: "Synthetic Oaks", county: "Manatee", propertyCount: 3, entries: [] },
    { id: "n4", name: "Synthetic Oaks Estates", county: "Manatee", propertyCount: 5, entries: [] },
    { id: "n5", name: "Synthetic Oaks South", county: "Sarasota", propertyCount: 2, entries: [] },
  ],
};

it("shows no merge controls while the merge switch is off", async () => {
  rawAdminFetch.mockImplementation(() => response(ALL));
  renderPage();
  await screen.findByText("Synthetic Oaks");
  expect(screen.queryByRole("button", { name: "Merge into…" })).toBeNull();
  expect(screen.queryByText("Also named:")).toBeNull();
  expect(rawAdminFetch.mock.calls.some(([p]) => p.includes("merge-suggestions"))).toBe(false);
});

it("Merge into… offers only other neighborhoods of the same county, shows what moves from a dry run, then merges", async () => {
  rawAdminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST" && path.endsWith("/merge")) {
      const { dryRun } = JSON.parse(options.body);
      return response({ mergeId: dryRun ? null : "m9", homes: 3, entries: 1, duplicatesRetired: 1, relabeled: 0, dryRun: !!dryRun });
    }
    if (path.includes("picker=1")) return response(PICKS);
    return response(MERGE_LIST);
  });
  renderPage();
  await screen.findByText("Synthetic Oaks");
  fireEvent.click(screen.getByRole("button", { name: "Merge into…" }));
  fireEvent.change(screen.getByLabelText("Merge into"), { target: { value: "oaks" } });
  const choice = await screen.findByRole("button", { name: "Synthetic Oaks Estates · 5 properties" });
  expect(screen.queryByRole("button", { name: /Synthetic Oaks South/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Synthetic Oaks · 3 properties" })).toBeNull();
  const search = rawAdminFetch.mock.calls.find(([p]) => p.includes("picker=1"));
  expect(search[0]).toBe("/admin/neighborhood-access?q=oaks&limit=8&picker=1");

  fireEvent.click(choice);
  expect(await screen.findByText(
    'Moves 3 homes and 1 gate entry into Synthetic Oaks Estates. 1 code on file in both is kept once. "Synthetic Oaks" becomes another name for it. Undo merge puts it back.',
  )).toBeInTheDocument();
  const dry = rawAdminFetch.mock.calls.find(([p, o]) => p.endsWith("/merge") && JSON.parse(o.body).dryRun);
  expect(dry[0]).toBe("/admin/neighborhood-access/n1/merge");
  expect(JSON.parse(dry[1].body)).toEqual({ into: "n4", dryRun: true });

  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  expect(await screen.findByText("Merged Synthetic Oaks into Synthetic Oaks Estates")).toBeInTheDocument();
  const real = rawAdminFetch.mock.calls.filter(([p]) => p.endsWith("/merge")).at(-1);
  expect(JSON.parse(real[1].body)).toEqual({ into: "n4" });
});

it("a refused merge shows the server's message in the panel", async () => {
  rawAdminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST" && path.endsWith("/merge")) {
      return JSON.parse(options.body).dryRun
        ? response({ homes: 1, entries: 0, duplicatesRetired: 0, relabeled: 0, dryRun: true })
        : response({ error: "Both neighborhoods have a gate location. Clear one, then merge.", code: "pins" }, { ok: false, status: 409 });
    }
    if (path.includes("picker=1")) return response(PICKS);
    return response(MERGE_LIST);
  });
  renderPage();
  await screen.findByText("Synthetic Oaks");
  fireEvent.click(screen.getByRole("button", { name: "Merge into…" }));
  fireEvent.change(screen.getByLabelText("Merge into"), { target: { value: "oaks" } });
  fireEvent.click(await screen.findByRole("button", { name: "Synthetic Oaks Estates · 5 properties" }));
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  expect(await screen.findByText("Both neighborhoods have a gate location. Clear one, then merge.")).toBeInTheDocument();
});

it("Undo merge asks first, posts the undo and says what stayed", async () => {
  const merged = { ...MERGE_LIST, neighborhoods: [{ ...MERGE_LIST.neighborhoods[0], mergedIn: [{ mergeId: "m1", name: "Synthetic Oaks Lwr", mergedAt: "2026-10-25T16:00:00.000Z" }] }] };
  rawAdminFetch.mockImplementation((path, options) => (
    options?.method === "POST" ? response({ homes: 1, homesKept: 0, entries: 0, entriesKept: 1 }) : response(merged)
  ));
  renderPage();
  expect(await screen.findByText("Synthetic Oaks Lwr")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo merge" }));
  expect(window.confirm).toHaveBeenCalledWith("Undo the merge of Synthetic Oaks Lwr? Its homes and gate entries go back to it.");
  expect(await screen.findByText("Undid the merge of Synthetic Oaks Lwr. 1 item changed since stays here.")).toBeInTheDocument();
  const post = rawAdminFetch.mock.calls.find(([, o]) => o?.method === "POST");
  expect(post[0]).toBe("/admin/neighborhood-access/merges/m1/undo");
});

const SUGGESTED = {
  suggestions: [{
    source: { id: "n7", name: "Synthetic Oaks Lwr", county: "Manatee", propertyCount: 2, liveEntries: 0 },
    target: { id: "n1", name: "Synthetic Oaks", county: "Manatee", propertyCount: 3, liveEntries: 1 },
  }],
};

it("Possible duplicates lists a pair; Review merge runs the dry run on that pair, then merges", async () => {
  rawAdminFetch.mockImplementation((path, options) => {
    if (path.endsWith("/merge-suggestions")) return response(SUGGESTED);
    if (options?.method === "POST" && path.endsWith("/merge")) {
      const { dryRun } = JSON.parse(options.body);
      return response({ mergeId: dryRun ? null : "m8", homes: 2, entries: 0, duplicatesRetired: 0, relabeled: 0, dryRun: !!dryRun });
    }
    return response(MERGE_LIST);
  });
  renderPage();
  expect(await screen.findByText("Possible duplicates (1)")).toBeInTheDocument();
  expect(screen.getByText("Synthetic Oaks Lwr · 2 properties → Synthetic Oaks · 3 properties")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review merge" }));
  expect(await screen.findByText(
    'Moves 2 homes and 0 gate entries into Synthetic Oaks. "Synthetic Oaks Lwr" becomes another name for it. Undo merge puts it back.',
  )).toBeInTheDocument();
  const dry = rawAdminFetch.mock.calls.find(([p, o]) => p.endsWith("/merge") && JSON.parse(o.body).dryRun);
  expect(dry[0]).toBe("/admin/neighborhood-access/n7/merge");
  expect(JSON.parse(dry[1].body)).toEqual({ into: "n1", dryRun: true });
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  expect(await screen.findByText("Merged Synthetic Oaks Lwr into Synthetic Oaks")).toBeInTheDocument();
});

it("Not the same posts the pair, and the list reloads without it", async () => {
  let dismissed = false;
  rawAdminFetch.mockImplementation((path, options) => {
    if (path.endsWith("/merge-suggestions/dismiss")) { dismissed = true; return response({ dismissed: true }); }
    if (path.endsWith("/merge-suggestions")) return response(dismissed ? { suggestions: [] } : SUGGESTED);
    return response(MERGE_LIST);
  });
  renderPage();
  await screen.findByText("Possible duplicates (1)");
  fireEvent.click(screen.getByRole("button", { name: "Not the same" }));
  expect(await screen.findByText("Marked Synthetic Oaks Lwr and Synthetic Oaks as not the same")).toBeInTheDocument();
  const post = rawAdminFetch.mock.calls.find(([p]) => p.endsWith("/merge-suggestions/dismiss"));
  expect(JSON.parse(post[1].body)).toEqual({ sourceId: "n7", targetId: "n1" });
  await waitFor(() => expect(screen.queryByText("Possible duplicates (1)")).toBeNull());
});

// Homes not placed + Add as unconfirmed (GATE_NEIGHBORHOOD_UNPLACED, owner 2026-10-26).
const UNPLACED_LIST = { ...ALL, unplacedEnabled: true };
const UNPLACED = {
  homes: [
    { propertyId: "p1", customerId: "c1", customerName: "Sample Owner", address: "100 Synthetic Way, Lakewood Ranch", zip: "34211", savedCode: true,
      countyLot: { zip: "34201", county: "Manatee", community: "Heron Pointe at Sample Place" } },
    { propertyId: "p2", customerId: "c2", customerName: "Other Owner", address: "200 Synthetic Way, Lakewood Ranch", zip: "34211", savedCode: true, countyLot: null },
  ],
};

it("Homes not placed lists each home with why; Link asks first, then links it to the county's community", async () => {
  rawAdminFetch.mockImplementation((path, options) => {
    if (path.endsWith("/unplaced")) return response(UNPLACED);
    if (options?.method === "PUT") return response({ id: "p1" });
    return response(UNPLACED_LIST);
  });
  renderPage();
  expect(await screen.findByText("Homes not placed (2)")).toBeInTheDocument();
  expect(screen.getByText(
    "ZIP 34211 here, 34201 on the county's lot; the county puts it in Heron Pointe at Sample Place. Its saved gate code reaches only this customer's stops.",
  )).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Other Owner" })).toHaveAttribute("href", "/admin/customers?customerId=c2");
  expect(screen.getAllByRole("button", { name: /^Link to / })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Link to Heron Pointe at Sample Place" }));
  expect(window.confirm).toHaveBeenCalledWith(
    "Link 100 Synthetic Way, Lakewood Ranch to Heron Pointe at Sample Place? That neighborhood's gate codes will show at this home.",
  );
  expect(await screen.findByText("Linked 100 Synthetic Way, Lakewood Ranch to Heron Pointe at Sample Place")).toBeInTheDocument();
  const put = rawAdminFetch.mock.calls.find(([, o]) => o?.method === "PUT");
  expect(put[0]).toBe("/admin/neighborhood-access/properties/p1/neighborhood");
  expect(JSON.parse(put[1].body)).toEqual({ create: { name: "Heron Pointe at Sample Place", county: "Manatee" } });
});

it("Add entry offers 'I have not seen this work' only with the switch on, and sends it as unconfirmed", async () => {
  rawAdminFetch.mockImplementation((path, options) => {
    if (path.endsWith("/unplaced")) return response({ homes: [] });
    if (options?.method === "POST") return response({ id: "e9", status: "needs_confirm" });
    return response(UNPLACED_LIST);
  });
  renderPage();
  await screen.findByText("Synthetic Oaks");
  expect(screen.queryByText(/^Homes not placed/)).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Add entry" })[0]);
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: "6413" } });
  fireEvent.click(screen.getByLabelText("I have not seen this work (file it as Needs confirm)"));
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  await screen.findByText("Entry added");
  const post = rawAdminFetch.mock.calls.find(([, o]) => o?.method === "POST");
  expect(JSON.parse(post[1].body)).toEqual({ gate_label: "Main gate", access_type: "keypad", code: "6413", gate_location: null, unconfirmed: true });
});

it("with the switch off there is no unconfirmed box and no list request", async () => {
  rawAdminFetch.mockImplementation(() => response(ALL));
  renderPage();
  await screen.findByText("Synthetic Oaks");
  fireEvent.click(screen.getAllByRole("button", { name: "Add entry" })[0]);
  expect(screen.queryByLabelText("I have not seen this work (file it as Needs confirm)")).toBeNull();
  expect(rawAdminFetch.mock.calls.some(([p]) => p.endsWith("/unplaced"))).toBe(false);
});

// The two help lists when a read fails, and refused actions from their rows.
const BOTH_LISTS = { ...ALL, mergeEnabled: true, unplacedEnabled: true };
const UNAVAILABLE = () => response({}, { ok: false, status: 503 });
const panelOf = (heading) => screen.getByText(heading).parentElement;
// A list row: the nearest bordered box around one of its buttons.
const rowOf = (button) => button.parentElement.closest(".rounded-sm");

it("a help list whose first read fails says it could not load, with Try again, never reading as empty", async () => {
  let failing = true;
  rawAdminFetch.mockImplementation((path) => {
    if (path.endsWith("/merge-suggestions")) return failing ? UNAVAILABLE() : response(SUGGESTED);
    if (path.endsWith("/unplaced")) return failing ? UNAVAILABLE() : response(UNPLACED);
    return response(BOTH_LISTS);
  });
  renderPage();
  await screen.findByText("Synthetic Oaks");
  await waitFor(() => expect(screen.getAllByText("Could not load this list.")).toHaveLength(2));
  expect(within(panelOf("Possible duplicates")).getByText("Could not load this list.")).toBeInTheDocument();
  failing = false;
  fireEvent.click(within(panelOf("Possible duplicates")).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Possible duplicates (1)")).toBeInTheDocument();
  expect(within(panelOf("Homes not placed")).getByText("Could not load this list.")).toBeInTheDocument();
  fireEvent.click(within(panelOf("Homes not placed")).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Homes not placed (2)")).toBeInTheDocument();
  expect(screen.queryByText("Could not load this list.")).toBeNull();
});

it("a help list whose refresh fails after a write keeps its rows and says they may be out of date", async () => {
  let failing = false;
  rawAdminFetch.mockImplementation((path, options) => {
    if (path.endsWith("/merge-suggestions")) return failing ? UNAVAILABLE() : response(SUGGESTED);
    if (path.endsWith("/unplaced")) return failing ? UNAVAILABLE() : response(UNPLACED);
    if (options?.method === "PATCH") { failing = true; return response({ id: "e1", status: "active" }); }
    return response(BOTH_LISTS);
  });
  renderPage();
  expect(await screen.findByText("Possible duplicates (1)")).toBeInTheDocument();
  expect(await screen.findByText("Homes not placed (2)")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Confirm" })[0]);
  // The write worked and says so; each list it could not read again stays, marked.
  expect(await screen.findByText("Confirmed")).toBeInTheDocument();
  expect(within(panelOf("Possible duplicates (1)")).getByText("Could not refresh this list. It may be out of date.")).toBeInTheDocument();
  expect(within(panelOf("Homes not placed (2)")).getByText("Could not refresh this list. It may be out of date.")).toBeInTheDocument();
  expect(screen.getByText("Synthetic Oaks Lwr · 2 properties → Synthetic Oaks · 3 properties")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Link to Heron Pointe at Sample Place" })).toBeInTheDocument();
});

it("a refused home link shows the server's message in that home's row, and a retry that works removes the home", async () => {
  let refuse = true;
  let linked = false;
  rawAdminFetch.mockImplementation((path, options) => {
    if (path.endsWith("/merge-suggestions")) return response(SUGGESTED);
    if (path.endsWith("/unplaced")) return response(linked ? { homes: [UNPLACED.homes[1]] } : UNPLACED);
    if (options?.method === "PUT") {
      if (refuse) return response({ error: "That neighborhood is switched off" }, { ok: false, status: 409 });
      linked = true;
      return response({ id: "p1" });
    }
    return response(BOTH_LISTS);
  });
  renderPage();
  await screen.findByText("Possible duplicates (1)");
  const link = await screen.findByRole("button", { name: "Link to Heron Pointe at Sample Place" });
  fireEvent.click(link);
  // Beside the button that failed, once: not under the directory filters.
  expect(await within(rowOf(link)).findByRole("alert")).toHaveTextContent("That neighborhood is switched off");
  expect(screen.getAllByText("That neighborhood is switched off")).toHaveLength(1);
  refuse = false;
  fireEvent.click(link);
  expect(await screen.findByText("Linked 100 Synthetic Way, Lakewood Ranch to Heron Pointe at Sample Place")).toBeInTheDocument();
  expect(screen.getByText("Homes not placed (1)")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Link to Heron Pointe at Sample Place" })).toBeNull();
  expect(screen.queryByText("That neighborhood is switched off")).toBeNull();
});

it("a refused Not the same shows the server's message in that pair's row", async () => {
  rawAdminFetch.mockImplementation((path) => {
    if (path.endsWith("/merge-suggestions/dismiss")) return response({ error: "Neighborhood not found" }, { ok: false, status: 404 });
    if (path.endsWith("/merge-suggestions")) return response(SUGGESTED);
    return response(MERGE_LIST);
  });
  renderPage();
  await screen.findByText("Possible duplicates (1)");
  const notSame = screen.getByRole("button", { name: "Not the same" });
  fireEvent.click(notSame);
  expect(await within(rowOf(notSame)).findByRole("alert")).toHaveTextContent("Neighborhood not found");
  expect(screen.getAllByText("Neighborhood not found")).toHaveLength(1);
});
