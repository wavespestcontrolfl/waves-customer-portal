// @vitest-environment jsdom
// Owner 2026-10-30, option B (GATE_WAVEGUARD_EXTEND_PICK): when a quote moves
// a linked member up a WaveGuard tier, the Pricing summary lists their current
// services at the new tier price with tick boxes, and the save sends only the
// ticked ones. The tier discount itself shows in the summary, not only inside
// the collapsed engine details (the owner could not see the mosquito discount).
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2, { nextFormForTierExtension } from "./EstimateToolViewV2";

vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const OFFER = {
  fromTierLabel: "Silver",
  tierLabel: "Gold",
  tierDiscountPct: 15,
  services: [
    { key: "lawn_care", label: "Lawn Care", currentPerVisit: 70.8, newPerVisit: 66.87, perVisitSavings: 3.93, remainingVisits: 6, prepaid: false, marginPct: 1.3 },
    { key: "pest_control", label: "Pest Control", currentPerVisit: 103.75, newPerVisit: 97.99, perVisitSavings: 5.76, remainingVisits: 5, prepaid: false, marginPct: null },
  ],
};
const result = {
  recurring: {
    tier: "Gold", waveGuardTier: "Gold", discount: 0.15, savings: 187.2, grandTotal: 88.4, monthlyTotal: 88.4,
    annualAfterDiscount: 1060.8, annualBeforeDiscount: 1248, serviceCount: 3,
    services: [{ service: "mosquito", name: "Mosquito", mo: 104, monthly: 104, annual: 1248 }],
  },
  oneTime: { total: 0, items: [] },
  results: {},
  totals: { year1: 1060.8, year2mo: 88.4 },
};
const request = { profile: { homeSqFt: 2000, lotSqFt: 6000 }, selectedServices: ["MOSQUITO"], options: { mosquitoProgram: "monthly12" } };
const source = {
  id: "qa-draft", status: "draft", editable: true, editVersion: "v1",
  customerId: "qa-cust",
  customer: { id: "qa-cust", firstName: "QA", lastName: "Member", phone: null, email: null, tier: "Silver", monthlyRate: 0, hasActivePlan: true },
  customerName: "QA Member", customerPhone: "+19415550100", customerEmail: "qa@example.invalid",
  address: "100 Example Court", propertyId: "qa-property",
  inputs: { svcMosquito: true, mosquitoProgram: "monthly12", homeSqFt: "2000", lotSqFt: "6000" },
  engineRequest: request, result, token: "synthetic-preview-token",
};
const response = (data, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data, clone() { return this; }, text: async () => JSON.stringify(data) });

let currentSource;
let writes;
let calculated;
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "fixture");
  writes = [];
  currentSource = structuredClone(source);
  calculated = { ...structuredClone(result), currentServiceTierOffer: structuredClone(OFFER) };
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn((url, opts = {}) => {
    if (String(url).endsWith("/edit-source")) return response(currentSource);
    if (opts.method === "PUT") {
      const body = JSON.parse(opts.body);
      writes.push(body);
      return response({ id: source.id, status: "draft", editVersion: "v2", token: source.token });
    }
    if (String(url).endsWith("/calculate-estimate")) return response(structuredClone(calculated));
    if (String(url).includes("/discounts")) return response([]);
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const renderEditor = () => render(<MemoryRouter><EstimateToolViewV2 editEstimateId={source.id} /></MemoryRouter>);
const committed = () => writes.filter((body) => !body.dryRun);

describe("nextFormForTierExtension", () => {
  const estimate = { currentServiceTierOffer: OFFER };
  const pestOnly = { currentServiceTierOffer: { ...OFFER, services: OFFER.services.filter((svc) => svc.key === "pest_control") } };
  it("ticks every offered service on a first result", () => {
    expect(nextFormForTierExtension({}, estimate, "c1").tierExtensionPick)
      .toEqual({ customerId: "c1", offered: ["lawn_care", "pest_control"], unticked: [] });
  });
  it("keeps an untick through a regenerate, a result without the list, and a list that briefly leaves the service out", () => {
    const form = { tierExtensionPick: { customerId: "c1", offered: ["lawn_care", "pest_control"], unticked: ["lawn_care"] } };
    expect(nextFormForTierExtension(form, estimate, "c1").tierExtensionPick.unticked).toEqual(["lawn_care"]);
    // A failed lookup returns no list: the same customer's choices stay.
    expect(nextFormForTierExtension(form, {}, "c1")).toBe(form);
    // Lawn drops off the list for one regenerate, then comes back: still unticked.
    const partial = nextFormForTierExtension(form, pestOnly, "c1");
    expect(partial.tierExtensionPick).toEqual({ customerId: "c1", offered: ["pest_control"], unticked: ["lawn_care"] });
    expect(nextFormForTierExtension(partial, estimate, "c1").tierExtensionPick.unticked).toEqual(["lawn_care"]);
  });
  it("never carries one customer's unticks to another", () => {
    const form = { tierExtensionPick: { customerId: "c1", offered: ["lawn_care"], unticked: ["lawn_care"] }, notes: "x" };
    expect(nextFormForTierExtension(form, estimate, "c2").tierExtensionPick.unticked).toEqual([]);
    expect(nextFormForTierExtension(form, {}, "c2")).toEqual({ tierExtensionPick: null, notes: "x" });
    expect(nextFormForTierExtension(form, {}, null)).toEqual({ tierExtensionPick: null, notes: "x" });
    const plain = { notes: "x" };
    expect(nextFormForTierExtension(plain, {}, "c1")).toBe(plain);
  });
});

describe("current services at the new tier in the Pricing summary", () => {
  it("shows the tier discount and the tick list after Generate, and saves only the ticked services", async () => {
    renderEditor();
    await screen.findByDisplayValue("QA Member");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate", exact: true }));
    const lawn = await screen.findByRole("checkbox", { name: /Lawn Care: \$70\.80 → \$66\.87 \/ application · est\. margin 1\.3%/ });
    const pest = screen.getByRole("checkbox", { name: /^Pest Control: \$103\.75 → \$97\.99 \/ application$/ });
    expect(lawn).toBeChecked();
    expect(pest).toBeChecked();
    expect(screen.getByText(/Also give Gold to current services/)).toBeVisible();
    // The discount is in the visible summary, not only the collapsed details.
    expect(screen.getByText(/WaveGuard Gold discount: 15% off, saving/)).toBeVisible();

    fireEvent.click(lawn);
    fireEvent.click(screen.getByRole("button", { name: "Save draft", exact: true }));
    await waitFor(() => expect(committed()).toHaveLength(1));
    expect(committed()[0].tierExtensionKeys).toEqual(["pest_control"]);
    expect(committed()[0].tierExtensionKeptKeys).toEqual(["lawn_care"]);
    expect(committed()[0].estimateData.inputs.tierExtensionPick).toEqual({
      customerId: "qa-cust", offered: ["lawn_care", "pest_control"], unticked: ["lawn_care"],
    });
  });

  it("changing a tick after a save clears the saved state, so Send cannot go out with the old choice", async () => {
    renderEditor();
    await screen.findByDisplayValue("QA Member");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate", exact: true }));
    const lawn = await screen.findByRole("checkbox", { name: /^Lawn Care:/ });
    fireEvent.click(screen.getByRole("button", { name: "Save draft", exact: true }));
    await screen.findByText(/Draft saved/);
    expect(screen.getByRole("button", { name: "Review and send", exact: true })).toBeEnabled();
    fireEvent.click(lawn);
    await waitFor(() => expect(screen.queryByText(/Draft saved/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Review and send", exact: true })).toBeDisabled();
  });

  it("a reopened draft saves the same choice without a regenerate", async () => {
    currentSource = {
      ...structuredClone(source),
      inputs: { ...source.inputs, tierExtensionPick: { customerId: "qa-cust", offered: ["lawn_care", "pest_control"], unticked: ["lawn_care"] } },
    };
    renderEditor();
    await screen.findByDisplayValue("QA Member");
    fireEvent.click(screen.getByRole("button", { name: "Save draft", exact: true }));
    await waitFor(() => expect(committed()).toHaveLength(1));
    expect(committed()[0].tierExtensionKeys).toEqual(["pest_control"]);
    expect(committed()[0].tierExtensionKeptKeys).toEqual(["lawn_care"]);
  });

  it("a quote with no list shows no tick boxes and sends no pick", async () => {
    calculated = structuredClone(result);
    renderEditor();
    await screen.findByDisplayValue("QA Member");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate", exact: true }));
    await screen.findByText(/WaveGuard Gold discount: 15% off, saving/);
    expect(screen.queryByText(/Also give Gold to current services/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save draft", exact: true }));
    await waitFor(() => expect(committed()).toHaveLength(1));
    expect(committed()[0]).not.toHaveProperty("tierExtensionKeys");
    expect(committed()[0]).not.toHaveProperty("tierExtensionKeptKeys");
  });
});
