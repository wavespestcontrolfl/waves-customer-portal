// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PhotoAssessmentsPage, { stageOf } from "./PhotoAssessmentsPage";
import PhotoAssessmentDetailSheet from "./PhotoAssessmentDetailSheet";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

const TS_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const response = (data, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => data });

const treeShrubDetail = {
  assessment: {
    id: TS_ID,
    type: "tree_shrub",
    status: "analyzed",
    source: "admin",
    headline: "75/100 · Disease / Leaf Spot Signals",
    contact: { first_name: "Robin", last_name: "Lee", email: "robin@example.com", phone: null },
    report_available: false,
    can_release: false,
    report_url: null,
    prospect_note: "hedge by the pool",
    created_at: "2026-09-24T14:00:00.000Z",
  },
  photos: [{ id: "p1", photo_index: 0, mime_type: "image/jpeg", url: "https://signed.example/p1" }],
  lead: null,
  customer: null,
  customer_preview: null,
  tech_view: {
    scores: { overallScore: 75 },
    worst_signal: { key: "disease_leaf_spot", label: "Disease / Leaf Spot Signals", score: 50, status: "needs_attention" },
    categories: [
      { key: "foliage_fullness", label: "Foliage Fullness", score: 82, status: "healthy" },
      { key: "disease_leaf_spot", label: "Disease / Leaf Spot Signals", score: 50, status: "needs_attention" },
    ],
    findings: [{ key: "disease_leaf_spot", label: "Leaf-spot / disease signals", status: "attention", detail: "Possible leaf-spot or disease-like signals.", score: 50 }],
    observations: "Leaf spotting on the lower hedge is consistent with fungal leaf spot.",
    ai_summary: "AI flagged 1 item to review.",
    photo_observations: [
      { index: 0, observations: "Dense, even canopy across the front beds.", worst_signal: null },
      { index: 1, observations: "Leaf spotting on the lower hedge is consistent with fungal leaf spot.", worst_signal: "disease_leaf_spot" },
    ],
    suggested_customer_action: "Recommend an on-site look to confirm the leaf-spot signals and quote treatment.",
    scored_count: 2,
    photo_count: 2,
  },
};

function routeFetch(overrides = {}) {
  adminFetch.mockImplementation(async (path) => {
    for (const [prefix, data] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) return response(data);
    }
    if (path.startsWith("/admin/photo-assessments/funnel")) return response({ days: 30, lawn: {}, pest: {}, tree_shrub: {} });
    if (path.startsWith("/admin/photo-assessments?")) return response({ assessments: [], gates: { lawn: false, pest: false } });
    return response({});
  });
}

beforeEach(() => {
  adminFetch.mockReset();
  routeFetch({ [`/admin/photo-assessments/tree_shrub/${TS_ID}`]: treeShrubDetail });
});
afterEach(() => cleanup());

it("New assessment offers Tree & shrub as a third type", async () => {
  render(<MemoryRouter><PhotoAssessmentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "New assessment" }));
  const typeSelect = screen.getByDisplayValue("Lawn assessment");
  expect(within(typeSelect).getAllByRole("option").map((o) => o.value)).toEqual(["lawn", "pest", "tree_shrub"]);
  fireEvent.change(typeSelect, { target: { value: "tree_shrub" } });
  expect(typeSelect).toHaveValue("tree_shrub");
});

it("the Tree & Shrub list filter requests type=tree_shrub", async () => {
  render(<MemoryRouter><PhotoAssessmentsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "Tree & Shrub" }));
  await waitFor(() => {
    expect(adminFetch.mock.calls.some(([path]) => path.startsWith("/admin/photo-assessments?") && path.includes("type=tree_shrub"))).toBe(true);
  });
});

it("?open=tree_shrub:<id> deep-links into the tree & shrub detail sheet", async () => {
  render(<MemoryRouter initialEntries={[`/admin/lawn-assessments?open=tree_shrub:${TS_ID}`]}><PhotoAssessmentsPage /></MemoryRouter>);
  expect(await screen.findByText(/No customer report for tree & shrub yet/)).toBeInTheDocument();
  expect(adminFetch).toHaveBeenCalledWith(`/admin/photo-assessments/tree_shrub/${TS_ID}`);
});

it("tree & shrub detail: scores + observations, and no Get link / Send report", async () => {
  render(<PhotoAssessmentDetailSheet open type="tree_shrub" id={TS_ID} onClose={() => {}} onChanged={() => {}} />);
  expect(await screen.findByText(/No customer report for tree & shrub yet/)).toBeInTheDocument();
  expect(screen.getByText("Tree & Shrub Assessment — Robin Lee")).toBeInTheDocument();
  // No funnel/teaser for this type: the stage reads Analyzed, not "Teaser only".
  expect(screen.getByText("Analyzed")).toBeInTheDocument();
  expect(screen.queryByText("Teaser only")).not.toBeInTheDocument();
  expect(screen.getByText("75/100")).toBeInTheDocument();
  expect(screen.getAllByText("Disease / Leaf Spot Signals").length).toBeGreaterThan(0);
  expect(screen.getByText("50/100 · Needs attention")).toBeInTheDocument();
  expect(screen.getByText(/consistent with fungal leaf spot/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Get link" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send report" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
  // Linking still works for this type.
  expect(screen.getByRole("button", { name: "Link…" })).toBeInTheDocument();

  // Details: no funnel timeline — the table has no claim/view/report columns.
  fireEvent.click(screen.getByRole("tab", { name: "Details" }));
  expect(await screen.findByText("Prospect note")).toBeInTheDocument();
  for (const label of ["Unlocked", "First viewed", "Report sent", "Link expires"]) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }

  fireEvent.click(screen.getByRole("tab", { name: "Tech" }));
  expect(await screen.findByText("Leaf-spot / disease signals")).toBeInTheDocument();
  expect(screen.getByText("2 of 2")).toBeInTheDocument();
  expect(screen.getByText("Suggested next step")).toBeInTheDocument();
  expect(screen.getByText("Recommend an on-site look to confirm the leaf-spot signals and quote treatment.")).toBeInTheDocument();
  // Every photo's own observation, in upload order, beside its own worst signal.
  expect(screen.getByText("Observations by photo")).toBeInTheDocument();
  expect(screen.getByText("Photo 1:")).toBeInTheDocument();
  expect(screen.getByText("Dense, even canopy across the front beds.")).toBeInTheDocument();
  expect(screen.getByText("Photo 2 · disease leaf spot:")).toBeInTheDocument();
});

it("pest detail still offers Get link + Send report when the server says it can release", async () => {
  const PEST_ID = "cccccccc-dddd-4eee-8fff-000000000000";
  routeFetch({
    [`/admin/photo-assessments/pest/${PEST_ID}`]: {
      assessment: { id: PEST_ID, type: "pest", status: "analyzed", source: "admin", headline: "Ghost Ants", contact: {}, report_available: true, can_release: true, report_url: null },
      photos: [],
      tech_view: { identification: { label: "Ghost Ants" }, service: {}, safety: {} },
      customer_preview: { identified: { label: "Ghost Ants" }, urgency: "moderate" },
    },
  });
  render(<PhotoAssessmentDetailSheet open type="pest" id={PEST_ID} onClose={() => {}} onChanged={() => {}} />);
  expect(await screen.findByRole("button", { name: "Send report" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Get link" })).toBeInTheDocument();
  // Funnel types keep their Details-tab funnel timeline.
  fireEvent.click(screen.getByRole("tab", { name: "Details" }));
  for (const label of ["Unlocked", "First viewed", "Report sent", "Link expires"]) {
    expect(await screen.findByText(label)).toBeInTheDocument();
  }
  expect(screen.queryByText(/No customer report for tree & shrub yet/)).not.toBeInTheDocument();
});

it("hides Get link + Send report when the server says the row cannot be released", async () => {
  const LAWN_ID = "dddddddd-eeee-4fff-8000-000000000000";
  routeFetch({
    [`/admin/photo-assessments/lawn/${LAWN_ID}`]: {
      assessment: { id: LAWN_ID, type: "lawn", status: "analyzed", source: "public_funnel", claimed_at: null, headline: "Keep an eye on it", contact: {}, report_available: true, can_release: false, report_url: null },
      photos: [],
      tech_view: { contract: {} },
      customer_preview: { overall_status: "Keep an eye on it", findings: [] },
    },
  });
  render(<PhotoAssessmentDetailSheet open type="lawn" id={LAWN_ID} onClose={() => {}} onChanged={() => {}} />);
  expect(await screen.findByText("Overall status")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send report" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Get link" })).not.toBeInTheDocument();
});

it("stageOf: tree & shrub rests at Analyzed; funnel types keep Teaser only; status + timestamp rungs still win", () => {
  expect(stageOf({ type: "tree_shrub", status: "analyzed", source: "admin" })).toEqual({ key: "analyzed", label: "Analyzed" });
  expect(stageOf({ type: "tree_shrub", status: "archived", source: "admin" }).label).toBe("Archived");
  expect(stageOf({ type: "lawn", status: "analyzed", source: "public_funnel" }).label).toBe("Teaser only");
  expect(stageOf({ type: "pest", status: "analyzed", source: "admin" }).label).toBe("Teaser only");
  expect(stageOf({ type: "pest", status: "sent" }).label).toBe("Link released");
  expect(stageOf({ type: "lawn", status: "sent", claimed_at: "2026-09-24T00:00:00Z" }).label).toBe("Unlocked");
  expect(stageOf({ type: "lawn", status: "sent", last_sent_at: "x", report_first_viewed_at: "y" }).label).toBe("Viewed");
});

it("the list shows a tree & shrub row as Analyzed, not Teaser only", async () => {
  routeFetch({
    "/admin/photo-assessments?": {
      assessments: [{ id: TS_ID, type: "tree_shrub", status: "analyzed", source: "admin", headline: "75/100 · Disease / Leaf Spot Signals", contact: { first_name: "Robin" }, created_at: "2026-09-24T14:00:00.000Z" }],
      gates: { lawn: false, pest: false },
    },
  });
  render(<MemoryRouter><PhotoAssessmentsPage /></MemoryRouter>);
  const row = (await screen.findByText("75/100 · Disease / Leaf Spot Signals")).closest("tr");
  expect(within(row).getByText("Tree & Shrub")).toBeInTheDocument();
  expect(within(row).getByText("Analyzed")).toBeInTheDocument();
  expect(within(row).queryByText("Teaser only")).not.toBeInTheDocument();
});
