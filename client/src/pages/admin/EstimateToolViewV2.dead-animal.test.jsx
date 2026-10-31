// @vitest-environment jsdom
// Dead Rodent Removal & Odor Treatment (GATE_DEAD_ANIMAL_REMOVAL, new quotes only) on the staff estimator. The choice sits in
// the rodent section next to Rodent Sanitation, renders only when the rodent_dead_animal_removal read says the gate is on,
// carries a required Access select with NO default, and sends `RODENT_DEAD_ANIMAL` plus `options.deadAnimalAccess` on the
// calculate request - or nothing, byte for byte as before. The client never sends a "riding" value: the engine decides it.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

vi.setConfig({ testTimeout: 30000 });
vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = "500 Example Court, Venice, FL 34285";
const LABEL = "Dead Rodent Removal & Odor Treatment";
const ACCESS_LABELS = [
  "Choose access",
  "Easy reach (garage, crawl-space opening, under a cabinet, attic floor near the hatch)",
  "Attic search (found by smell, insulation moved as needed)",
  "Inside a wall or ceiling (needs an opening) - custom quote",
];

const RESULT = {
  recurring: { tier: "Bronze", grandTotal: 0, annualAfterDiscount: 0, services: [] },
  oneTime: { total: 169, items: [{ service: "rodent_dead_animal_removal", name: LABEL, price: 169 }] },
  results: {}, totals: { year2mo: 0, year1: 169 },
};

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400, status, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let deadAnimalRead;
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "qa-token");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  deadAnimalRead = { featureAvailable: true, data: {} };
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.includes("/admin/pricing-config/rodent_dead_animal_removal")) {
      return Promise.resolve(deadAnimalRead === null ? jsonResponse({ error: "Config not found" }, 404) : jsonResponse(deadAnimalRead));
    }
    if (path.endsWith("/estimator/property-lookup")) {
      return Promise.resolve(jsonResponse({ enriched: { homeSqFt: 2000, lotSqFt: 9000, stories: 1 }, errors: [] }));
    }
    if (path.endsWith("/calculate-estimate")) return Promise.resolve(jsonResponse(structuredClone(RESULT)));
    if (path.includes("/discounts")) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const calculateBodies = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith("/calculate-estimate"))
  .map(([, init]) => JSON.parse(init.body));

const renderNew = () => render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);

async function lookUp() {
  fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
  await screen.findByRole("region", { name: "Property lookup results" });
}

async function generate() {
  const before = calculateBodies().length;
  fireEvent.click(screen.getByRole("button", { name: /^(Generate Estimate|Regenerate)$/ }));
  await waitFor(() => expect(calculateBodies().length).toBe(before + 1));
  return calculateBodies()[before];
}

const checkbox = () => screen.findByRole("checkbox", { name: LABEL });

describe("availability (new quotes only)", () => {
  it("stays hidden while the gate is off, the row is missing or the read fails", async () => {
    for (const reply of [{ featureAvailable: false, data: {} }, { data: {} }, null]) {
      deadAnimalRead = reply;
      const { unmount } = renderNew();
      await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("rodent_dead_animal_removal"))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByRole("checkbox", { name: LABEL })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("shows the checkbox with the exact label, and the Access select appears only once it is ticked", async () => {
    renderNew();
    const box = await checkbox();
    expect(box).not.toBeChecked();
    expect(screen.queryByLabelText(/^Access/)).not.toBeInTheDocument();
    fireEvent.click(box);
    const select = screen.getByLabelText("Access (required)");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(ACCESS_LABELS);
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual(["", "reachable", "attic", "in_wall"]);
    // No default tier: the select starts empty and the note says an unchosen access is a custom quote.
    expect(select).toHaveValue("");
    expect(screen.getByTestId("dead-animal-note")).toHaveTextContent(/custom quote/i);
  });
});

describe("what the calculate request carries", () => {
  it("is unchanged with the choice off: no service, no option", async () => {
    renderNew();
    await checkbox();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    const body = await generate();
    expect(body.selectedServices).not.toContain("RODENT_DEAD_ANIMAL");
    expect(JSON.stringify(body)).not.toMatch(/deadAnimal|riding/i);
  });

  it.each([
    ["reachable", "reachable"],
    ["attic", "attic"],
    ["in_wall", "in_wall"],
  ])("sends RODENT_DEAD_ANIMAL and the %s access", async (value, expected) => {
    renderNew();
    fireEvent.click(await checkbox());
    await lookUp();
    fireEvent.change(screen.getByLabelText("Access (required)"), { target: { value } });
    const body = await generate();
    expect(body.selectedServices).toContain("RODENT_DEAD_ANIMAL");
    expect(body.options.deadAnimalAccess).toBe(expected);
  });

  it("an unchosen access goes out empty (the server quotes it as a custom quote), never a default tier", async () => {
    renderNew();
    fireEvent.click(await checkbox());
    await lookUp();
    const body = await generate();
    expect(body.selectedServices).toContain("RODENT_DEAD_ANIMAL");
    expect(body.options.deadAnimalAccess).toBe("");
  });

  it("never sends a riding value, even beside other rodent work", async () => {
    renderNew();
    fireEvent.click(await checkbox());
    fireEvent.click(screen.getByRole("checkbox", { name: "Rodent Sanitation", exact: true }));
    await lookUp();
    fireEvent.change(screen.getByLabelText("Access (required)"), { target: { value: "attic" } });
    const body = await generate();
    expect(body.selectedServices).toEqual(expect.arrayContaining(["RODENT_SANITATION", "RODENT_DEAD_ANIMAL"]));
    expect(JSON.stringify(body)).not.toMatch(/riding/i);
  });
});
