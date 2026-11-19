// @vitest-environment jsdom
//
// Plan and Protocol merge: a lawn visit's Protocol panel gets a Plan tab right after the Job tab,
// and the "Use" ticks on "if needed" products reach the job card and the plan as one list.
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ProtocolPanel } from "./SchedulePage";

vi.mock("../../hooks/useFeatureFlag", () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const service = { id: "visit-plan-a", customerId: "customer-plan-a", serviceType: "Lawn Care", customerName: "Fixture account", lawnType: "St. Augustine", lawnSqft: 10000 };
const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });

const bermudaLine = (id, name, selected) => ({ raw: name, conditional: true, bermudaStep: true, selected, matched: true, product: { id, name } });
let ticked = [];
const planFor = () => {
  const on = (id) => ticked.includes(id);
  return {
    status: "approved",
    propertyGate: { trackName: "Fixture track", month: "Jul", visit: 7, blocks: [] },
    protocol: {
      objective: "Fixture objective",
      base: [],
      conditional: [
        { raw: "Fixture optional line", conditional: true, matched: true, selected: on("opt"), product: { id: "opt", name: "Fixture optional" } },
        bermudaLine("rec", "Fixture Recognition", on("rec")), bermudaLine("fus", "Fixture Fusilade", on("fus")), bermudaLine("nis", "Fixture surfactant", on("nis")),
      ],
    },
    mixCalculator: { carrierGalPer1000: 2, items: [] },
    mixingOrder: [{ step: 1, productId: "pot", productName: "Fixture potassium", instruction: "Add the potassium first." }],
    bermudaMixingOrder: [{ step: 1, productId: null, productName: "Water", instruction: "Half fill the backpack." }],
    closeout: { requiredPhotos: ["Before"] },
  };
};
const card = (blocked) => ({
  enabled: true, serviceId: service.id, strip: { name: "Fixture account", program: "Lawn Care" }, addons: [],
  planBlocks: blocked ? [{ code: "nitrogen_blackout", message: "Fixture blackout." }] : [],
  sprayCheck: { window: "not_today" }, tank: { calibrated: true, rigs: [] },
  products: [
    { id: "opt", name: "Fixture optional", role: "conditional", conditional: !ticked.includes("opt"), verdict: "ok", planned: ticked.includes("opt") ? { amount: 4, unit: "oz" } : null, line: "Fixture optional line" },
    { id: "base", name: "Fixture base", role: "base", conditional: false, verdict: "ok", planned: { amount: 2, unit: "oz" }, line: "Fixture base line" },
    { id: "rec", name: "Fixture Recognition", role: "conditional", conditional: !ticked.includes("rec"), verdict: "ok", planned: null, line: "x" },
  ],
});
let blocked = false;

function fixture(url) {
  const path = new URL(url, "http://localhost").pathname;
  if (path.endsWith("/intelligence-bar/quick-actions")) return { actions: [] };
  if (path.includes("/protocols/job-card/")) return card(blocked);
  if (path.includes("/treatment-plans/")) return { plan: planFor() };
  if (path.endsWith("/pay-growth/availability")) return { available: false };
  if (path.endsWith("/turf-profile")) return { profile: { track_key: "A_St_Aug_Sun", lawn_sqft: 10000 } };
  if (path.endsWith("/photos/relevant")) return { photos: [] };
  if (path.endsWith("/seasonal-index")) return { pests: [] };
  if (path.endsWith("/scripts")) return { scripts: [] };
  if (path.endsWith("/equipment")) return { checklists: [] };
  if (path.endsWith("/programs")) return { track: { name: "Fixture program", notes: [], visits: [] } };
  if (path.endsWith("/lawn-mix")) return { month: "Jul", visit: { visit: 7 }, areaSqft: 10000, equipment: null, items: [] };
  throw new Error(`Unexpected request: ${path}`);
}
const asked = (match) => fetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(match));
const ids = (url) => new URL(url, "http://x").searchParams.get("selectedConditionalProductIds");

beforeEach(() => {
  ticked = [];
  blocked = false;
  vi.stubGlobal("fetch", vi.fn((url) => reply(fixture(url))));
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = async (props = {}, svc = service) => {
  await act(async () => { render(<MemoryRouter><ProtocolPanel service={svc} onClose={() => {}} {...props} /></MemoryRouter>); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Job" })).toBeInTheDocument());
};

describe("ProtocolPanel Plan tab", () => {
  it("puts the Plan tab right after the Job tab on a lawn visit, and not on a pest visit", async () => {
    await mount();
    const labels = screen.getAllByRole("button").map((b) => b.textContent).filter((t) => ["Job", "Plan", "Protocol", "Overview"].includes(t));
    expect(labels.slice(0, 2)).toEqual(["Job", "Plan"]);
    cleanup();
    await mount({}, { ...service, id: "visit-pest", serviceType: "Pest Control" });
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(asked("/treatment-plans/").every((u) => !u.includes("visit-pest"))).toBe(true);
  });

  it("opens on the Plan tab when asked, and shows the plan without a tick or an amount", async () => {
    await mount({ initialSection: "lawn_plan" });
    expect(await screen.findByText("Fixture track")).toBeInTheDocument();
    expect(screen.getByText("Fixture optional")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Use /)).toBeNull();
  });

  it("a Use tick on an if-needed product reads the job card and the plan again with that id", async () => {
    await mount();
    const use = await screen.findByLabelText("Use Fixture optional");
    expect(use).not.toBeChecked();
    // A product that is already planned has no tick.
    expect(screen.queryByLabelText("Use Fixture base")).toBeNull();
    ticked = ["opt"];
    await act(async () => { fireEvent.click(use); });
    await waitFor(() => expect(ids(asked("/job-card/").at(-1))).toBe("opt"));
    expect(ids(asked("/treatment-plans/").at(-1))).toBe("opt");
    // The ticked product stays on the card, checked, so it can be taken off again.
    expect(await screen.findByLabelText("Use Fixture optional")).toBeChecked();
    ticked = [];
    await act(async () => { fireEvent.click(screen.getByLabelText("Use Fixture optional")); });
    await waitFor(() => expect(asked("/job-card/").at(-1)).not.toContain("selectedConditionalProductIds"));
  });

  it("a tick on a bermuda step product selects all three step lines, and the card keeps the three checked", async () => {
    await mount();
    await screen.findByLabelText("Use Fixture Recognition");
    ticked = ["rec", "fus", "nis"];
    await act(async () => { fireEvent.click(screen.getByLabelText("Use Fixture Recognition")); });
    await waitFor(() => expect(ids(asked("/job-card/").at(-1))?.split(",").sort()).toEqual(["fus", "nis", "rec"]));
  });

  it("shows the plan's mixing order and the bermuda backpack mix on the Job tab", async () => {
    await mount();
    await screen.findByText("Mixing order");
    expect(screen.getByText("Bermuda backpack mix")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Mixing order"));
    expect(screen.getByText("Fixture potassium")).toBeInTheDocument();
    expect(screen.getByText("Add the potassium first.")).toBeInTheDocument();
  });

  it("the blocked-plan box on the Job tab opens the Plan tab", async () => {
    blocked = true;
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "See Plan tab" }));
    expect(await screen.findByText("Fixture track")).toBeInTheDocument();
  });
});
