// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  expect(JSON.parse(post[1].body)).toEqual({ gate_label: "Main gate", access_type: "keypad", code: "2468" });
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
  expect(JSON.parse(post[1].body)).toEqual({ kind: "door", life: "standing", code: "9876", instructions: null });
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

it("shows the server's message when a save is refused", async () => {
  rawAdminFetch.mockImplementation((path, init) => (init?.method === "POST"
    ? response({ error: "That customer already has this code", code: "duplicate_active" }, { ok: false, status: 409 })
    : foundRoutes()(path, init)));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Found in messages (1)" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByText("That customer already has this code")).toBeInTheDocument();
});
