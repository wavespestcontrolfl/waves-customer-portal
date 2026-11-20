// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

import BuilderProspectsPage, { summaryText } from "./BuilderProspectsPage";

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({ ok, status, json: async () => body });

const POOL = {
  kind: "pool", dataThrough: "2026-11-13", week: { from: "2026-11-07", through: "2026-11-13", permits: 41, builders: 17 },
  builders: [
    { key: "SAMPLE POOLS", name: "SAMPLE POOLS LLC", license: "CPC111", permits30: 6, permits90: 14, permits365: 52, firstPermit: "2026-01-05", lastPermit: "2026-11-16", isNew: false, isCustomer: true },
    { key: "FRESH POOLS", name: "FRESH POOLS INC", license: "CPC222", permits30: 2, permits90: 2, permits365: 2, firstPermit: "2026-11-02", lastPermit: "2026-11-12", isNew: true, isCustomer: false },
  ],
};
const HOME = {
  kind: "home", dataThrough: "2026-11-16", week: { from: "2026-11-10", through: "2026-11-16", permits: 1, builders: 1 },
  builders: [{ key: "SAMPLE HOMES", name: "SAMPLE HOMES LLC", license: "CGC333", permits30: 5, permits90: 20, permits365: 80, firstPermit: "2026-01-05", lastPermit: "2026-11-14", isNew: false, isCustomer: false }],
};
const SITES = { permits: [{ id: "P-1", issuedDate: "2026-11-16", status: "Permit Issued", address: "200 SAMPLE TRL", city: "PARRISH", zip: "34219", typeOfWork: null }] };

function route(handlers) {
  adminFetch.mockImplementation((path) => {
    const handler = handlers[path];
    return handler ? handler() : reply({ error: `unexpected ${path}` }, { ok: false, status: 500 });
  });
}
const renderPage = () => render(<MemoryRouter><BuilderProspectsPage embedded /></MemoryRouter>);

beforeEach(() => adminFetch.mockReset());
afterEach(() => cleanup());

it("opens on pool builders with the summary sentence, the county note, the table and the New and Customer badges", async () => {
  route({ "/admin/prospects/builders?kind=pool": () => reply(POOL) });
  renderPage();
  expect(await screen.findByText("41 pool permits in the 7 days to Nov 13, from 17 builders.")).toBeInTheDocument();
  expect(screen.getByText(/Unincorporated Manatee County only/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pool builders" })).toHaveAttribute("aria-pressed", "true");

  const table = screen.getByRole("table", { name: "Builders" });
  expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Builder", "License", "30 days", "90 days", "12 months", "Newest permit"]);
  const sample = within(table).getByRole("button", { name: "SAMPLE POOLS LLC" }).closest("tr");
  expect(within(sample).getByText("Customer")).toBeInTheDocument();
  expect(within(sample).queryByText("New")).toBeNull();
  expect(within(sample).getByText("CPC111")).toBeInTheDocument();
  expect(within(sample).getByText("52")).toBeInTheDocument();
  expect(within(sample).getByText("Nov 16, 2026")).toBeInTheDocument();
  const fresh = within(table).getByRole("button", { name: "FRESH POOLS INC" }).closest("tr");
  expect(within(fresh).getByText("New")).toBeInTheDocument();
  expect(within(fresh).queryByText("Customer")).toBeNull();
});

it("switching to Home builders loads the home list and says new-home permits", async () => {
  route({
    "/admin/prospects/builders?kind=pool": () => reply(POOL),
    "/admin/prospects/builders?kind=home": () => reply(HOME),
  });
  renderPage();
  await screen.findByText("SAMPLE POOLS LLC");
  fireEvent.click(screen.getByRole("button", { name: "Home builders" }));
  expect(await screen.findByText("SAMPLE HOMES LLC")).toBeInTheDocument();
  expect(screen.getByText("1 new-home permit in the 7 days to Nov 16, from 1 builder.")).toBeInTheDocument();
  expect(screen.queryByText("SAMPLE POOLS LLC")).toBeNull();
  expect(screen.getByRole("button", { name: "Home builders" })).toHaveAttribute("aria-pressed", "true");
});

it("pressing a builder loads its job sites once, shows them, and pressing again closes them", async () => {
  route({
    "/admin/prospects/builders?kind=pool": () => reply(POOL),
    "/admin/prospects/builders/permits?kind=pool&builder=SAMPLE%20POOLS": () => reply(SITES),
  });
  renderPage();
  const toggle = await screen.findByRole("button", { name: "SAMPLE POOLS LLC" });
  expect(adminFetch).toHaveBeenCalledTimes(1);

  fireEvent.click(toggle);
  const sites = await screen.findByRole("table", { name: "Newest job sites" });
  expect(within(sites).getByText("200 SAMPLE TRL")).toBeInTheDocument();
  expect(within(sites).getByText("PARRISH 34219")).toBeInTheDocument();
  expect(within(sites).getByText("Permit Issued")).toBeInTheDocument();
  expect(within(sites).getByText("Nov 16, 2026")).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-expanded", "true");

  fireEvent.click(toggle);
  expect(screen.queryByRole("table", { name: "Newest job sites" })).toBeNull();
  fireEvent.click(toggle);
  expect(await screen.findByRole("table", { name: "Newest job sites" })).toBeInTheDocument();
  expect(adminFetch).toHaveBeenCalledTimes(2); // the list and one job-site read; the reopen used the saved answer
});

it("shows a plain error with Try again when the list fails, and recovers", async () => {
  let calls = 0;
  route({ "/admin/prospects/builders?kind=pool": () => (++calls === 1 ? reply({ error: "Could not load the builders list." }, { ok: false, status: 500 }) : reply(POOL)) });
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the builders list.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("SAMPLE POOLS LLC")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows an empty message when a kind has no builders", async () => {
  route({ "/admin/prospects/builders?kind=pool": () => reply({ ...POOL, week: { ...POOL.week, permits: 0, builders: 0 }, builders: [] }) });
  renderPage();
  expect(await screen.findByText("No pool builders pulled a permit in the last 12 months.")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

it("a failed job-site read shows its error on that row and can be retried", async () => {
  let calls = 0;
  route({
    "/admin/prospects/builders?kind=pool": () => reply(POOL),
    "/admin/prospects/builders/permits?kind=pool&builder=FRESH%20POOLS": () => (++calls === 1 ? reply({ error: "Could not load that builder’s permits." }, { ok: false, status: 500 }) : reply(SITES)),
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "FRESH POOLS INC" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not load that builder’s permits.");
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("table", { name: "Newest job sites" })).toBeInTheDocument());
});

it("home job sites show the type of work column", async () => {
  route({
    "/admin/prospects/builders?kind=pool": () => reply(POOL),
    "/admin/prospects/builders?kind=home": () => reply(HOME),
    "/admin/prospects/builders/permits?kind=home&builder=SAMPLE%20HOMES": () => reply({ permits: [{ id: "H-1", issuedDate: "2026-11-14", status: "Permit Issued", address: "300 SAMPLE CT  PARRISH 34219", city: null, zip: "34219", typeOfWork: "New Single Family" }] }),
  });
  renderPage();
  await screen.findByText("SAMPLE POOLS LLC");
  fireEvent.click(screen.getByRole("button", { name: "Home builders" }));
  fireEvent.click(await screen.findByRole("button", { name: "SAMPLE HOMES LLC" }));
  const sites = await screen.findByRole("table", { name: "Newest job sites" });
  expect(within(sites).getByRole("columnheader", { name: "Type of work" })).toBeInTheDocument();
  expect(within(sites).getByText("New Single Family")).toBeInTheDocument();
});

it("summaryText says 'permit' for one and 'permits' for many, and names the week by its last day", () => {
  expect(summaryText({ week: { permits: 1, builders: 1 } }, "pool permit")).toBe("1 pool permit in the newest 7 days on file, from 1 builder.");
  expect(summaryText({ week: { through: "2026-11-16", permits: 0, builders: 0 } }, "pool permit")).toBe("0 pool permits in the 7 days to Nov 16, from 0 builders.");
  expect(summaryText({ week: { through: "2026-11-16", permits: 1132, builders: 21 } }, "new-home permit")).toBe("1,132 new-home permits in the 7 days to Nov 16, from 21 builders.");
});
