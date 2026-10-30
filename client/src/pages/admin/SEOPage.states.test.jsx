// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import SEOPage from "./SEOPage";

vi.mock("./SEODashboardPage", () => ({
  default: () => <div>SEO dashboard fixture</div>,
}));

function reply(body = {}, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Service Unavailable",
    json: async () => body,
    clone() {
      return this;
    },
  };
}
const respond = (body, status) => Promise.resolve(reply(body, status));
const outage = () => respond({ error: "Synthetic outage" }, 503);

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

// handlers: [exactPath | (path, url) => boolean, (url, options) => Promise<reply>]
function route(handlers) {
  fetch.mockImplementation((input, options = {}) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    for (const [match, handler] of handlers) {
      const hit = typeof match === "function" ? match(path, url) : path === match;
      if (hit) return handler(url, options);
    }
    return respond({});
  });
}

const requested = (fragment) =>
  fetch.mock.calls.map(([input]) => String(input)).filter((u) => u.includes(fragment));

function renderPage(search) {
  return render(
    <MemoryRouter initialEntries={[`/admin/seo${search}`]}>
      <SEOPage />
    </MemoryRouter>,
  );
}

const ACTIONS = "?workspace=strategy&view=actions";
const PENDING = {
  id: "action-1",
  url: "https://example.test/pending-page",
  issue_type: "not_indexed",
  action_type: "submit_indexnow",
  priority_score: 80,
  approval_tier: "auto",
  approval_status: "pending",
  execution_status: "queued",
};
const EXPERIMENT = {
  id: "experiment-1",
  url: "https://example.test/experiment-page",
  action_type: "rewrite_title_meta",
  status: "running",
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    "waves_admin_user",
    JSON.stringify({ id: "seo-test", role: "admin", name: "SEO operator" }),
  );
  vi.stubGlobal("fetch", vi.fn(() => respond({})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SEO Actions workflow", () => {
  it("keeps a slow Experiments response out of Queue (SEO-07)", async () => {
    const experiments = deferred();
    route([
      ["/admin/seo/actions/summary", () => respond({ pending_by_tier: {}, done: 0 })],
      ["/admin/seo/url-intelligence/experiments", () => experiments.promise],
      ["/admin/seo/actions", (url) =>
        respond(url.searchParams.get("approval_status") === "pending" ? [PENDING] : [])],
    ]);
    renderPage(ACTIONS);
    expect(await screen.findByText(PENDING.url)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Experiments" }));
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(await screen.findByText(PENDING.url)).toBeInTheDocument();

    await act(async () => {
      experiments.resolve(reply([EXPERIMENT]));
    });
    expect(screen.queryByText(EXPERIMENT.url)).not.toBeInTheDocument();
    expect(screen.getByText(PENDING.url)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
  });

  it("keeps an approved action visible in Progress with a Mark done step (SEO-03)", async () => {
    let approved = false;
    route([
      ["/admin/seo/actions/summary", () => respond({ pending_by_tier: {}, done: 0 })],
      [`/admin/seo/actions/${PENDING.id}/approve`, () => {
        approved = true;
        return respond({ approved: true, id: PENDING.id });
      }],
      [`/admin/seo/actions/${PENDING.id}/execute`, () => respond({ executed: true, id: PENDING.id })],
      ["/admin/seo/actions", (url) => {
        const status = url.searchParams.get("approval_status");
        if (status === "pending") return respond(approved ? [] : [PENDING]);
        if (status === "approved") {
          return respond(approved ? [{ ...PENDING, approval_status: "approved" }] : []);
        }
        return respond([]);
      }],
    ]);
    renderPage(ACTIONS);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText("Approved. The action stays in Progress until it is done."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Progress" }));
    expect(await screen.findByText(PENDING.url)).toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(
      requested("execution_status=queued,in_progress,manual_required,failed"),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await waitFor(() =>
      expect(requested(`/admin/seo/actions/${PENDING.id}/execute`)).toHaveLength(1),
    );
  });

  it("shows an approved draft's status instead of Approve and Reject (SEO-03)", async () => {
    route([
      ["/admin/seo/actions/summary", () => respond({ pending_by_tier: {}, done: 0 })],
      ["/admin/seo/actions", () => respond([{
        ...PENDING,
        action_type: "rewrite_title_meta",
        approval_status: "approved",
        ai_draft: { title: "Synthetic proposed title" },
      }])],
    ]);
    renderPage(ACTIONS);
    fireEvent.click(await screen.findByRole("button", { name: "Drafts" }));
    expect(await screen.findByText("Synthetic proposed title")).toBeInTheDocument();
    expect(screen.getByText("Approved. Track it in Progress.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("shows a failed read as unavailable and a failed Generate Actions as an error (SEO-05)", async () => {
    let failing = true;
    route([
      ["/admin/seo/actions/summary", () =>
        (failing ? outage() : respond({ pending_by_tier: {}, done: 0 }))],
      ["/admin/seo/actions/generate", () => respond({ error: "Action generation failed" }, 503)],
      ["/admin/seo/actions", () => respond([])],
    ]);
    renderPage(ACTIONS);
    expect(
      await screen.findByText("SEO actions unavailable: Synthetic outage"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No pending actions. Run the pipeline to generate."),
    ).not.toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("No pending actions. Run the pipeline to generate."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate Actions" }));
    expect(await screen.findByText("Action generation failed")).toBeInTheDocument();
  });
});

describe("SEO read views", () => {
  it.each([
    ["Rankings", "?workspace=performance&view=rankings", "/admin/seo/rankings", "Rankings unavailable", /No ranking data yet/],
    ["Health", "?workspace=technical&view=site-audit", "/admin/seo/audit", "Site audit unavailable", /No Audit Data Yet/],
    ["Advisor", "?workspace=command&view=advisor", "/admin/seo/advisor", "SEO advisor unavailable", /No SEO reports yet/],
    ["Links", "?workspace=authority&view=backlinks", "/admin/seo/backlinks", "Backlinks unavailable", null],
    ["Indexation", "?workspace=technical&view=indexation", "/admin/seo/url-intelligence/indexation-gap", "Indexation data unavailable", null],
  ])("%s shows a failed read as unavailable, then the normal view after Try again (SEO-05)", async (_view, search, path, failure, empty) => {
    let failing = true;
    route([[path, () => (failing ? outage() : respond({}))]]);
    renderPage(search);
    expect(await screen.findByText(`${failure}: Synthetic outage`)).toBeInTheDocument();
    if (empty) expect(screen.queryByText(empty)).not.toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.queryByText(`${failure}: Synthetic outage`)).not.toBeInTheDocument(),
    );
    if (empty) expect(await screen.findByText(empty)).toBeInTheDocument();
  });

  it.each([
    ["resolves unsynced", () => respond({ synced: false, error: "quota exceeded" })],
    ["is rejected", () => respond({ error: "quota exceeded" }, 503)],
  ])("Advisor says when the GSC sync %s before the report (SEO-06)", async (_label, sync) => {
    route([
      ["/admin/seo/advisor", () => respond({ report: null })],
      ["/admin/seo/sync", sync],
      ["/admin/seo/advisor/generate", () => respond({
        report: { report_data: { grade: "B", overall_assessment: "Synthetic assessment" } },
      })],
    ]);
    renderPage("?workspace=command&view=advisor");
    fireEvent.click(await screen.findByRole("button", { name: "Sync GSC & Generate Report" }));
    expect(
      await screen.findByText(
        "GSC sync failed: quota exceeded. The report uses data stored before this sync.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Synthetic assessment")).toBeInTheDocument();
  });
});

describe("SEO Geo-Grid", () => {
  const heat = (office, rank) => ({
    office,
    keyword: "pest control",
    gridSize: 3,
    scanDate: "2026-10-28",
    stats: { top3Pct: rank === 1 ? 100 : 0, avgRank: rank, solv: 10, found: 9, total: 9 },
    pins: Array.from({ length: 9 }, (_, i) => ({
      pin_row: Math.floor(i / 3),
      pin_col: i % 3,
      map_pack_rank: rank,
    })),
  });

  it("keeps a slow heat map for the previous office off the selected office (SEO-07)", async () => {
    const bradenton = deferred();
    route([
      ["/admin/seo/geo-grid/named-searches", () => respond({ searches: [] })],
      ["/admin/seo/geo-grid/heatmap", (url) =>
        (url.searchParams.get("office") === "bradenton"
          ? bradenton.promise
          : respond(heat("sarasota", 15)))],
      ["/admin/seo/geo-grid", () => respond({
        offices: [{ id: "bradenton", name: "Bradenton" }, { id: "sarasota", name: "Sarasota" }],
        keywords: ["pest control"],
        gridSize: 3,
        gridSizeOptions: [3],
        gated: true,
      })],
    ]);
    renderPage("?workspace=performance&view=geo-grid");
    await waitFor(() => expect(requested("office=bradenton")).toHaveLength(1));

    const [officeSelect] = screen.getAllByRole("combobox");
    fireEvent.change(officeSelect, { target: { value: "sarasota" } });
    const avgRank = () => screen.getByText("Avg rank").parentElement;
    await waitFor(() => expect(avgRank()).toHaveTextContent("15"));

    await act(async () => {
      bradenton.resolve(reply(heat("bradenton", 1)));
    });
    expect(officeSelect).toHaveValue("sarasota");
    expect(avgRank()).toHaveTextContent("15");
  });
});
