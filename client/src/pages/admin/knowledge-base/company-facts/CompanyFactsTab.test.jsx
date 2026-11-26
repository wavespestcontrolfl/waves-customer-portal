// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiSurface } from "../../../../components/ui";
import { adminFetch } from "../../../../utils/admin-fetch";
import CompanyFactsTab from "./CompanyFactsTab";

vi.mock("../../../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));

const TEXT = "We service Parrish and the towns around it.";

const fact = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  topic: "Service area",
  question: null,
  fact_text: TEXT,
  status: "draft",
  check_result: { blocks: [], warnings: [], acknowledged_warnings: [] },
  owner_words: null,
  supersedes_id: null,
  created_at: "2026-11-25T15:00:00Z",
  updated_at: "2026-11-25T15:00:00.000Z",
  approved_at: null,
  retired_at: null,
  retire_reason: null,
  ...over,
});

// Routes the page calls; `state` decides each answer, the mock records every request.
function listAnswer(state, url) {
  const status = url.searchParams.get("status");
  const page = state.pages?.[status]?.[url.searchParams.get("cursor") || "first"] || { facts: [], nextCursor: null };
  return { ...page, viewer: { ownerActions: state.owner } };
}

function previewAnswer(state) {
  const approved = [...(state.pages?.approved?.first?.facts || [])].sort((a, b) => new Date(a.approved_at) - new Date(b.approved_at));
  const kept = approved.filter((f) => !state.excluded?.includes(f.id));
  const left = approved.filter((f) => state.excluded?.includes(f.id)).map((f) => f.id);
  return { lines: kept.map((f) => `- ${f.fact_text.trim()}`).join("\n"), count: kept.length, version: "v", ids: kept.map((f) => f.id), consideredIds: approved.map((f) => f.id), leftOut: state.previewLeftOut || left };
}

function readAnswer(state, method, url) {
  if (method !== "GET") return undefined;
  if (url.pathname === "/admin/company-facts") return listAnswer(state, url);
  if (url.pathname.endsWith("/history")) return { events: state.events || [] };
  if (url.pathname === "/admin/company-facts/preview") {
    if (state.previewFails) throw Object.assign(new Error("PREVIEW_UNAVAILABLE"), { status: 503, code: "PREVIEW_UNAVAILABLE" });
    return previewAnswer(state);
  }
  return state.single && /^\/admin\/company-facts\/[^/]+$/.test(url.pathname) ? { fact: state.single(), check: null } : undefined;
}

function serve(state) {
  adminFetch.mockImplementation(async (path, options = {}) => {
    const method = options.method || "GET";
    const url = new URL(path, "http://x");
    const read = readAnswer(state, method, url);
    if (read) return read;
    if (state.hold?.method === method) await state.hold.promise;
    state.onRequest?.(path, options);
    const failure = state.failWith?.(method, url.pathname) || state.fail?.[`${method} ${url.pathname.split("/").pop()}`];
    if (failure) throw Object.assign(new Error(failure.code), failure);
    return { fact: fact(), check: null };
  });
}

const bodies = (suffix) => adminFetch.mock.calls
  .filter(([path, options]) => options?.method === "POST" && path.endsWith(suffix))
  .map(([, options]) => JSON.parse(options.body));

function mount(showFeedback = vi.fn()) {
  render(<UiSurface density="comfortable"><CompanyFactsTab showFeedback={showFeedback} /></UiSurface>);
  return showFeedback;
}

describe("Company facts tab", () => {
  beforeEach(() => {
    adminFetch.mockReset();
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists drafts first, then approved (with how it will read), then retired", async () => {
    serve({
      owner: true,
      pages: {
        draft: { first: { facts: [fact()], nextCursor: null } },
        approved: { first: { facts: [
          fact({ id: "a2", topic: "Second", fact_text: "Second line.", status: "approved", approved_at: "2026-11-25T17:00:00Z" }),
          fact({ id: "a1", topic: "First", fact_text: "First line.", status: "approved", approved_at: "2026-11-25T16:00:00Z" }),
        ], nextCursor: null } },
        retired: { first: { facts: [fact({ id: "r1", topic: "Old", status: "retired", retired_at: "2026-11-25T18:00:00Z", retire_reason: "Changed our mind" })], nextCursor: null } },
      },
    });
    mount();
    expect(await screen.findByText("Service area")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    const preview = await screen.findByLabelText("How the approved facts will read");
    expect(preview.textContent).toBe("- First line.\n- Second line.");
    expect(adminFetch).toHaveBeenCalledWith("/admin/company-facts/preview");
    expect(screen.getAllByRole("button", { name: "Retire" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Retired" }));
    expect(await screen.findByText(/Changed our mind/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore as a new draft" })).toBeInTheDocument();
  });

  it("hides Approve from an admin who is not the owner account, and says why", async () => {
    serve({ owner: false, pages: { draft: { first: { facts: [fact()], nextCursor: null } } } });
    mount();
    await screen.findByText("Service area");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText("Only the owner account can approve.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("shows each hard block as a plain sentence and will not approve", async () => {
    serve({
      owner: true,
      pages: { draft: { first: { facts: [fact({ check_result: { blocks: ["number_in_fact", "safety_claim", "bank_full"], warnings: [] } })], nextCursor: null } } },
    });
    mount();
    await screen.findByText("Service area");
    expect(screen.getByText("Facts can't include numbers, prices, counts or times. Say it without the number.")).toBeInTheDocument();
    expect(screen.getByText("Don't say a treatment is safe, non-toxic or natural.")).toBeInTheDocument();
    expect(screen.getByText(/most it can hold/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("approves with the hash of the exact text on screen and no warning acknowledgement when there are none", async () => {
    const unicode = "  Café — we service Parrish 🦟  ";
    serve({ owner: true, pages: { draft: { first: { facts: [fact({ fact_text: unicode })], nextCursor: null } } } });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(bodies("/approve")).toHaveLength(1));
    const { createHash } = await import("node:crypto");
    expect(bodies("/approve")[0]).toEqual({ textSha256: createHash("sha256").update(unicode.trim()).digest("hex") });
  });

  it("needs the I checked this tick for warnings, then sends acknowledgeWarnings", async () => {
    serve({
      owner: true,
      pages: { draft: { first: { facts: [fact({ check_result: { blocks: [], warnings: [{ code: "promise_words", words: ["guarantee"] }] } })], nextCursor: null } } },
    });
    mount();
    await screen.findByText("Service area");
    expect(screen.getByText(/Uses promise or guarantee words: guarantee/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I checked this"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(bodies("/approve")).toHaveLength(1));
    expect(bodies("/approve")[0]).toMatchObject({ acknowledgeWarnings: true, reviewedWarnings: ["promise_words"] });
    expect(bodies("/approve")[0].textSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("asks for the tick when the server finds warnings the saved check did not have", async () => {
    serve({
      owner: true,
      pages: { draft: { first: { facts: [fact()], nextCursor: null } } },
      fail: { "POST approve": { code: "WARNINGS_NOT_ACKNOWLEDGED", status: 409, details: { warnings: [{ code: "price_words", words: ["free"] }] } } },
    });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Mentions price or cost words: free/)).toBeInTheDocument();
    expect(screen.getByLabelText("I checked this")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("explains a refused approve in plain words and reloads when the wording changed", async () => {
    serve({
      owner: true,
      pages: { draft: { first: { facts: [fact()], nextCursor: null } } },
      fail: { "POST approve": { code: "STALE_TEXT", status: 409 } },
    });
    mount();
    await screen.findByText("Service area");
    const listReads = () => adminFetch.mock.calls.filter(([path]) => path.startsWith("/admin/company-facts?")).length;
    const before = listReads();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/The wording changed after you opened it/)).toBeInTheDocument();
    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
  });

  it("will not retire without a reason of at least three letters", async () => {
    serve({ owner: false, pages: { approved: { first: { facts: [fact({ status: "approved", approved_at: "2026-11-25T16:00:00Z" })], nextCursor: null } } } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    const confirm = screen.getByRole("button", { name: "Retire fact" });
    expect(confirm).toBeDisabled();
    const reason = screen.getByLabelText(/Why are you retiring it/);
    fireEvent.change(reason, { target: { value: "ab " } });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: "No longer true" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(bodies("/retire")).toEqual([{ reason: "No longer true" }]));
  });

  it("loads the next page with the cursor the server gave", async () => {
    serve({
      owner: true,
      pages: { draft: {
        first: { facts: [fact()], nextCursor: "CURSOR 1/+=" },
        "CURSOR 1/+=": { facts: [fact({ id: "22222222-2222-4222-8222-222222222222", topic: "Second page" })], nextCursor: null },
      } },
    });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second page")).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith(`/admin/company-facts?status=draft&limit=25&cursor=${encodeURIComponent("CURSOR 1/+=")}`);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("adds a draft with the topic and wording, then shows it again", async () => {
    serve({ owner: true, pages: { draft: { first: { facts: [], nextCursor: null } } } });
    mount();
    expect(await screen.findByText("No drafts waiting.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add draft" }));
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "Service area" } });
    fireEvent.change(screen.getByLabelText(/The fact/), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/company-facts", { method: "POST", body: JSON.stringify({ topic: "Service area", factText: TEXT }) }));
  });

  it("shows who did what in the history, with the owner's words", async () => {
    serve({
      owner: true,
      pages: { approved: { first: { facts: [fact({ status: "approved", approved_at: "2026-11-25T16:00:00Z", owner_words: "yes, say that" })], nextCursor: null } } },
      events: [
        { id: 1, action: "drafted", actor_name: "Virginia", at: "2026-11-25T15:00:00Z", detail: {} },
        { id: 2, action: "approved", actor_name: "Adam", at: "2026-11-25T16:00:00Z", detail: { warnings: [] } },
      ],
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByLabelText("Fact history");
    expect(within(list).getByText(/Drafted/).closest("li")).toHaveTextContent("by Virginia");
    expect(within(list).getByText(/Approved/).closest("li")).toHaveTextContent("by Adam");
    expect(list).toHaveTextContent("yes, say that");
  });

  it("builds the preview from what the server serves and says when an approved fact is left out", async () => {
    serve({
      owner: true,
      excluded: ["a2"],
      pages: { approved: { first: { facts: [
        fact({ id: "a1", topic: "First", fact_text: "First line.", status: "approved", approved_at: "2026-11-25T16:00:00Z" }),
        fact({ id: "a2", topic: "Noon", fact_text: "We open at noon.", status: "approved", approved_at: "2026-11-25T17:00:00Z" }),
      ], nextCursor: null } } },
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    const preview = await screen.findByLabelText("How the approved facts will read");
    expect(preview.textContent).toBe("- First line.");
    expect(await screen.findByText(/1 approved fact is not in this list/)).toBeInTheDocument();
  });

  it("gives each draft's I checked this tick its own id, so one card's label never ticks another's", async () => {
    const warning = { blocks: [], warnings: [{ code: "price_words", words: ["free"] }] };
    serve({ owner: true, pages: { draft: { first: { facts: [
      fact({ id: "d1", topic: "One", check_result: warning }),
      fact({ id: "d2", topic: "Two", check_result: warning }),
    ], nextCursor: null } } } });
    mount();
    await screen.findByText("One");
    const boxes = screen.getAllByLabelText("I checked this");
    expect(new Set(boxes.map((box) => box.id)).size).toBe(2);
    fireEvent.click(boxes[1]);
    const [first, second] = screen.getAllByRole("button", { name: "Approve" });
    expect(first).toBeDisabled();
    expect(second).toBeEnabled();
  });

  it("drops the tick when the wording changes under it, so it never covers new text", async () => {
    const state = {
      owner: true,
      text: "We run a free inspection.",
      fail: { "POST approve": { code: "STALE_TEXT", status: 409 } },
      pages: {},
    };
    const warning = { blocks: [], warnings: [{ code: "price_words", words: ["free"] }] };
    Object.defineProperty(state.pages, "draft", { get: () => ({ first: { facts: [fact({ fact_text: state.text, check_result: warning })], nextCursor: null } }), enumerable: true });
    serve(state);
    mount();
    await screen.findByText("We run a free inspection.");
    fireEvent.click(screen.getByLabelText("I checked this"));
    state.text = "We run a free estimate.";
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("We run a free estimate.");
    expect(screen.getByLabelText("I checked this")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("edits send only the changed fields and the hash of the wording that was opened", async () => {
    const sha = "a".repeat(64);
    const patches = [];
    serve({ owner: true, pages: { draft: { first: { facts: [fact({ text_sha256: sha, question: "Where?" })], nextCursor: null } } }, onRequest: (path, options) => { if (options.method === "PATCH") patches.push(JSON.parse(options.body)); } });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Nothing has changed yet.")).toBeInTheDocument();
    expect(patches).toEqual([]);
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "Service area, renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toEqual([{ topic: "Service area, renamed", baseTextSha256: sha, baseUpdatedAt: "2026-11-25T15:00:00.000Z", expectStatus: "draft" }]));
  });

  it("starts a replacement of an approved fact with empty owner's words", async () => {
    serve({ owner: true, pages: { approved: { first: { facts: [fact({ status: "approved", approved_at: "2026-11-25T16:00:00Z", owner_words: "yes, say that" })], nextCursor: null } } } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await screen.findByText("Service area");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByLabelText(/Owner's words/)).toHaveValue("");
  });

  it("ignores a save that finishes after the admin left that tab", async () => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    serve({
      owner: true,
      hold: { method: "PATCH", promise },
      pages: {
        draft: { first: { facts: [fact()], nextCursor: null } },
        approved: { first: { facts: [fact({ id: "a1", topic: "Approved one", status: "approved", approved_at: "2026-11-25T16:00:00Z" })], nextCursor: null } },
      },
    });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await screen.findByText("Approved one");
    release();
    await waitFor(() => expect(adminFetch.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("Approved one")).toBeInTheDocument();
    expect(screen.queryByText("Service area")).not.toBeInTheDocument();
  });

  const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("keeps the edit baseline fixed when the list reloads behind an open form", async () => {
    const oldHash = "a".repeat(64);
    const live = { a: fact({ id: ID_A, topic: "Topic A", question: "Q", text_sha256: oldHash }), b: fact({ id: ID_B, topic: "Topic B" }) };
    const patches = [];
    serve({
      owner: true,
      pages: Object.defineProperty({}, "draft", { get: () => ({ first: { facts: [live.a, live.b], nextCursor: null } }), enumerable: true }),
      onRequest: (path, options) => { if (options.method === "PATCH") patches.push([path, JSON.parse(options.body)]); },
    });
    mount();
    await screen.findByText("Topic A");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    // Another admin changes A (new topic, new wording hash); a refresh from card B's action reloads the list behind A's open form.
    live.a = { ...live.a, topic: "Topic A by someone else", text_sha256: "c".repeat(64) };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(/Question it answers/), { target: { value: "New question" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1][1]).toEqual({ question: "New question", baseTextSha256: oldHash, baseUpdatedAt: "2026-11-25T15:00:00.000Z", expectStatus: "draft" });
  });

  it("recovers from a stale wording: shows the saved wording, keeps the typed text, and retries on the new hash", async () => {
    const savedNow = fact({ fact_text: "We service Parrish and Palmetto.", text_sha256: "d".repeat(64), topic: "Topic by other", updated_at: "2026-11-25T16:00:00.000Z" });
    const patches = [];
    serve({
      owner: true,
      pages: { draft: { first: { facts: [fact({ text_sha256: "a".repeat(64) })], nextCursor: null } } },
      single: () => savedNow,
      failWith: (method, path) => (method === "PATCH" && path.endsWith("11111111-1111-4111-8111-111111111111") && patches.length === 1 ? { code: "STALE_TEXT", status: 409 } : null),
      onRequest: (path, options) => { if (options.method === "PATCH") patches.push(JSON.parse(options.body)); },
    });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/The fact/), { target: { value: "My own wording of it." } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(await screen.findByText(/Someone changed this wording/)).toBeInTheDocument();
    const differs = screen.getByLabelText("Fields that differ");
    expect(differs).toHaveTextContent("Saved now: We service Parrish and Palmetto.");
    expect(differs).toHaveTextContent("Yours: My own wording of it.");
    expect(screen.getByLabelText(/The fact/)).toHaveValue("My own wording of it.");
    expect(screen.getByLabelText(/Topic/)).toHaveValue("Topic by other");
    fireEvent.click(screen.getByRole("button", { name: "Keep my version and save" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ factText: "My own wording of it.", baseTextSha256: "d".repeat(64), baseUpdatedAt: "2026-11-25T16:00:00.000Z", expectStatus: "draft" });
  });

  it("lets the owner check a draft again after the conflict is gone", async () => {
    let check = { blocks: ["duplicate_bank_line"], warnings: [] };
    const patches = [];
    serve({
      owner: true,
      pages: Object.defineProperty({}, "draft", { get: () => ({ first: { facts: [fact({ text_sha256: "a".repeat(64), check_result: check })], nextCursor: null } }), enumerable: true }),
      onRequest: (path, options) => { if (options.method === "PATCH") { patches.push(JSON.parse(options.body)); check = { blocks: [], warnings: [] }; } },
    });
    mount();
    await screen.findByText(/Another fact in the bank already says this/);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(patches).toEqual([{ baseTextSha256: "a".repeat(64), baseUpdatedAt: "2026-11-25T15:00:00.000Z", expectStatus: "draft" }]);
    expect(screen.queryByText(/Another fact in the bank/)).not.toBeInTheDocument();
  });

  it("never moves the admin or closes an edit when a slow approve finishes", async () => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    serve({
      owner: true,
      hold: { method: "POST", promise },
      pages: { draft: { first: { facts: [fact({ id: ID_A, topic: "Topic A" }), fact({ id: ID_B, topic: "Topic B" })], nextCursor: null } } },
    });
    mount();
    await screen.findByText("Topic A");
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "Half-typed topic" } });
    release();
    await waitFor(() => expect(bodies("/approve")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByLabelText(/Topic/)).toHaveValue("Half-typed topic");
    expect(screen.getByRole("button", { name: "Drafts" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not pull the admin to Approved when a slow approve finishes after they moved to Retired", async () => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    serve({
      owner: true,
      hold: { method: "POST", promise },
      pages: {
        draft: { first: { facts: [fact()], nextCursor: null } },
        retired: { first: { facts: [fact({ id: "r1", topic: "Old one", status: "retired" })], nextCursor: null } },
      },
    });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Retired" }));
    await screen.findByText("Old one");
    release();
    await waitFor(() => expect(bodies("/approve")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("button", { name: "Retired" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Old one")).toBeInTheDocument();
  });

  it("says the preview could not be loaded, and does not blame the facts", async () => {
    serve({
      owner: true,
      previewFails: true,
      pages: { approved: { first: { facts: [fact({ status: "approved", approved_at: "2026-11-25T16:00:00Z" })], nextCursor: null } } },
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    expect(await screen.findByText(/Could not load the preview/)).toBeInTheDocument();
    expect(screen.queryByText(/not in this list/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
  });

  it("keeps every loaded page, and an open editor on an older card, when another card's action refreshes the list", async () => {
    const pageOne = [fact({ id: ID_A, topic: "Topic A" })];
    const pageTwo = [fact({ id: ID_B, topic: "Topic B (page two)" })];
    const reads = [];
    serve({
      owner: true,
      pages: { draft: { first: { facts: pageOne, nextCursor: "C2" }, C2: { facts: pageTwo, nextCursor: null } } },
      onRequest: () => {},
    });
    const base = adminFetch.getMockImplementation();
    adminFetch.mockImplementation(async (path, options) => { reads.push(path); return base(path, options); });
    mount();
    await screen.findByText("Topic A");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Topic B (page two)");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "Half-typed on page two" } });
    reads.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(reads.filter((path) => path.startsWith("/admin/company-facts?"))).toHaveLength(2));
    expect(screen.getByLabelText(/Topic/)).toHaveValue("Half-typed on page two");
    expect(screen.getByText("Topic A")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("keeps the list and an open editor when a quiet refresh fails", async () => {
    let failList = false;
    serve({ owner: true, pages: { draft: { first: { facts: [fact({ id: ID_A, topic: "Topic A" }), fact({ id: ID_B, topic: "Topic B" })], nextCursor: null } } } });
    const base = adminFetch.getMockImplementation();
    adminFetch.mockImplementation(async (path, options) => {
      if (failList && path.startsWith("/admin/company-facts?")) throw Object.assign(new Error("OFFLINE"), { code: "OFFLINE", status: 503 });
      return base(path, options);
    });
    mount();
    await screen.findByText("Topic A");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "Half-typed" } });
    failList = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("The facts could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("Topic A")).toBeInTheDocument();
    expect(screen.getByLabelText(/Topic/)).toHaveValue("Half-typed");
  });

  it("keeps an open editor on a card that left the list, and says nothing was saved when the save is refused (STATUS_CHANGED)", async () => {
    const live = { facts: [fact({ id: ID_A, topic: "Topic A" })] };
    const patches = [];
    serve({
      owner: true,
      pages: Object.defineProperty({}, "draft", { get: () => ({ first: { facts: live.facts, nextCursor: null } }), enumerable: true }),
      failWith: (method) => (method === "PATCH" ? { code: "STATUS_CHANGED", status: 409 } : null),
      onRequest: (path, options) => { if (options.method === "PATCH") patches.push(JSON.parse(options.body)); },
    });
    mount();
    await screen.findByText("Topic A");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "My new topic" } });
    live.facts = []; // approved meanwhile: it is no longer a draft
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/changed state while you had it open/)).toBeInTheDocument();
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ topic: "My new topic", expectStatus: "draft" });
    expect(screen.getByLabelText(/Topic/)).toHaveValue("My new topic");
  });

  it("recovers from a changed field the same way as a changed wording (STALE_FACT)", async () => {
    const patches = [];
    serve({
      owner: true,
      pages: { draft: { first: { facts: [fact()], nextCursor: null } } },
      single: () => fact({ owner_words: "the other admin's quote", updated_at: "2026-11-25T17:00:00.000Z" }),
      failWith: (method) => (method === "PATCH" && patches.length === 1 ? { code: "STALE_FACT", status: 409 } : null),
      onRequest: (path, options) => { if (options.method === "PATCH") patches.push(JSON.parse(options.body)); },
    });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "My topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Someone changed this fact while you had it open/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Owner's words/)).toHaveValue("the other admin's quote");
    expect(screen.getByLabelText(/Topic/)).toHaveValue("My topic");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toMatchObject({ topic: "My topic", baseUpdatedAt: "2026-11-25T17:00:00.000Z" });
    expect(patches[1]).not.toHaveProperty("ownerWords");
  });

  it("reads the history again after a change moved the fact's version", async () => {
    let version = "2026-11-25T15:00:00.000Z";
    const historyReads = [];
    serve({
      owner: true,
      pages: Object.defineProperty({}, "draft", { get: () => ({ first: { facts: [fact({ updated_at: version })], nextCursor: null } }), enumerable: true }),
      onRequest: (path, options) => { if (options.method === "PATCH") version = "2026-11-25T18:00:00.000Z"; },
    });
    const base = adminFetch.getMockImplementation();
    adminFetch.mockImplementation(async (path, options) => { if (path.endsWith("/history")) historyReads.push(path); return base(path, options); });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByLabelText("Fact history");
    expect(historyReads).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(historyReads).toHaveLength(2));
  });

  it("discards only the version it showed when Discard was opened", async () => {
    let versionB = "2026-11-25T15:00:00.000Z";
    const deletes = [];
    serve({
      owner: true,
      pages: Object.defineProperty({}, "draft", { get: () => ({ first: { facts: [fact({ id: ID_A, topic: "Topic A", text_sha256: "a".repeat(64) }), fact({ id: ID_B, topic: "Topic B", updated_at: versionB, text_sha256: "b".repeat(64) })], nextCursor: null } }), enumerable: true }),
      onRequest: (path, options) => { if (options.method === "DELETE") deletes.push([path, JSON.parse(options.body)]); if (options.method === "PATCH") versionB = "2026-11-25T19:00:00.000Z"; },
    });
    mount();
    await screen.findByText("Topic B");
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[1]);
    // Another admin saves B while the confirmation is open; the list reloads behind it (card A's Check again).
    versionB = "2026-11-25T19:00:00.000Z";
    fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0]);
    await waitFor(() => expect(adminFetch.mock.calls.filter(([, o]) => o?.method === "PATCH")).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" }).at(-1));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0][1]).toEqual({ baseTextSha256: "b".repeat(64), baseUpdatedAt: "2026-11-25T15:00:00.000Z" });
  });

  it("shows a refused discard as a plain sentence and keeps the draft", async () => {
    serve({
      owner: true,
      pages: { draft: { first: { facts: [fact()], nextCursor: null } } },
      failWith: (method) => (method === "DELETE" ? { code: "STALE_FACT", status: 409 } : null),
    });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" }).at(-1));
    expect(await screen.findByText(/Someone changed this fact while you had it open/)).toBeInTheDocument();
    expect(screen.getByText("Service area")).toBeInTheDocument();
  });

  it("shows each conflicting field, saved against typed, and asks for an explicit save", async () => {
    const patches = [];
    serve({
      owner: true,
      pages: { draft: { first: { facts: [fact({ owner_words: "my first quote" })], nextCursor: null } } },
      single: () => fact({ owner_words: "the other admin's quote", updated_at: "2026-11-25T17:00:00.000Z" }),
      failWith: (method) => (method === "PATCH" && patches.length === 1 ? { code: "STALE_FACT", status: 409 } : null),
      onRequest: (path, options) => { if (options.method === "PATCH") patches.push(JSON.parse(options.body)); },
    });
    mount();
    await screen.findByText("Service area");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/Owner's words/), { target: { value: "my edited quote" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const differs = await screen.findByLabelText("Fields that differ");
    expect(differs).toHaveTextContent("Owner's words");
    expect(differs).toHaveTextContent("Saved now: the other admin's quote");
    expect(differs).toHaveTextContent("Yours: my edited quote");
    expect(screen.getByLabelText(/Owner's words/)).toHaveValue("my edited quote");
    expect(patches).toHaveLength(1); // nothing was sent again by itself
    fireEvent.click(screen.getByRole("button", { name: "Keep my version and save" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toMatchObject({ ownerWords: "my edited quote", baseUpdatedAt: "2026-11-25T17:00:00.000Z" });
  });

  const approvedFact = (over = {}) => fact({ id: ID_A, topic: "Approved A", status: "approved", approved_at: "2026-11-25T16:00:00Z", ...over });

  it("after saving a replacement of an approved fact, shows Drafts with the new draft outlined", async () => {
    serve({
      owner: true,
      pages: {
        approved: { first: { facts: [approvedFact()], nextCursor: null } },
        draft: { first: { facts: [fact({ id: "11111111-1111-4111-8111-111111111111", topic: "New replacement draft" })], nextCursor: null } },
      },
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await screen.findByText("Approved A");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/The fact/), { target: { value: "A new wording." } });
    fireEvent.click(screen.getByRole("button", { name: "Save as a new draft" }));
    const title = await screen.findByText("New replacement draft");
    expect(screen.getByRole("button", { name: "Drafts" })).toHaveAttribute("aria-pressed", "true");
    expect(title.closest("[data-highlighted]")).not.toBeNull();
  });

  it("with another editor open, stays put and offers Show it for the new draft", async () => {
    serve({
      owner: true,
      pages: {
        approved: { first: { facts: [approvedFact(), approvedFact({ id: ID_B, topic: "Approved B" })], nextCursor: null } },
        draft: { first: { facts: [fact({ id: "11111111-1111-4111-8111-111111111111", topic: "New replacement draft" })], nextCursor: null } },
      },
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await screen.findByText("Approved A");
    const edits = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(edits[1]);
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "Half-typed" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getAllByLabelText(/The fact/)[0], { target: { value: "A new wording." } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save as a new draft" })[0]);
    const show = await screen.findByRole("button", { name: "Show it" });
    expect(screen.getByRole("button", { name: "Approved" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByLabelText(/Topic/).some((box) => box.value === "Half-typed")).toBe(true);
    fireEvent.click(show);
    const title = await screen.findByText("New replacement draft");
    expect(screen.getByRole("button", { name: "Drafts" })).toHaveAttribute("aria-pressed", "true");
    expect(title.closest("[data-highlighted]")).not.toBeNull();
  });

  it("counts a fact as left out only from the preview's own read", async () => {
    serve({
      owner: true,
      previewLeftOut: [],
      pages: { approved: { first: { facts: [approvedFact(), approvedFact({ id: ID_B, topic: "Retired between reads", approved_at: "2026-11-25T17:00:00Z" })], nextCursor: null } } },
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await screen.findByLabelText("How the approved facts will read");
    expect(screen.queryByText(/not in this list/)).not.toBeInTheDocument();
  });

  it("names the facts the preview left out", async () => {
    serve({
      owner: true,
      excluded: [ID_B],
      pages: { approved: { first: { facts: [approvedFact(), approvedFact({ id: ID_B, topic: "Noon fact", approved_at: "2026-11-25T17:00:00Z" })], nextCursor: null } } },
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    expect(await screen.findByText(/1 approved fact is not in this list \(Noon fact\)/)).toBeInTheDocument();
  });

  it("lists a card kept for its editor once when Load more brings the same fact back", async () => {
    const ID_N = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ID_Z = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const book = { first: { facts: [fact({ id: ID_A, topic: "Topic Y" }), fact({ id: ID_B, topic: "Topic X" })], nextCursor: "C2" }, C2: { facts: [fact({ id: ID_Z, topic: "Topic Z" })], nextCursor: null } };
    serve({ owner: true, pages: Object.defineProperty({}, "draft", { get: () => book, enumerable: true }) });
    mount();
    await screen.findByText("Topic Y");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    // A new draft arrives: X is pushed past the first page boundary.
    book.first = { facts: [fact({ id: ID_N, topic: "Topic N" }), fact({ id: ID_A, topic: "Topic Y" })], nextCursor: "C2" };
    book.C2 = { facts: [fact({ id: ID_B, topic: "Topic X" }), fact({ id: ID_Z, topic: "Topic Z" })], nextCursor: null };
    fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0]);
    await screen.findByText("Topic N");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("Topic Z");
    expect(screen.getAllByText("Topic X")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Save changes" })).toHaveLength(1);
  });
});
