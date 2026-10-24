// @vitest-environment jsdom
// Mosquito misting system (GATE_MOSQUITO_MISTING) on the staff estimator. The
// section is dark: it renders only when the mosquito_misting_pricing read says the
// gate is on, takes its labels and limits from that read (never from the client),
// and sends `selectedServices: ["MOSQUITO_MISTING"]` plus `options.mosquitoMisting`
// - or nothing, byte for byte as before - on the calculate request. What the rep
// typed goes out as typed; the engine owns every range check.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

// A full estimator render per test: slow on a loaded runner.
vi.setConfig({ testTimeout: 30000 });
vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = "500 Example Court, Venice, FL 34285";

// The row in the server's shape. Labels and limits are the server's to change.
const MISTING_READ = {
  featureAvailable: true,
  misting: {
    enabled: true,
    tiers: [
      { key: "essential", label: "Server Essential Drum" },
      { key: "smart", label: "Server Smart Tankless" },
    ],
    solutions: [
      { key: "standard", label: "Server standard refill" },
      { key: "natural", label: "Server botanical refill" },
      { key: "premium", label: "Server premium refill" },
    ],
    limits: { minNozzles: 10, maxNozzles: 80, maxRisers: 80, maxRefillsPerYear: 24, defaultTier: "smart", defaultSolution: "standard", defaultRefillsPerYear: 4 },
  },
};

const pestLine = { service: "pest_control", name: "Pest Control", mo: 50, annual: 600 };
const RESULT = {
  recurring: { tier: "Bronze", grandTotal: 50, annualAfterDiscount: 600, services: [pestLine] },
  oneTime: { total: 0, items: [] }, results: {}, totals: { year2mo: 50, year1: 600 },
};
// The shapes below are what the mapper returns for a misting-only quote (checked against the
// real engine and mapper): serviceCount 0, the plan outside the WaveGuard count, the install
// in oneTime.items. The refill note rides in `detail`.
const RECURRING_BASE = { serviceCount: 0, tier: "Bronze", waveGuardTier: "Bronze", discount: 0, savings: 0, rodentBaitMo: 0, palmInjectionMo: 0 };
const planRow = (extra = {}) => ({
  service: "mosquito_misting", name: "Mosquito Misting Service Plan", mo: 59, monthly: 59, annual: 708, quoteRequired: false,
  requiresManualReview: false, manualReviewReasons: [],
  detail: "12 nozzles · 12 applications/yr · $59 per application · Standard (permethrin) refill $129 per refill application",
  ...extra,
});
const MISTING_PRICED = {
  recurring: { ...RECURRING_BASE, annualBeforeDiscount: 708, grandTotal: 59, monthlyTotal: 59, annualTotal: 708, annualAfterDiscount: 708, services: [planRow()] },
  oneTime: {
    total: 4595, otSubtotal: 4595, tmInstall: 0, membershipFee: 0, specItems: [],
    items: [{
      service: "mosquito_misting_installation", name: "Smart system (tankless + app) Installation", price: 4595,
      detail: "12 nozzles · 0 risers · Standard (permethrin) refill $129 per refill application",
    }],
  },
  results: {}, totals: { year1: 5303, year2: 708, year2mo: 59 },
};
const MISTING_FALLBACK = {
  ...MISTING_PRICED,
  recurring: { ...MISTING_PRICED.recurring, services: [planRow({ requiresManualReview: true, manualReviewReasons: ["mosquito_misting_invalid_nozzles"] })] },
};
const MISTING_OVERSIZE = {
  recurring: {
    ...RECURRING_BASE, annualBeforeDiscount: 0, grandTotal: 0, monthlyTotal: 0, annualTotal: 0, annualAfterDiscount: 0,
    services: [planRow({
      mo: 0, monthly: 0, annual: null, quoteRequired: true, requiresManualReview: true, manualReviewReasons: ["mosquito_misting_oversize"],
      detail: "90 nozzles · 0 risers · manual quote (above the standard layout)",
    })],
  },
  oneTime: { total: 0, otSubtotal: 0, tmInstall: 0, membershipFee: 0, items: [], specItems: [] },
  results: {}, totals: { year1: 0, year2: 0, year2mo: 0 },
};

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400, status, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let mistingRead;
let calculateResult;
let editSource;
beforeEach(() => {
  editSource = null;
  localStorage.setItem("waves_admin_token", "qa-token");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  mistingRead = structuredClone(MISTING_READ);
  calculateResult = RESULT;
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.includes("/admin/pricing-config/mosquito_misting_pricing")) {
      return Promise.resolve(jsonResponse(mistingRead === undefined ? {} : mistingRead));
    }
    if (path.endsWith("/edit-source")) return Promise.resolve(jsonResponse(structuredClone(editSource)));
    if (path.endsWith("/estimator/property-lookup")) {
      return Promise.resolve(jsonResponse({ enriched: { homeSqFt: 2000, lotSqFt: 9000, stories: 1 }, errors: [] }));
    }
    if (path.endsWith("/calculate-estimate")) return Promise.resolve(jsonResponse(structuredClone(calculateResult)));
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

function renderNew() {
  return render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
}

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

const toggle = () => screen.findByRole("checkbox", { name: "Mosquito Misting System" });
const typeInto = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("availability", () => {
  it("stays hidden while the gate is off, the block is missing or the read fails", async () => {
    for (const reply of [
      { featureAvailable: false, misting: { ...MISTING_READ.misting, enabled: false } },
      { featureAvailable: true },
      { misting: MISTING_READ.misting },
      undefined,
    ]) {
      mistingRead = reply;
      const { unmount } = renderNew();
      const before = fetchMock.mock.calls.filter(([url]) => String(url).includes("mosquito_misting_pricing")).length;
      await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("mosquito_misting_pricing")).length).toBeGreaterThan(before - 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByRole("checkbox", { name: "Mosquito Misting System" })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("shows the toggle, then inputs built from the server's labels and limits", async () => {
    renderNew();
    fireEvent.click(await toggle());
    expect(screen.getByLabelText("System")).toBeInTheDocument();
    expect([...screen.getByLabelText("System").querySelectorAll("option")].map((o) => o.textContent))
      .toEqual(["Default: Server Smart Tankless", "Server Essential Drum", "Server Smart Tankless"]);
    expect([...screen.getByLabelText("Refill solution").querySelectorAll("option")].map((o) => o.textContent))
      .toEqual(["Default: Server standard refill", "Server standard refill", "Server botanical refill", "Server premium refill"]);
    expect(screen.getByText("Whole number, 10-80. Blank uses the included count.")).toBeInTheDocument();
    expect(screen.getByLabelText("Refills per year")).toHaveValue(4);
  });
});

describe("what the calculate request carries", () => {
  it("is unchanged with the toggle off: no service, no option", async () => {
    renderNew();
    await toggle();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    const body = await generate();
    expect(body.selectedServices).not.toContain("MOSQUITO_MISTING");
    expect("mosquitoMisting" in body.options).toBe(false);
  });

  it("is unchanged when the gate is off, even for a form that carries the toggle", async () => {
    mistingRead = { featureAvailable: false };
    renderNew();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    const body = await generate();
    expect(body.selectedServices).toEqual(["PEST"]);
    expect(JSON.stringify(body)).not.toMatch(/misting/i);
  });

  it("keeps a reopened estimate's misting system when the gate is off, and still posts it so the server refuses it", async () => {
    // Pre-push P1: before this, a regenerate under a down gate (or a failed availability read)
    // silently dropped MOSQUITO_MISTING and its options, so a mixed estimate saved without
    // its plan and install. Now the toggle stays, a notice says why, and the request carries it.
    mistingRead = { featureAvailable: false };
    editSource = {
      id: "qa-misting-estimate", status: "draft", editable: true, editVersion: "qa-version",
      customerName: "QA Contact", address: ADDRESS, result: RESULT,
      inputs: { svcPest: true, svcMisting: true, mistingTier: "smart", mistingNozzles: "24", mistingRefillsPerYear: "4", homeSqFt: "2000", lotSqFt: "9000", stories: "1" },
      engineRequest: { profile: {}, selectedServices: ["PEST", "MOSQUITO_MISTING"], options: { mosquitoMisting: { tier: "smart", nozzles: "24", refillsPerYear: "4" } } },
    };
    render(<MemoryRouter><EstimateToolViewV2 editEstimateId="qa-misting-estimate" /></MemoryRouter>);
    expect(await toggle()).toBeChecked();
    expect(screen.getByTestId("misting-unavailable")).toHaveTextContent("not enabled on this server");
    expect(screen.getByLabelText("Nozzles")).toHaveValue(24);
    const body = await generate();
    expect(body.selectedServices).toEqual(["PEST", "MOSQUITO_MISTING"]);
    expect(body.options.mosquitoMisting).toEqual({ tier: "smart", nozzles: "24", refillsPerYear: "4" });
    // Unticking it removes it from the request, as the notice says.
    fireEvent.click(await toggle());
    const after = await generate();
    expect(after.selectedServices).toEqual(["PEST"]);
    expect("mosquitoMisting" in after.options).toBe(false);
  });

  it("sends the typed layout unrounded, drops blanks and keeps the refill count", async () => {
    renderNew();
    fireEvent.click(await toggle());
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    typeInto("System", "essential");
    typeInto("Nozzles", "12.5");
    typeInto("Refill solution", "premium");
    const body = await generate();
    expect(body.selectedServices).toEqual(["PEST", "MOSQUITO_MISTING"]);
    expect(body.options.mosquitoMisting).toEqual({ tier: "essential", nozzles: "12.5", solution: "premium", refillsPerYear: "4" });
  });

  it("sends every field when all are filled", async () => {
    renderNew();
    fireEvent.click(await toggle());
    await lookUp();
    typeInto("System", "smart");
    typeInto("Nozzles", "24");
    typeInto("Risers", "3");
    typeInto("Refill solution", "natural");
    typeInto("Refills per year", "6");
    const body = await generate();
    expect(body.selectedServices).toEqual(["MOSQUITO_MISTING"]);
    expect(body.options.mosquitoMisting).toEqual({ tier: "smart", nozzles: "24", risers: "3", solution: "natural", refillsPerYear: "6" });
  });

  it("generates a misting-only quote with no home or lot size: the price comes from the layout, not the footprint", async () => {
    renderNew();
    fireEvent.click(await toggle());
    typeInto("Nozzles", "30");
    const body = await generate();
    expect(window.alert).not.toHaveBeenCalledWith("Enter home sq ft or lot size.");
    expect(body.selectedServices).toEqual(["MOSQUITO_MISTING"]);
    expect(body.options.mosquitoMisting).toEqual({ nozzles: "30", refillsPerYear: "4" });
  });

  it("counts a misting-only estimate as a selected recurring service", async () => {
    renderNew();
    expect(screen.getByText("Select at least one service to see pricing")).toBeInTheDocument();
    fireEvent.click(await toggle());
    expect(screen.getByText(/1 recurring\/manual \+ 0 one-time selected/)).toBeInTheDocument();
  });
});

describe("what the result shows", () => {
  async function generateMisting(result) {
    calculateResult = result;
    renderNew();
    fireEvent.click(await toggle());
    await lookUp();
    await generate();
    return screen.findByTestId("misting-plan");
  }

  it("lists the plan, the install with its tier label, and the per-refill note", async () => {
    const plan = await generateMisting(MISTING_PRICED);
    expect(plan).toHaveTextContent("Mosquito Misting Service Plan");
    expect(plan).toHaveTextContent("$59 per application");
    expect(plan).toHaveTextContent("per refill application");
    expect(plan).toHaveTextContent("$59.00/mo");
    expect(screen.getByText("Smart system (tankless + app) Installation")).toBeInTheDocument();
    // The install is not a membership fee.
    expect(screen.getByText("One-Time (misting install)")).toBeInTheDocument();
    expect(screen.queryByText("Recurring Membership")).not.toBeInTheDocument();
  });

  it("keeps the line price override closed until opened, then sends the typed amount on regenerate", async () => {
    await generateMisting(MISTING_PRICED);
    // One button on a regular estimate, not a second copy of every line.
    expect(screen.queryByLabelText("Override ($)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Override a line price" }));
    fireEvent.change(screen.getByLabelText("Override ($)"), { target: { value: "5200" } });
    fireEvent.change(screen.getByLabelText("Reason (internal)"), { target: { value: "longer run" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply overrides & regenerate" }));
    await waitFor(() => expect(calculateBodies()).toHaveLength(2));
    expect(calculateBodies()[1].options.linePriceOverrides).toEqual({
      mosquito_misting_installation: { price: 5200, reason: "longer run" },
    });
  });

  it("refuses an invalid override amount in place, keeping the estimate and sending nothing", async () => {
    await generateMisting(MISTING_PRICED);
    fireEvent.click(screen.getByRole("button", { name: "Override a line price" }));
    fireEvent.change(screen.getByLabelText("Override ($)"), { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply overrides & regenerate" }));
    expect(screen.getByText(/must be a positive dollar amount/)).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("misting-plan")).toBeInTheDocument();
    expect(calculateBodies()).toHaveLength(1);
  });

  it("names the reason when the plan priced on a fallback, so the rep corrects the input", async () => {
    const plan = await generateMisting(MISTING_FALLBACK);
    expect(plan).toHaveTextContent("The nozzle count must be a whole number in range");
    expect(plan).not.toHaveTextContent("mosquito_misting_invalid_nozzles");
  });

  it("shows an oversize layout as a manual quote with the reason in words", async () => {
    const plan = await generateMisting(MISTING_OVERSIZE);
    expect(plan).toHaveTextContent("Quote Required");
    expect(plan).toHaveTextContent("more nozzles than our standard system");
    expect(plan).not.toHaveTextContent("mosquito_misting_oversize");
    expect(screen.getByText("This scope requires a quote review before a firm price can be sent.")).toBeInTheDocument();
  });

  it("never shows an oversize system as free beside another service: the bundle row reads Quote Required", async () => {
    calculateResult = {
      ...MISTING_OVERSIZE,
      recurring: {
        ...MISTING_OVERSIZE.recurring, serviceCount: 1, grandTotal: 50, monthlyTotal: 50, annualBeforeDiscount: 600,
        services: [{ service: "pest_control", name: "Pest Control", mo: 50, annual: 600 }, ...MISTING_OVERSIZE.recurring.services],
      },
    };
    renderNew();
    fireEvent.click(await toggle());
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    typeInto("Nozzles", "90");
    await generate();
    await screen.findByText("1 recurring service —", { exact: false });
    expect(screen.queryByTestId("misting-plan")).not.toBeInTheDocument();
    expect(screen.getByText("Quote Required")).toBeInTheDocument();
    expect(screen.queryByText("$0.00/mo")).not.toBeInTheDocument();
    expect(screen.getByText("more nozzles than our standard system", { exact: false })).toBeInTheDocument();
  });

  it("lists the plan once, in the bundle card, when another service is on the estimate", async () => {
    calculateResult = {
      ...MISTING_PRICED,
      recurring: {
        ...MISTING_PRICED.recurring, serviceCount: 1, grandTotal: 109, monthlyTotal: 109,
        services: [{ service: "pest_control", name: "Pest Control", mo: 50, annual: 600 }, planRow()],
      },
    };
    renderNew();
    fireEvent.click(await toggle());
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    await generate();
    await screen.findByText("1 recurring service —", { exact: false });
    expect(screen.queryByTestId("misting-plan")).not.toBeInTheDocument();
    expect(screen.getAllByText("Mosquito Misting Service Plan")).toHaveLength(1);
  });
});
