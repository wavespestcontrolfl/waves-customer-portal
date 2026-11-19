// @vitest-environment jsdom
//
// Plan and Protocol merge: a lawn visit's Protocol panel gets a Plan tab right after the Job tab, and the
// "Use" ticks on the primary lawn plan's "if needed" products reach the job card, the Tank search and the
// plan as one list. While a tick is re-read the Job tab shows no amount from the old selection.
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
const STEP_IDS = ["rec", "fus", "nis"];

let blocked = false;
let serverIgnores = [];
let hold = null;
const idsOf = (url) => (new URL(url, "http://x").searchParams.get("selectedConditionalProductIds") || "").split(",").filter(Boolean);

// The server's resolved selection for a read: the ids asked for, less any it refuses; a bermuda step is all or none.
const selectedFor = (url) => {
  const asked = idsOf(url).filter((id) => !serverIgnores.includes(id));
  return asked.some((id) => STEP_IDS.includes(id)) ? [...new Set([...asked, ...STEP_IDS])] : asked;
};
const planFor = (url) => {
  const on = selectedFor(url);
  const line = (id, name, extra = {}) => ({ raw: name, conditional: true, matched: true, selected: on.includes(id), product: { id, name }, ...extra });
  return {
    status: "approved",
    propertyGate: { trackName: "Fixture track", month: "Jul", visit: 7, blocks: on.includes("opt") ? [{ code: "nitrogen_blackout", message: "Blackout after the tick." }] : [] },
    protocol: { objective: "Fixture objective", base: [], conditional: [line("opt", "Fixture optional"), ...STEP_IDS.map((id) => line(id, `Fixture ${id}`, { bermudaStep: true }))] },
    mixCalculator: { carrierGalPer1000: 2, items: [] },
    closeout: { requiredPhotos: ["Before"] },
  };
};
const cardFor = (url) => {
  const on = selectedFor(url);
  const optionCard = (id, name, extra = {}) => ({ id, name, role: "conditional", planOption: true, conditional: !on.includes(id), verdict: "ok", planned: on.includes(id) ? { amount: 4, unit: "fl oz" } : null, line: `${name} line`, ...extra });
  return {
    enabled: true, serviceId: service.id, strip: { name: "Fixture account", program: "Lawn Care" }, addons: [],
    planBlocks: blocked ? [{ code: "nitrogen_blackout", message: "Fixture blackout." }] : [],
    sprayCheck: { window: "not_today" }, tank: { calibrated: true, rigs: [] },
    mixingOrder: [{ step: 1, productId: "base", productName: "Fixture potassium", instruction: "Add the potassium first." }],
    bermudaMixingOrder: [{ step: 1, productId: null, productName: "Water", instruction: "Half fill the backpack." }, { step: 2, productId: "rec", productName: "Fixture rec", instruction: "Add rec." }],
    products: [
      optionCard("opt", "Fixture optional"),
      { id: "base", name: "Fixture base", role: "base", conditional: false, verdict: "ok", planned: { amount: 2, unit: "fl oz" }, line: "Fixture base line" },
      // A conditional line of a tree and shrub add-on: the server applies the ticks to the lawn plan only.
      { id: "tree", name: "Fixture tree add-on", role: "conditional", conditional: true, verdict: "ok", planned: null, line: "Tree line" },
      ...STEP_IDS.map((id) => optionCard(id, `Fixture ${id}`, { bermudaStep: true })),
    ],
  };
};

function fixture(url) {
  const path = new URL(url, "http://localhost").pathname;
  if (path.endsWith("/intelligence-bar/quick-actions")) return { actions: [] };
  if (path.endsWith("/job-card/products")) return { products: [{ id: "alpha", name: "Fixture alpha", category: "x" }] };
  if (path.endsWith("/job-card/mix")) return { enabled: true, amount: 1.5, unit: "oz", gallons: 110, sprayCheck: { verdict: "ok" }, rotationWarnings: [], tank: { calibrated: true } };
  if (path.includes("/protocols/job-card/")) return cardFor(url);
  if (path.includes("/treatment-plans/")) return { plan: planFor(url) };
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
const lastCardIds = () => idsOf(asked("/job-card/").at(-1)).sort();

beforeEach(() => {
  blocked = false;
  serverIgnores = [];
  hold = null;
  vi.stubGlobal("fetch", vi.fn((url) => {
    const u = String(url);
    // A held read of the job card or the plan with ticks: the panel waits on it, as on a slow network.
    if (hold && /\/(protocols\/job-card|treatment-plans)\/[^/?]+\?/.test(u)) return hold.promise.then(() => reply(fixture(u)));
    return reply(fixture(u));
  }));
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const deferred = () => { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; };
const mount = async (props = {}, svc = service) => {
  await act(async () => { render(<MemoryRouter><ProtocolPanel service={svc} onClose={() => {}} {...props} /></MemoryRouter>); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Job" })).toBeInTheDocument());
};

describe("ProtocolPanel Plan tab", () => {
  it("puts the Plan tab right after Job on a lawn visit and reads the plan only when it first opens; a pest visit has neither", async () => {
    await mount();
    const labels = screen.getAllByRole("button").map((b) => b.textContent).filter((t) => ["Job", "Plan", "Protocol", "Overview"].includes(t));
    expect(labels.slice(0, 2)).toEqual(["Job", "Plan"]);
    await screen.findByLabelText("Use Fixture optional");
    expect(asked("/treatment-plans/")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(await screen.findByText("Fixture track")).toBeInTheDocument();
    expect(asked("/treatment-plans/")).toHaveLength(1);
    cleanup();
    await mount({}, { ...service, id: "visit-pest", serviceType: "Pest Control" });
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(asked("/treatment-plans/").every((u) => !u.includes("visit-pest"))).toBe(true);
  });

  it("opens on the Plan tab when asked and reads the plan then; the tab shows no tick and no amount", async () => {
    await mount({ initialSection: "lawn_plan" });
    expect(await screen.findByText("Fixture track")).toBeInTheDocument();
    expect(asked("/treatment-plans/")).toHaveLength(1);
    expect(screen.queryByLabelText(/^Use /)).toBeNull();
  });

  it("after a tick the Plan tab does not show the previous selection's plan as current while the new read is out", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(await screen.findByText("Fixture track")).toBeInTheDocument();
    expect(screen.queryByText("Blackout after the tick.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Job" }));
    hold = deferred();
    fireEvent.click(await screen.findByLabelText("Use Fixture optional"));
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(await screen.findByText("Loading plan…")).toBeInTheDocument();
    expect(screen.queryByText("Fixture track")).toBeNull();
    await act(async () => { hold.release(); });
    expect(await screen.findByText("Blackout after the tick.")).toBeInTheDocument();
    expect(screen.getByText("Fixture track")).toBeInTheDocument();
  });

  it("the blocked-plan box on the Job tab opens the Plan tab", async () => {
    blocked = true;
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "See Plan tab" }));
    expect(await screen.findByText("Fixture track")).toBeInTheDocument();
  });
});

describe("Use ticks on the Job tab", () => {
  it("only a card the server marks planOption gets a Use box; an add-on's conditional card and a planned base card get none", async () => {
    await mount();
    expect(await screen.findByLabelText("Use Fixture optional")).not.toBeChecked();
    expect(screen.getAllByText("Fixture tree add-on").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Use Fixture tree add-on")).toBeNull();
    expect(screen.queryByLabelText("Use Fixture base")).toBeNull();
  });

  it("shows the mixing order from the job card", async () => {
    await mount();
    await screen.findByText("Mixing order");
    expect(screen.getByText("Bermuda backpack mix")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Mixing order"));
    expect(screen.getByText("Add the potassium first.")).toBeInTheDocument();
  });

  it("a tick re-reads the card; until the answer lands no amount, mixing order or Tank shows and the boxes are off, then the new amounts show", async () => {
    await mount();
    expect(screen.getByText(/2 fl oz/)).toBeInTheDocument();
    hold = deferred();
    fireEvent.click(await screen.findByLabelText("Use Fixture optional"));
    expect((await screen.findAllByText("Checking the new selection…")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\b2 fl oz\b/)).toBeNull();
    expect(screen.queryByText("Mixing order")).toBeNull();
    expect(screen.queryByText("Tank")).toBeNull();
    expect(screen.getByLabelText("Use Fixture optional")).toBeDisabled();
    // The local tick shows while the read is out; the rest of the card stays.
    expect(screen.getByLabelText("Use Fixture optional")).toBeChecked();
    expect(screen.getAllByText("Fixture base").length).toBeGreaterThan(0);
    await act(async () => { hold.release(); });
    await waitFor(() => expect(screen.queryByText("Checking the new selection…")).toBeNull());
    expect(screen.getAllByText(/4 fl oz/).length).toBeGreaterThan(0);
    expect(screen.getByText("Mixing order")).toBeInTheDocument();
    expect(screen.getByLabelText("Use Fixture optional")).toBeChecked();
    expect(screen.getByLabelText("Use Fixture optional")).not.toBeDisabled();
  });

  it("a deselect hides the old amount at once; the server's answer decides what is checked when it lands", async () => {
    await mount();
    fireEvent.click(await screen.findByLabelText("Use Fixture optional"));
    await waitFor(() => expect(screen.getAllByText(/4 fl oz/).length).toBeGreaterThan(0));
    hold = deferred();
    fireEvent.click(screen.getByLabelText("Use Fixture optional"));
    await screen.findAllByText("Checking the new selection…");
    expect(screen.queryByText(/4 fl oz/)).toBeNull();
    expect(screen.getByLabelText("Use Fixture optional")).not.toBeChecked();
    await act(async () => { hold.release(); });
    await waitFor(() => expect(screen.queryByText("Checking the new selection…")).toBeNull());
    expect(screen.queryByText(/4 fl oz/)).toBeNull();
    expect(lastCardIds()).toEqual([]);
  });

  it("an id the server did not select shows unchecked when the read lands", async () => {
    serverIgnores = ["opt"];
    await mount();
    fireEvent.click(await screen.findByLabelText("Use Fixture optional"));
    await waitFor(() => expect(lastCardIds()).toEqual(["opt"]));
    await waitFor(() => expect(screen.getByLabelText("Use Fixture optional")).not.toBeDisabled());
    expect(screen.getByLabelText("Use Fixture optional")).not.toBeChecked();
  });

  it("one tick on a bermuda step product adds all three step ids, and one untick takes all three off", async () => {
    await mount();
    fireEvent.click(await screen.findByLabelText("Use Fixture fus"));
    await waitFor(() => expect(lastCardIds()).toEqual(["fus", "nis", "rec"]));
    await waitFor(() => expect(screen.getByLabelText("Use Fixture rec")).not.toBeDisabled());
    for (const id of STEP_IDS) expect(screen.getByLabelText(`Use Fixture ${id}`)).toBeChecked();
    fireEvent.click(screen.getByLabelText("Use Fixture nis"));
    await waitFor(() => expect(asked("/job-card/").at(-1)).not.toContain("selectedConditionalProductIds"));
    await waitFor(() => expect(screen.getByLabelText("Use Fixture rec")).not.toBeDisabled());
    for (const id of STEP_IDS) expect(screen.getByLabelText(`Use Fixture ${id}`)).not.toBeChecked();
  });

  it("a tick clears the Tank search's product and result, and the next search reads the same ticks", async () => {
    await mount();
    await screen.findByText("Tank");
    fireEvent.change(screen.getByPlaceholderText("Search a product to mix"), { target: { value: "alp" } });
    fireEvent.click(await screen.findByRole("button", { name: /Fixture alpha/ }));
    expect(await screen.findByText(/1\.5 oz/)).toBeInTheDocument();
    expect(asked("/job-card/mix").at(-1)).not.toContain("selectedConditionalProductIds");
    fireEvent.click(screen.getByLabelText("Use Fixture optional"));
    await waitFor(() => expect(screen.getByLabelText("Use Fixture optional")).not.toBeDisabled());
    expect(screen.queryByText(/1\.5 oz/)).toBeNull();
    expect(await screen.findByPlaceholderText("Search a product to mix")).toHaveValue("");
    fireEvent.change(screen.getByPlaceholderText("Search a product to mix"), { target: { value: "alp" } });
    fireEvent.click(await screen.findByRole("button", { name: /Fixture alpha/ }));
    await screen.findByText(/1\.5 oz/);
    expect(idsOf(asked("/job-card/mix").at(-1))).toEqual(["opt"]);
  });
});
