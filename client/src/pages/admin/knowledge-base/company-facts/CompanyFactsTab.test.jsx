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
  approved_at: null,
  retired_at: null,
  retire_reason: null,
  ...over,
});

// Routes the page calls; `state` decides each answer, the mock records every request.
function serve(state) {
  adminFetch.mockImplementation(async (path, options = {}) => {
    const method = options.method || "GET";
    const url = new URL(path, "http://x");
    if (method === "GET" && url.pathname === "/admin/company-facts") {
      const status = url.searchParams.get("status");
      const page = state.pages?.[status]?.[url.searchParams.get("cursor") || "first"] || { facts: [], nextCursor: null };
      return { ...page, viewer: { ownerActions: state.owner } };
    }
    if (method === "GET" && url.pathname.endsWith("/history")) return { events: state.events || [] };
    const failure = state.fail?.[`${method} ${url.pathname.split("/").pop()}`];
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
    expect(bodies("/approve")[0]).toMatchObject({ acknowledgeWarnings: true });
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
});
