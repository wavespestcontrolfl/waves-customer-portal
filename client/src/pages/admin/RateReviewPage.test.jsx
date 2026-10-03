// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RateReviewPage, { useRateReviewAvailable } from "./RateReviewPage";

// The send panel has its own tests (RateReviewSendPanel.test.jsx); here it is a
// stub that shows what the page hands it.
const panelProps = vi.hoisted(() => ({ current: null }));
vi.mock("../../components/admin/RateReviewSendPanel", () => ({
  default: (props) => {
    panelProps.current = props;
    return <div data-testid="send-panel" data-batch-key={props.batchKey} data-disabled={String(!!props.disabled)} data-refresh-key={String(props.refreshKey)} />;
  },
}));

// Every id, name and number here is invented.
const ROW_A = "a1a1a1a1-1111-4111-8111-111111111111";
const ROW_B = "b2b2b2b2-2222-4222-8222-222222222222";
const ROW_C = "c3c3c3c3-3333-4333-8333-333333333333";
const ROW_D = "d4d4d4d4-4444-4444-8444-444444444444";
const ROW_E = "e5e5e5e5-5555-4555-8555-555555555555";
const ROW_F = "f6f6f6f6-6666-4666-8666-666666666666";
const DIGEST = "abcd1234ef567890";

const CONFIG = {
  pass_through_pct: 3.5, band_b_tolerance_pct: 5, band_c_max_pct: 10, cap_pct: 12, cap_cents: 1500, min_delta_cents: 300,
  min_usable_visits: 3, lock_months: 12, exception_callback_days: 60, exception_manual_edit_months: 6,
  cost_block: "", cost_block_set_at: null, cost_block_set_by: null, cost_block_set_by_name: null, updated_at: null, updated_by: null, updated_by_name: null,
};

function row(id, overrides) {
  return {
    id, batch_key: "2027-01", customer_id: `cust-${id.slice(0, 4)}`, family_key: "pest_control", cadence: "quarterly", visits_per_year: 4, rph_from_not_home: false, not_home_visits: 0,
    rate_unit: "application", anniversary_date: "2027-01-06", tenure_months: 13, current_rate_cents: 10500, list_rate_cents: 11700,
    list_rate_source: "engine", gap_pct: 10.256, usable_visits: 4, revenue_per_hour_cents: 17200, band: "C", proposed_rate_cents: 11700,
    delta_cents: 1200, annual_delta_cents: 4800, flags: [], status: "green", customer_name: "Fixture Whitfield", city: "Bradenton", ...overrides,
  };
}

function fixtureRows() {
  return [
    row(ROW_A, { rph_from_not_home: true, not_home_visits: 3 }),
    row(ROW_B, { customer_name: "Fixture Fournier", city: "Parrish", anniversary_date: "2027-01-20", current_rate_cents: 13000, gap_pct: -11.111, band: "A", proposed_rate_cents: 13000, delta_cents: 0, annual_delta_cents: 0, status: "no_change", revenue_per_hour_cents: 22100 }),
    row(ROW_C, { customer_name: "Fixture Lima", city: "Sarasota", anniversary_date: "2027-01-14", current_rate_cents: 11700, gap_pct: 0, band: "B", proposed_rate_cents: 12100, delta_cents: 400, annual_delta_cents: 1600, status: "exception", flags: ["past_due", "list_from_cadence_mode", "list_low_confidence", "multi_program_line"] }),
    row(ROW_D, { customer_name: "Fixture Unpriced", city: "Venice", current_rate_cents: 0, list_rate_cents: null, gap_pct: null, band: null, proposed_rate_cents: 0, delta_cents: 0, annual_delta_cents: 0, status: "skipped", flags: ["no_current_rate"], revenue_per_hour_cents: null, usable_visits: 0 }),
    row(ROW_E, { customer_name: "Fixture Nguyen", city: "Lakewood Ranch", family_key: "lawn_care", cadence: "every_6_weeks", visits_per_year: 9, anniversary_date: "2027-01-15", current_rate_cents: 5600, list_rate_cents: 6800, list_rate_source: "cadence_mode", gap_pct: 17.647, usable_visits: 1, revenue_per_hour_cents: null, band: "D", proposed_rate_cents: 6300, delta_cents: 700, annual_delta_cents: 6300, flags: ["capped", "list_from_cadence_mode"] }),
    // Monthly dues on a quarterly line: the start date is 2026-01-28, the review date (the server's review_date) is its 2027 occurrence.
    row(ROW_F, { customer_name: "Fixture Okafor", city: "Palmetto", cadence: "quarterly", visits_per_year: 4, rate_unit: "month", anniversary_date: "2026-01-28", review_date: "2027-01-28", tenure_months: 12, current_rate_cents: 3867, list_rate_cents: 4000, gap_pct: 3.325, revenue_per_hour_cents: 15000, band: "B", proposed_rate_cents: 4000, delta_cents: 133, annual_delta_cents: 1596 }),
  ];
}

function batchPayload(rows) {
  return {
    batchKey: "2027-01",
    batch: { batch_key: "2027-01", window_from: "2027-01-01", window_to: "2027-01-31", config: CONFIG, approved_at: null },
    rows,
    summary: { rows: rows.length },
    approvalDigest: DIGEST,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300, status, statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => null }, json: async () => body, clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let rows;
let calls;
let batchGets;
let approveStatus;

let secondBatchStatus;
let batchGetStatusAfterFirst;
let digestResponse;
let putStatus;

function installFetch() {
  calls = [];
  batchGets = 0;
  approveStatus = 200;
  secondBatchStatus = 200;
  batchGetStatusAfterFirst = 200;
  digestResponse = null;
  putStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = String(url);
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path, body });
    if (method === "GET" && path.endsWith("/admin/rate-review/batches")) {
      return jsonResponse({ enabled: true, batches: [
        { batch_key: "2027-01", window_from: "2027-01-01", window_to: "2027-01-31", rows: rows.length },
        { batch_key: "2026-12", window_from: "2026-12-01", window_to: "2026-12-31", rows: 0 },
      ], config: CONFIG });
    }
    if (method === "GET" && path.endsWith("/admin/rate-review/batches/2026-12")) {
      if (secondBatchStatus !== 200) return jsonResponse({ error: "Could not read the rate review batch" }, secondBatchStatus);
      return jsonResponse({ batchKey: "2026-12", batch: { batch_key: "2026-12", window_from: "2026-12-01", window_to: "2026-12-31", config: CONFIG, approved_at: null }, rows: [], summary: {}, approvalDigest: "0000111122223333" });
    }
    if (method === "GET" && path.endsWith("/admin/rate-review/batches/2027-01")) {
      batchGets += 1;
      if (batchGets > 1 && batchGetStatusAfterFirst !== 200) return jsonResponse({ error: "Could not read the rate review batch" }, batchGetStatusAfterFirst);
      return jsonResponse(batchPayload(rows));
    }
    if (method === "GET" && /\/letter-preview$/.test(path)) return jsonResponse({ error: "Not found" }, 404);
    if (method === "PUT" && /\/rows\//.test(path)) {
      if (putStatus !== 200) return jsonResponse({ error: "This batch already has rows that were sent to customers — it can no longer be edited.", reason: "batch_has_sent_rows" }, putStatus);
      const id = path.split("/rows/")[1];
      const target = rows.find((r) => r.id === id);
      const next = { ...target };
      if (body.proposed_rate_cents != null) {
        next.proposed_rate_cents = body.proposed_rate_cents;
        next.delta_cents = body.proposed_rate_cents - next.current_rate_cents;
        next.annual_delta_cents = next.delta_cents * (next.rate_unit === "month" ? 12 : next.visits_per_year);
        next.flags = [...next.flags, "admin_edited"];
      }
      if (body.status === "skipped") next.status = "skipped";
      if (body.status === "green") next.status = next.delta_cents >= 300 ? "green" : "no_change";
      rows = rows.map((r) => (r.id === id ? next : r));
      return jsonResponse({ ok: true, row: next, summary: {}, approvalDigest: "ffff0000ffff0000" });
    }
    if (method === "POST" && path.endsWith("/approve")) {
      if (approveStatus !== 200) return jsonResponse({ error: "The batch changed since this screen loaded — review it again before approving.", reason: "digest_mismatch", approvalDigest: "1111222233334444" }, approveStatus);
      rows = rows.map((r) => (r.status === "green" ? { ...r, status: "approved" } : r));
      return jsonResponse({ ok: true, approved: 2, annual_delta_cents: 11100, approvalDigest: "9999888877776666", summary: {} });
    }
    if (method === "POST" && path.endsWith("/digest")) {
      if (digestResponse) return jsonResponse(digestResponse.body, digestResponse.status);
      return jsonResponse({ ok: true, batchKey: "2027-01", sent: true, stamped: true, channel: "email", skipped: null, subject: "ACT: Rate review — January 2027 batch" });
    }
    if (method === "PUT" && path.endsWith("/admin/rate-review/config")) {
      return jsonResponse({ ok: true, config: { ...CONFIG, ...body, cost_block_set_at: "2026-10-28T14:00:00.000Z", cost_block_set_by_name: "Owner Fixture" }, changed: {} });
    }
    return jsonResponse({}, 404);
  }));
}

function renderPage(entry = "/admin/pricing-logic?area=rate-review&batch=2027-01") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/pricing-logic" element={<RateReviewPage embedded />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function renderLoaded() {
  renderPage();
  await screen.findByText("Fixture Whitfield");
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "qa-token");
  rows = fixtureRows();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("RateReviewPage", () => {
  it("renders the batch: option label, stat cards, the ranked rows, the live bands sentence and the exceptions", async () => {
    await renderLoaded();

    expect(screen.getByRole("option", { name: "January 2027 · anniversaries Jan 1–31" })).toBeInTheDocument();
    const stat = (label) => screen.getByText(label, { selector: "div" }).nextSibling;
    expect(stat("Notices")).toHaveTextContent("3");
    expect(stat("No change")).toHaveTextContent("1");
    expect(stat("Exceptions")).toHaveTextContent("1");
    // The monthly line's $1.33 × 12 brings cents into the sum: shown, never rounded away.
    expect(stat("Proposed")).toHaveTextContent("+$126.96");
    expect(screen.getByRole("button", { name: "Approve batch · send 3 notices" })).toBeEnabled();

    const table = screen.getByRole("table", { name: "Rate review rows" });
    expect(screen.getByText("4 accounts · anniversaries Jan 1–31, 2027 · notices by Dec 7")).toBeInTheDocument();
    // The monthly line shows its review date (2027), not the 2026 start date, and keeps its cents.
    expect(within(table).getByText("Jan 28, 2027")).toBeInTheDocument();
    expect(within(table).queryByText("Jan 28, 2026")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Proposed per month for Fixture Okafor")).toHaveValue(40);
    expect(within(table).getByText("$38.67")).toBeInTheDocument();
    expect(within(table).getByText("C · under list")).toBeInTheDocument();
    expect(within(table).getByText("D · badly under")).toBeInTheDocument();
    expect(within(table).getByText("cadence mode")).toBeInTheDocument();
    expect(within(table).getByText("— (1)")).toBeInTheDocument();
    // $/hr from the account's own not-home visits names that sample, not every usable visit.
    expect(within(table).getByText("(3 not-home)")).toBeInTheDocument();
    expect(within(table).getAllByText("(4)").length).toBeGreaterThan(0); // the other rows: every usable visit
    expect(within(table).getByText("Every 6 weeks")).toBeInTheDocument();
    expect(within(table).getByText("Jan 6, 2027")).toBeInTheDocument();
    expect(within(table).queryByText("Fixture Lima")).not.toBeInTheDocument();
    expect(within(table).queryByText("Fixture Unpriced")).not.toBeInTheDocument();
    expect(screen.getByText("1 line skipped — could not be priced.")).toBeInTheDocument();
    expect(screen.getByText(/B within 5% of list → year pass-through \(\+3.5%\)\. C under list ≤10% → to list\. D under >10% or bottom-quartile \$\/hr → cap \+12% or \+\$15 per application/)).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();

    expect(screen.getByText("Exceptions · 1 · waiting for you")).toBeInTheDocument();
    expect(screen.getByText("Past due")).toBeInTheDocument();
    // every hold the ranking emits has a chip — a pricing problem is never hidden behind "Held for review"
    expect(screen.getByText("List price low confidence")).toBeInTheDocument();
    expect(screen.getByText("Several programs on one line")).toBeInTheDocument();
    expect(screen.queryByText("Held for review")).not.toBeInTheDocument();
    expect(screen.getByText("Sarasota · Pest · Quarterly · anniversary Jan 14, 2027")).toBeInTheDocument();
    // The Field label names the control; the status is its visible text.
    expect(screen.getByRole("button", { name: "Cost block" })).toHaveTextContent("Not written yet · Write it");
  });

  it("a band-A row has no letter: the amount and Letter button are disabled and Include says so", async () => {
    await renderLoaded();
    expect(screen.getByLabelText("Proposed per application for Fixture Fournier")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Letter for Fixture Fournier" })).toBeDisabled();
    expect(screen.getByLabelText("Include Fixture Fournier")).toBeChecked();
    const table = screen.getByRole("table", { name: "Rate review rows" });
    expect(within(table).getByText("no letter")).toBeInTheDocument();
    expect(screen.getByLabelText("Proposed per application for Fixture Whitfield")).toBeEnabled();
  });

  it("editing a proposed amount sends whole-dollar cents on blur and shows the server's recompute", async () => {
    await renderLoaded();
    const input = screen.getByLabelText("Proposed per application for Fixture Whitfield");
    fireEvent.change(input, { target: { value: "112" } });
    fireEvent.blur(input);

    await screen.findByText("Fixture Whitfield: proposed $112 per application.");
    const put = calls.find((c) => c.method === "PUT");
    expect(put.path).toMatch(new RegExp(`/admin/rate-review/batches/2027-01/rows/${ROW_A}$`));
    expect(put.body).toEqual({ proposed_rate_cents: 11200 });
    expect(screen.getByText("+$28")).toBeInTheDocument();
    expect(input).toHaveValue(112);
  });

  it("an unchanged or below-current amount sends nothing", async () => {
    await renderLoaded();
    const input = screen.getByLabelText("Proposed per application for Fixture Whitfield");
    fireEvent.change(input, { target: { value: "117" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    // Below the current rate clamps to it ($105) — never a cut.
    expect(calls.find((c) => c.method === "PUT").body).toEqual({ proposed_rate_cents: 10500 });
  });

  it("the Include checkbox toggles green ↔ skipped through one PUT", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByLabelText("Include Fixture Whitfield"));
    await screen.findByText("Fixture Whitfield skipped this cycle.");
    expect(calls.find((c) => c.method === "PUT").body).toEqual({ status: "skipped" });
    expect(screen.getByLabelText("Include Fixture Whitfield")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Approve batch · send 2 notices" })).toBeInTheDocument();
    // The whole batch is re-read after an edit (the digest covers every row).
    expect(batchGets).toBe(2);

    fireEvent.click(screen.getByLabelText("Include Fixture Whitfield"));
    await screen.findByText("Fixture Whitfield is in the batch.");
    expect(calls.filter((c) => c.method === "PUT")[1].body).toEqual({ status: "green" });
  });

  it("approve: the dialog shows the digest, the confirm posts it, and the batch reloads as approved", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Approve batch · send 3 notices" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve January 2027 batch" });
    expect(within(dialog).getByText("3 customers · email letter + text pointer")).toBeInTheDocument();
    expect(within(dialog).getByText("abcd-1234 · refuses if the list changes before send")).toBeInTheDocument();
    expect(within(dialog).getByText("+$126.96 per year")).toBeInTheDocument();
    expect(within(dialog).getByText(/earliest Jan 6, 2027/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Approve 3 notices" }));
    await screen.findByText("Batch approved: 2 notices marked approved (+$111 per year). Nothing has been sent yet — use Send letters below the table.");
    const post = calls.find((c) => c.method === "POST");
    expect(post.path).toMatch(/\/admin\/rate-review\/batches\/2027-01\/approve$/);
    expect(post.body).toEqual({ expectedDigest: DIGEST });
    expect(batchGets).toBe(2);
    expect(screen.getByText(/^Approved/)).toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Batch approved" })).toBeDisabled();
    expect(screen.getByLabelText("Proposed per application for Fixture Whitfield")).toBeDisabled();
  });

  it("a stale digest is refused: the server's message shows and the batch reloads", async () => {
    await renderLoaded();
    approveStatus = 409;
    fireEvent.click(screen.getByRole("button", { name: "Approve batch · send 3 notices" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve 3 notices" }));
    await screen.findByText("The batch changed since this screen loaded — review it again before approving.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(batchGets).toBe(2));
  });

  it("an exception's Include sends includeException and moves the row into the table; Skip this cycle sends skipped", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Include" }));
    await screen.findByText("Fixture Lima added to the batch.");
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: expect.stringMatching(new RegExp(`/rows/${ROW_C}$`)), body: { status: "green", includeException: true } });
    expect(screen.getByText("No exceptions in this batch.")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Rate review rows" })).getByText("Fixture Lima")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve batch · send 4 notices" })).toBeInTheDocument();
  });

  it("while one row saves, every other row control is disabled and a draft typed before the save survives it", async () => {
    await renderLoaded();
    // Hold the first PUT open so the saving state is observable.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if ((options.method || "GET") === "PUT" && /\/rows\//.test(String(url))) await gate;
      return original(url, options);
    }));
    const other = screen.getByLabelText("Proposed per application for Fixture Nguyen");
    fireEvent.change(other, { target: { value: "65" } }); // typed, not yet committed
    fireEvent.click(screen.getByLabelText("Include Fixture Whitfield"));
    await waitFor(() => expect(screen.getByLabelText("Include Fixture Whitfield")).toBeDisabled());
    expect(other).toBeDisabled();
    expect(screen.getByLabelText("Include Fixture Nguyen")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Include" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Approve batch/ })).toBeDisabled();
    release();
    await screen.findByText("Fixture Whitfield skipped this cycle.");
    expect(other).toBeEnabled();
    expect(other).toHaveValue(65); // the other row's draft was not thrown away by the reload
  });

  it("switching batches drops the old batch at once; a failed load leaves nothing actionable, and a save finishing after the switch never reinstates the old batch", async () => {
    await renderLoaded();
    // Hold a save open on the first batch, then switch while it is in flight.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = fetch;
    secondBatchStatus = 500;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if ((options.method || "GET") === "PUT" && /\/rows\//.test(String(url))) await gate;
      return original(url, options);
    }));
    fireEvent.click(screen.getByLabelText("Include Fixture Whitfield"));
    await waitFor(() => expect(screen.getByLabelText("Include Fixture Whitfield")).toBeDisabled());
    fireEvent.change(screen.getByLabelText("Batch"), { target: { value: "2026-12" } });
    // The old batch is gone immediately, before the new one answers.
    expect(screen.queryByText("Fixture Whitfield")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve batch/ })).toBeDisabled();
    await screen.findByText("Could not read the rate review batch");
    expect(screen.getByRole("button", { name: /^Approve batch/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Email me this batch" })).toBeDisabled();
    release();
    // The save that finished late does not reload or show the January batch.
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Fixture Whitfield")).not.toBeInTheDocument();
    expect(screen.queryByText("Fixture Whitfield skipped this cycle.")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "GET" && c.path.endsWith("/batches/2027-01"))).toHaveLength(1);
    // Retry works for the newly selected batch.
    secondBatchStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No accounts in this batch.");
  });

  it("an input cleared to empty is no edit: nothing is sent and the prior amount comes back", async () => {
    await renderLoaded();
    const input = screen.getByLabelText("Proposed per application for Fixture Whitfield");
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue(null);
    fireEvent.blur(input);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(input).toHaveValue(117);
    expect(screen.queryByText(/proposed \$/)).not.toBeInTheDocument();
  });

  it("a successful approval whose reload fails is still reported as approved, with nothing stale left actionable", async () => {
    await renderLoaded();
    batchGetStatusAfterFirst = 500;
    fireEvent.click(screen.getByRole("button", { name: "Approve batch · send 3 notices" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve 3 notices" }));
    await screen.findByText("Batch approved: 2 notices marked approved (+$111 per year). Nothing has been sent yet — use Send letters below the table. The batch could not be reloaded — use Try again.");
    expect(screen.getByText("Could not read the rate review batch")).toBeInTheDocument();
    expect(screen.queryByText("Fixture Whitfield")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve batch/ })).toBeDisabled();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    // Try again re-reads the batch, now approved on the server.
    batchGetStatusAfterFirst = 200;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Fixture Whitfield");
    expect(screen.getByRole("button", { name: "Batch approved" })).toBeDisabled();
  });

  it("a save whose reload fails keeps the saved change and clears the stale rows", async () => {
    await renderLoaded();
    batchGetStatusAfterFirst = 500;
    fireEvent.click(screen.getByLabelText("Include Fixture Whitfield"));
    await screen.findByText("Fixture Whitfield skipped this cycle. The batch could not be reloaded — use Try again.");
    expect(screen.queryByText("Fixture Whitfield")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("a batch switch during the post-save reload keeps the old batch's result off the new one", async () => {
    await renderLoaded();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = fetch;
    let gatedReloads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      // The reload GET that follows the PUT waits until the test releases it.
      if ((options.method || "GET") === "GET" && String(url).endsWith("/batches/2027-01") && batchGets >= 1) {
        gatedReloads += 1;
        await gate;
      }
      return original(url, options);
    }));
    fireEvent.click(screen.getByLabelText("Include Fixture Whitfield"));
    await waitFor(() => expect(gatedReloads).toBe(1));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Batch"), { target: { value: "2026-12" } });
    await screen.findByText("No accounts in this batch.");
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Fixture Whitfield skipped this cycle.")).not.toBeInTheDocument();
    expect(screen.queryByText("Fixture Whitfield")).not.toBeInTheDocument();
    expect(screen.getByText("No accounts in this batch.")).toBeInTheDocument();
  });

  it("an email failure that lands after a batch switch is not shown on the new batch", async () => {
    await renderLoaded();
    let reject;
    const gate = new Promise((_, rej) => { reject = rej; });
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if ((options.method || "GET") === "POST" && /\/digest$/.test(String(url))) await gate;
      return original(url, options);
    }));
    fireEvent.click(screen.getByRole("button", { name: "Email me this batch" }));
    fireEvent.change(screen.getByLabelText("Batch"), { target: { value: "2026-12" } });
    await screen.findByText("No accounts in this batch.");
    reject(Object.assign(new Error("Could not send the batch digest"), { status: 502 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Could not send the batch digest")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me this batch" })).toBeEnabled();
  });

  it("settings fields are disabled while a save is pending, so a response never overwrites newer typing", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Cost block", exact: true }));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if ((options.method || "GET") === "PUT" && /\/config$/.test(String(url))) await gate;
      return original(url, options);
    }));
    fireEvent.change(screen.getByLabelText("Cap ($ per application)"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.getByLabelText("Cap ($ per application)")).toBeDisabled());
    expect(screen.getByLabelText("Cost block text")).toBeDisabled();
    expect(screen.getByLabelText("Pass-through (%)")).toBeDisabled();
    release();
    await screen.findByText(/Settings saved\./);
    expect(screen.getByLabelText("Cap ($ per application)")).toBeEnabled();
    expect(screen.getByLabelText("Cap ($ per application)")).toHaveValue(20);
  });

  it("a monthly line edits in cents: $40.00 → $41.50 sends 4150", async () => {
    await renderLoaded();
    const input = screen.getByLabelText("Proposed per month for Fixture Okafor");
    fireEvent.change(input, { target: { value: "41.5" } });
    fireEvent.blur(input);
    await screen.findByText("Fixture Okafor: proposed $41.50 per month.");
    expect(calls.find((c) => c.method === "PUT").body).toEqual({ proposed_rate_cents: 4150 });
    expect(input).toHaveValue(41.5);
  });

  it("Skip this cycle on an exception sends skipped with includeException", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Skip this cycle" }));
    await screen.findByText("Fixture Lima skipped this cycle.");
    expect(calls.find((c) => c.method === "PUT").body).toEqual({ status: "skipped", includeException: true });
  });

  it("the letter preview says the row has no letter yet while the route 404s", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Letter for Fixture Whitfield" }));
    const sheet = await screen.findByRole("dialog", { name: "Letter preview" });
    await within(sheet).findByText("No letter for this row yet. Approve the batch, then use Prepare notices in the Send letters panel below the table.");
    expect(within(sheet).getByText("Letter · Fixture Whitfield")).toBeInTheDocument();
    expect(calls.find((c) => /letter-preview$/.test(c.path)).path).toMatch(new RegExp(`/batches/2027-01/rows/${ROW_A}/letter-preview$`));
  });

  it("mounts the Send letters panel under the table for the loaded batch only", async () => {
    panelProps.current = null;
    renderPage();
    expect(screen.queryByTestId("send-panel")).not.toBeInTheDocument();
    const panel = await screen.findByTestId("send-panel");
    expect(panel).toHaveAttribute("data-batch-key", "2027-01");
    expect(panel).toHaveAttribute("data-disabled", "false");
    const table = screen.getByRole("table", { name: "Rate review rows" });
    expect(table.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("approving the batch tells the send panel to read its preview again", async () => {
    await renderLoaded();
    expect(screen.getByTestId("send-panel")).toHaveAttribute("data-refresh-key", "0");
    fireEvent.click(screen.getByRole("button", { name: "Approve batch · send 3 notices" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve 3 notices" }));
    await screen.findByText(/Batch approved: 2 notices marked approved/);
    expect(screen.getByTestId("send-panel")).toHaveAttribute("data-refresh-key", "1");
  });

  it("the panel's request blocks the page's writes and its changes re-read the batch", async () => {
    await renderLoaded();
    const before = batchGets;
    await act(async () => { panelProps.current.onBusyChange(true); });
    expect(screen.getByLabelText("Include Fixture Whitfield")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve batch · send 3 notices" })).toBeDisabled();
    await act(async () => { panelProps.current.onBusyChange(false); panelProps.current.onChanged(); });
    await waitFor(() => expect(batchGets).toBe(before + 1));
    expect(screen.getByLabelText("Include Fixture Whitfield")).toBeEnabled();
  });

  it("Preview letters opens the first letter in the table", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Preview letters" }));
    const sheet = await screen.findByRole("dialog", { name: "Letter preview" });
    expect(within(sheet).getByText("Letter · Fixture Whitfield")).toBeInTheDocument();
  });

  it("Email me this batch sends the owner digest through the ranking's digest route and reports an already-sent one", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Email me this batch" }));
    await screen.findByText("Batch digest sent to contact@: ACT: Rate review — January 2027 batch");
    expect(calls.find((c) => c.method === "POST").path).toMatch(/\/batches\/2027-01\/digest$/);
    digestResponse = { status: 200, body: { ok: true, batchKey: "2027-01", sent: true, stamped: true, channel: "in_app", skipped: null, subject: "ACT: Rate review — January 2027 batch" } };
    fireEvent.click(screen.getByRole("button", { name: "Email me this batch" }));
    await screen.findByText("Batch digest posted to the admin bell (ops digests are in-app): ACT: Rate review — January 2027 batch");
    digestResponse = { status: 200, body: { ok: true, batchKey: "2027-01", sent: false, stamped: false, channel: null, skipped: "already_sent", subject: null } };
    fireEvent.click(screen.getByRole("button", { name: "Email me this batch" }));
    await screen.findByText("This batch's digest already went out; a rebuild sends an updated one.");
    digestResponse = { status: 409, body: { error: "A rate review build is running — try again in a moment.", reason: "build_in_progress" } };
    fireEvent.click(screen.getByRole("button", { name: "Email me this batch" }));
    await screen.findByText("A rate review build is running — try again in a moment.");
  });

  it("a row edit refused with 409 re-reads the batch as it is now", async () => {
    await renderLoaded();
    putStatus = 409;
    fireEvent.click(screen.getByLabelText("Include Fixture Whitfield"));
    await screen.findByText("This batch already has rows that were sent to customers — it can no longer be edited.");
    await waitFor(() => expect(batchGets).toBe(2));
  });

  it("a post-save reload superseded by a switch away and back never clears the freshly loaded batch", async () => {
    await renderLoaded();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = fetch;
    let reloads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      // the post-save reload — the first GET of this batch after the render — is held back
      if ((options.method || "GET").toUpperCase() === "GET" && /\/batches\/2027-01$/.test(String(url)) && ++reloads === 1) await gate;
      return original(url, options);
    }));
    fireEvent.click(screen.getByLabelText("Include Fixture Whitfield"));
    await waitFor(() => expect(reloads).toBe(1));
    fireEvent.change(screen.getByLabelText("Batch"), { target: { value: "2026-12" } });
    await screen.findByText("No accounts in this batch.");
    fireEvent.change(screen.getByLabelText("Batch"), { target: { value: "2027-01" } });
    await screen.findByText("Fixture Whitfield");
    release();
    await new Promise((r) => setTimeout(r, 30));
    // the newer load owns the screen: the older reload's late answer clears nothing
    expect(screen.getByText("Fixture Whitfield")).toBeInTheDocument();
    expect(screen.queryByText("Could not read the rate review batch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve batch/ })).toBeEnabled();
  });

  it("a 409 on approve whose reload then fails leaves nothing stale actionable", async () => {
    await renderLoaded();
    approveStatus = 409;
    batchGetStatusAfterFirst = 500;
    fireEvent.click(screen.getByRole("button", { name: "Approve batch · send 3 notices" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve 3 notices" }));
    await screen.findByText("The batch changed since this screen loaded — review it again before approving.");
    await screen.findByText("Could not read the rate review batch");
    expect(screen.queryByText("Fixture Whitfield")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve batch/ })).toBeDisabled();
  });

  it("a line filter the next batch does not offer falls back to all lines", async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Line"), { target: { value: "lawn_care" } });
    expect(screen.getByLabelText("Line")).toHaveValue("lawn_care");
    fireEvent.change(screen.getByLabelText("Batch"), { target: { value: "2026-12" } });
    await screen.findByText("No accounts in this batch.");
    expect(screen.getByLabelText("Line")).toHaveValue("all");
  });

  it("closing the letter sheet before its request answers keeps it closed", async () => {
    await renderLoaded();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (/letter-preview$/.test(String(url))) await gate;
      return original(url, options);
    }));
    fireEvent.click(screen.getByRole("button", { name: "Letter for Fixture Whitfield" }));
    const sheet = await screen.findByRole("dialog", { name: "Letter preview" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Letter preview" })).not.toBeInTheDocument();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("dialog", { name: "Letter preview" })).not.toBeInTheDocument();
  });

  it("filters are client-side: Line and Band narrow the table without a request", async () => {
    await renderLoaded();
    const requests = calls.length;
    fireEvent.change(screen.getByLabelText("Line"), { target: { value: "lawn_care" } });
    const table = screen.getByRole("table", { name: "Rate review rows" });
    expect(within(table).getByText("Fixture Nguyen")).toBeInTheDocument();
    expect(within(table).queryByText("Fixture Whitfield")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Band"), { target: { value: "A" } });
    expect(within(table).getByText("No rows match these filters.")).toBeInTheDocument();
    expect(calls.length).toBe(requests);
  });

  it("Settings is collapsed by default and saves only the changed knobs (dollars as cents) plus the cost block", async () => {
    await renderLoaded();
    expect(screen.queryByLabelText("Cap ($ per application)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cost block" }));
    expect(screen.getByRole("button", { name: /^Settings/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Cap ($ per application)")).toHaveValue(15);
    expect(screen.getByLabelText("Pass-through (%)")).toHaveValue(3.5);

    fireEvent.change(screen.getByLabelText("Cap ($ per application)"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Cost block text"), { target: { value: "Technician pay is up 6% since last January." } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await screen.findByText("Settings saved. They apply to the next build; this batch keeps the values it was ranked with. Cost block updated — the current batch's send preview and letters now use it.");
    const put = calls.find((c) => c.method === "PUT" && /\/config$/.test(c.path));
    expect(put.body).toEqual({ cap_cents: 2000, cost_block: "Technician pay is up 6% since last January." });
    expect(screen.getByRole("button", { name: "Cost block" })).toHaveTextContent("Set Oct 28 by Owner · Edit");
  });

  it("settings feedback says a cost block change is live for the current batch, and a knob change waits for the next build", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Cost block" }));
    fireEvent.change(screen.getByLabelText("Cost block text"), { target: { value: "Costs went up 6%." } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Cost block updated — the current batch's send preview and letters now use it.");
    expect(screen.queryByText(/^Settings saved\./)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Cap ($ per application)"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved. They apply to the next build; this batch keeps the values it was ranked with.");
    expect(screen.queryByText(/Cost block updated/)).not.toBeInTheDocument();
  });

  it("the ops-email deep link picks the batch from ?batch= and a bad key falls back to the newest", async () => {
    renderPage("/admin/pricing-logic?area=rate-review&batch=2099-12");
    await screen.findByText("Fixture Whitfield");
    expect(screen.getByLabelText("Batch")).toHaveValue("2027-01");
  });
});

describe("RateReviewPage before the first batch", () => {
  it("renders Settings (knobs + cost block) when there are no batches yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const method = (options.method || "GET").toUpperCase();
      if (method === "GET" && String(url).endsWith("/admin/rate-review/batches")) return jsonResponse({ enabled: true, batches: [], config: CONFIG });
      if (method === "PUT" && String(url).endsWith("/admin/rate-review/config")) return jsonResponse({ ok: true, config: { ...CONFIG, ...JSON.parse(options.body) }, changed: {} });
      return jsonResponse({}, 404);
    }));
    renderPage("/admin/pricing-logic?area=rate-review");
    await screen.findByText("No batches yet. The monthly job ranks next month's anniversaries on the 1st and emails you the batch.");
    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    fireEvent.change(screen.getByLabelText("Pass-through (%)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText(/Settings saved\./);
    expect(screen.queryByRole("button", { name: /^Approve batch/ })).not.toBeInTheDocument();
  });
});

describe("useRateReviewAvailable", () => {
  function Probe({ enabled }) {
    const state = useRateReviewAvailable(enabled);
    return <output data-testid="state">{state}</output>;
  }

  it("is on only when the server answers enabled: true; a 404 (gate off) is off; a technician never probes", async () => {
    render(<Probe enabled />);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("on"));
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Rate review is not enabled" }, 404)));
    render(<Probe enabled />);
    expect(screen.getByTestId("state")).toHaveTextContent("pending");
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("off"));
    cleanup();

    const probe = vi.fn();
    vi.stubGlobal("fetch", probe);
    render(<Probe enabled={false} />);
    expect(screen.getByTestId("state")).toHaveTextContent("off");
    expect(probe).not.toHaveBeenCalled();
  });
});
