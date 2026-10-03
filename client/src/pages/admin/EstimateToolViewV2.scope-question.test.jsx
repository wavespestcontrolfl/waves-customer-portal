// @vitest-environment jsdom
/**
 * Business-identity scope question in the admin estimate tool
 * (GATE_LOOKUP_BUSINESS_IDENTITY). A lookup that found a business but cannot
 * tell "just their space" from "the whole building" (serviceScopeDecision
 * scope_unresolved) shows the question with two answers; until one is given
 * Generate / Save / Review and send are disabled with the question as the
 * reason. Answering re-runs the lookup with `occupancy`, and the answered
 * profile rides the calculate and save payloads. A server 409
 * COMMERCIAL_SCOPE_UNRESOLVED raises the same prompt. Synthetic fixtures only.
 */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = "100 Example Plaza Dr, Examplecity, FL 00000";
const QUESTION = "Are we treating just your space or the whole building?";

const identity = { name: "Example Nail Bar", type: "salon_spa", matchedBy: "street_number", tenantsAtNumber: 1 };

function unresolvedProfile() {
  return {
    homeSqFt: 0,
    lotSqFt: 0,
    stories: 1,
    storiesSource: "default",
    propertyType: "Commercial",
    category: "COMMERCIAL",
    isCommercial: true,
    commercialSubtype: "salon_spa",
    commercialDetectionSource: "google_places_business",
    unitScopedLookup: true,
    serviceScopeDecision: "scope_unresolved",
    serviceScopeQuestion: QUESTION,
    occupancyAnswer: null,
    businessIdentity: identity,
    fieldVerifyFlags: [],
    fieldEvidence: {},
    propertyDataQuality: { score: 100, missingCriticalFields: [] },
  };
}

function answeredProfile(answer) {
  return {
    ...unresolvedProfile(),
    homeSqFt: answer === "suite" ? 1200 : 9000,
    serviceScopeDecision: answer === "suite" ? "commercial_suite" : "entire_commercial_building",
    serviceScopeQuestion: null,
    occupancyAnswer: answer,
    ...(answer === "suite" ? { suiteSize: { value: 1200, source: "suite_type_default", confidence: "low" } } : {}),
  };
}

function calcResult(homeSqFt) {
  return {
    recurring: {
      tier: null, grandTotal: 90, annualAfterDiscount: 1080,
      services: [{ service: "commercial_pest", name: "Commercial Pest Control", mo: 90, annual: 1080, footprintUsed: homeSqFt, commercialPricingMode: "auto_estimate", pricingConfidence: "LOW" }],
    },
    oneTime: { total: 0, items: [] },
    results: {},
    totals: { year2mo: 90, year1: 1080 },
    property: { homeSqFt, lotSqFt: 0, stories: 1, footprint: homeSqFt, propertyType: "commercial" },
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300, status, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let lookupReply;
let calcReply;
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "qa-token");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  lookupReply = (body) => (body.occupancy ? answeredProfile(body.occupancy) : unresolvedProfile());
  calcReply = () => jsonResponse(calcResult(1200));
  fetchMock = vi.fn((url, init) => {
    const path = String(url);
    if (path.endsWith("/estimator/property-lookup")) {
      const body = JSON.parse(init.body);
      return Promise.resolve(jsonResponse({ enriched: structuredClone(lookupReply(body)), errors: [] }));
    }
    if (path.endsWith("/calculate-estimate")) return Promise.resolve(calcReply());
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

const lookupBodies = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith("/estimator/property-lookup"))
  .map(([, init]) => JSON.parse(init.body));
const calcBodies = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith("/calculate-estimate"))
  .map(([, init]) => JSON.parse(init.body));

async function lookUp() {
  render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
  await screen.findByRole("region", { name: "Property lookup results" });
}

function pickPest() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
}

describe("scope question", { timeout: 20000 }, () => {
  it("unresolved: the identified business, the question and both answers show; Generate is disabled with the question as its reason", async () => {
    await lookUp();
    const prompt = screen.getByRole("region", { name: "Scope question" });
    expect(prompt).toHaveTextContent("Example Nail Bar, a salon or spa, is listed at this address.");
    // The Places result carries its required source attribution.
    expect(within(prompt).getByText("Google Maps", { exact: true })).toBeInTheDocument();
    expect(prompt).toHaveTextContent(QUESTION);
    expect(screen.getByRole("button", { name: "Just their space" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "The whole building" })).toBeEnabled();
    pickPest();
    const generate = screen.getByRole("button", { name: "Generate Estimate", exact: true });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAttribute("title", QUESTION);
    fireEvent.click(generate);
    expect(calcBodies()).toHaveLength(0);
    // The first lookup carried no answer.
    expect(lookupBodies()[0]).not.toHaveProperty("occupancy");
  });

  it("answering 'Just their space' re-runs the lookup with occupancy, enables Generate, and the answered profile is in the calculate payload", async () => {
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Just their space" }));
    await waitFor(() => expect(lookupBodies()).toHaveLength(2));
    expect(lookupBodies()[1]).toMatchObject({ address: ADDRESS, occupancy: "suite" });
    await waitFor(() => expect(screen.queryByText(QUESTION)).not.toBeInTheDocument());
    pickPest();
    const generate = screen.getByRole("button", { name: "Generate Estimate", exact: true });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    await waitFor(() => expect(calcBodies()).toHaveLength(1));
    expect(calcBodies()[0].profile).toMatchObject({ serviceScopeDecision: "commercial_suite", occupancyAnswer: "suite" });
    // The listed name stays on the screen: it is not sent on to pricing (or saved).
    expect(calcBodies()[0].profile.businessIdentity).toMatchObject({ name: null, type: "salon_spa" });
    expect(JSON.stringify(calcBodies()[0])).not.toContain("Example Nail Bar");
    // Still shows why, and which answer stands.
    expect(screen.getByRole("button", { name: "Just their space" })).toHaveAttribute("aria-pressed", "true");
  });

  it("answering 'The whole building' re-runs with occupancy building and the answer rides the save payload", async () => {
    calcReply = () => jsonResponse(calcResult(9000));
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "The whole building" }));
    await waitFor(() => expect(lookupBodies()).toHaveLength(2));
    expect(lookupBodies()[1].occupancy).toBe("building");
    pickPest();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate Estimate", exact: true })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate Estimate", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/admin/estimates") && init?.method === "POST")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url, i]) => String(url).endsWith("/api/admin/estimates") && i?.method === "POST");
    const saved = JSON.parse(init.body).estimateData;
    expect(saved.engineRequest.profile).toMatchObject({ serviceScopeDecision: "entire_commercial_building", occupancyAnswer: "building" });
  });

  it("a later lookup of the same address keeps the answer (Refresh does not re-ask)", async () => {
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Just their space" }));
    await waitFor(() => expect(lookupBodies()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
    await waitFor(() => expect(lookupBodies()).toHaveLength(3));
    expect(lookupBodies()[2].occupancy).toBe("suite");
  });

  it("a scope the lookup decided by itself still shows both buttons, and staff can change a suite to the whole building", async () => {
    // Several tenants at the number: the server answers commercial_suite with no question.
    lookupReply = (body) => (body.occupancy
      ? answeredProfile(body.occupancy)
      : { ...answeredProfile("suite"), occupancyAnswer: null });
    await lookUp();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Just their space" })).toHaveAttribute("aria-pressed", "true");
    const building = screen.getByRole("button", { name: "The whole building" });
    expect(building).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(building);
    await waitFor(() => expect(lookupBodies()).toHaveLength(2));
    expect(lookupBodies()[1]).toMatchObject({ address: ADDRESS, occupancy: "building" });
    await waitFor(() => expect(screen.getByRole("button", { name: "The whole building" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("changing a decided scope blocks pricing until the lookup for the new answer succeeds: in flight, and after it fails", async () => {
    let failAnswered = true;
    lookupReply = (body) => (body.occupancy ? answeredProfile(body.occupancy) : { ...answeredProfile("suite"), occupancyAnswer: null });
    const baseFetch = fetchMock.getMockImplementation();
    let release;
    fetchMock.mockImplementation((url, init) => {
      if (String(url).endsWith("/estimator/property-lookup") && JSON.parse(init.body).occupancy && failAnswered) {
        return new Promise((resolve) => { release = () => resolve(jsonResponse({ error: "lookup failed" }, { status: 500 })); });
      }
      return baseFetch(url, init);
    });
    await lookUp();
    pickPest();
    const generate = () => screen.getByRole("button", { name: "Generate Estimate", exact: true });
    expect(generate()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "The whole building" }));
    await waitFor(() => expect(lookupBodies()).toHaveLength(2));
    // In flight: the suite-sized profile is still on screen, so no pricing.
    expect(generate()).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "The whole building" })).toBeEnabled());
    // Failed: still blocked, and neither answer reads as applied.
    expect(generate()).toBeDisabled();
    expect(screen.getByRole("button", { name: "The whole building" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(generate());
    expect(calcBodies()).toHaveLength(0);
    // Answering again succeeds and unblocks.
    failAnswered = false;
    fireEvent.click(screen.getByRole("button", { name: "The whole building" }));
    await waitFor(() => expect(generate()).toBeEnabled());
    expect(screen.getByRole("button", { name: "The whole building" })).toHaveAttribute("aria-pressed", "true");
  });

  it("when the answered lookup comes back still unresolved (the business could not be re-checked), the question stays, no answer reads as chosen, and Generate stays disabled", async () => {
    lookupReply = (body) => (body.occupancy
      ? { ...unresolvedProfile(), businessIdentity: undefined }
      : unresolvedProfile());
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Just their space" }));
    await waitFor(() => expect(lookupBodies()).toHaveLength(2));
    await screen.findByRole("region", { name: "Property lookup results" });
    expect(await screen.findByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Just their space" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "The whole building" })).toHaveAttribute("aria-pressed", "false");
    pickPest();
    expect(screen.getByRole("button", { name: "Generate Estimate", exact: true })).toBeDisabled();
  });

  it("Clear All forgets the answer: the same address typed again is asked again", async () => {
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Just their space" }));
    await waitFor(() => expect(lookupBodies()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    fireEvent.change(screen.getByLabelText("Service address"), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
    await waitFor(() => expect(lookupBodies()).toHaveLength(3));
    expect(lookupBodies()[2]).not.toHaveProperty("occupancy");
    expect(await screen.findByText(QUESTION)).toBeInTheDocument();
  });

  it("a server 409 COMMERCIAL_SCOPE_UNRESOLVED shows the same prompt and blocks the buttons", async () => {
    // The client believed the scope was settled (no business on the profile).
    lookupReply = () => ({ ...answeredProfile("suite"), businessIdentity: undefined, serviceScopeDecision: undefined, occupancyAnswer: undefined });
    calcReply = () => jsonResponse(
      { error: `${QUESTION} Answer it in Property Lookup before pricing this address.`, code: "COMMERCIAL_SCOPE_UNRESOLVED", metadata: { question: QUESTION } },
      { status: 409 },
    );
    await lookUp();
    expect(screen.queryByRole("region", { name: "Scope question" })).not.toBeInTheDocument();
    pickPest();
    fireEvent.click(screen.getByRole("button", { name: "Generate Estimate", exact: true }));
    const prompt = await screen.findByRole("region", { name: "Scope question" });
    expect(prompt).toHaveTextContent(QUESTION);
    expect(window.alert).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Generate Estimate", exact: true })).toBeDisabled();
  });

  it("a lookup with no business verdict (gate off) shows no prompt and leaves Generate enabled", async () => {
    lookupReply = () => ({ ...answeredProfile("suite"), businessIdentity: undefined, serviceScopeDecision: undefined, occupancyAnswer: undefined });
    await lookUp();
    expect(screen.queryByRole("region", { name: "Scope question" })).not.toBeInTheDocument();
    pickPest();
    expect(screen.getByRole("button", { name: "Generate Estimate", exact: true })).toBeEnabled();
    expect(lookupBodies()[0]).not.toHaveProperty("occupancy");
  });
});
