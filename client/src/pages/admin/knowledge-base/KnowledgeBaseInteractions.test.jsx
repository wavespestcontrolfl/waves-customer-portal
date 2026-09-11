// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiSurface } from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";
import AuditTab from "./AuditTab";
import BrowseTab from "./BrowseTab";
import CreateTab from "./CreateTab";
import FieldIntelligenceTab from "./FieldIntelligenceTab";

vi.mock("../../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));

const ENTRY = {
  id: "kb-1",
  title: "Rodent exclusion protocol",
  category: "protocols",
  confidence: "medium",
  status: "active",
  source: "manual",
  content: "Entry content",
  tags: ["rodent"],
  updated_at: "2026-09-01T12:00:00Z",
};

const WIKI_PAGE = {
  id: "wiki-1",
  slug: "product/celsius-wg",
  title: "Product: Celsius WG",
  review_tier: "red",
  review_status: "pending_review",
  data_point_count: 4,
  confidence: "low",
  content: "Wiki content",
  risk_flags: [],
};

const SECOND_WIKI_PAGE = {
  ...WIKI_PAGE,
  id: "wiki-2",
  slug: "condition/chinch-bugs",
  title: "Condition: Chinch bugs",
};

function surface(child) {
  return render(<UiSurface density="comfortable">{child}</UiSurface>);
}

describe("Knowledge base interactions", () => {
  beforeEach(() => {
    adminFetch.mockReset();
  });

  afterEach(cleanup);

  it("shows a failed browse read and recovers through the safe retry", async () => {
    adminFetch.mockRejectedValueOnce(new Error("offline"));
    surface(<BrowseTab showFeedback={vi.fn()} onRefresh={vi.fn()} isMobile={false} />);

    expect(await screen.findByText("Knowledge base entries could not be loaded."))
      .toBeInTheDocument();

    adminFetch.mockResolvedValueOnce({ entries: [ENTRY], total: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: /Rodent exclusion protocol/ }))
      .toBeInTheDocument();
  });

  it("requires explicit deletion confirmation and keeps cancellation side-effect free", async () => {
    adminFetch.mockImplementation(async (path, options = {}) => {
      if (path === "/admin/kb?limit=50") return { entries: [ENTRY], total: 1 };
      if (path === `/admin/kb/${ENTRY.id}` && options.method === "DELETE") {
        return { deleted: true };
      }
      return {};
    });
    surface(<BrowseTab showFeedback={vi.fn()} onRefresh={vi.fn()} isMobile={false} />);

    fireEvent.click(await screen.findByRole("button", { name: /Rodent exclusion protocol/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const deletion = screen.getByRole("dialog", { name: "Delete this knowledge base entry?" });
    expect(deletion).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(adminFetch.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete this knowledge base entry?" }))
      .getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(
      `/admin/kb/${ENTRY.id}`,
      { method: "DELETE" },
    ));
  });

  it("stacks the browse filters once an entry opens beside the list", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/kb?limit=50") return { entries: [ENTRY], total: 1 };
      return {};
    });
    surface(<BrowseTab showFeedback={vi.fn()} onRefresh={vi.fn()} isMobile={false} />);

    const search = await screen.findByLabelText("Search knowledge base");
    const filterGrid = search.closest(".grid");
    expect(filterGrid.className).toMatch(/md:grid-cols-\[minmax\(0,1fr\)/);

    fireEvent.click(screen.getByRole("button", { name: /Rodent exclusion protocol/ }));
    await screen.findByRole("button", { name: "Delete" });
    expect(filterGrid.className).not.toMatch(/md:grid-cols-\[/);
    expect(search.className).toMatch(/col-span-2/);
    expect(search.className).not.toMatch(/md:col-span-1/);
  });

  it("renders entry and wiki metadata values verbatim, as the pre-migration page did", async () => {
    const entry = { ...ENTRY, category: "customer-lifecycle", confidence: "high", status: "needs_review" };
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/kb?limit=50") return { entries: [entry], total: 1 };
      return {};
    });
    surface(<BrowseTab showFeedback={vi.fn()} onRefresh={vi.fn()} isMobile={false} />);

    const row = await screen.findByRole("button", { name: /Rodent exclusion protocol/ });
    expect(within(row).getByText("customer-lifecycle")).toBeInTheDocument();
    expect(within(row).getByText("needs_review")).toBeInTheDocument();
    expect(within(row).queryByText("Customer lifecycle")).toBeNull();

    fireEvent.click(row);
    await screen.findByRole("button", { name: "Delete" });
    // Row badge + detail badge (the category <select> option carries the
    // value too); the pre-migration page never title-cased either of them.
    expect(screen.getAllByText("customer-lifecycle").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("needs_review")).toHaveLength(2);
    expect(screen.queryByText("Needs review")).toBeNull();
    expect(screen.queryByText("Customer lifecycle")).toBeNull();
    cleanup();

    const page = { ...WIKI_PAGE, review_tier: "yellow", risk_flags: ["stale_source"] };
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/wiki/review/queue") return { pending: [page], blocked: [], recentYellow: [] };
      if (path === "/admin/wiki?limit=200") return { pages: [page] };
      return {};
    });
    surface(<FieldIntelligenceTab showFeedback={vi.fn()} isMobile={false} canReviewQueue />);
    await screen.findAllByText("Product: Celsius WG");
    expect(screen.getAllByText("YELLOW").length).toBeGreaterThan(0);
    expect(screen.getAllByText("stale source").length).toBeGreaterThan(0);
    expect(screen.queryByText("Yellow")).toBeNull();
    expect(screen.queryByText("Stale source")).toBeNull();
  });

  it("marks only the audit mode that was started as pending", async () => {
    let finishAudit;
    adminFetch.mockReturnValue(new Promise((resolve) => { finishAudit = resolve; }));
    surface(<AuditTab showFeedback={vi.fn()} onRefresh={vi.fn()} />);

    const stale = screen.getByRole("button", { name: "Audit stale & low-confidence" });
    const force = screen.getByRole("button", { name: "Audit all (force)" });
    fireEvent.click(force);

    await waitFor(() => expect(force).toHaveAttribute("aria-busy", "true"));
    expect(stale).toBeDisabled();
    expect(stale).not.toHaveAttribute("aria-busy", "true");
    expect(adminFetch).toHaveBeenCalledWith("/admin/kb/audit/run", {
      method: "POST",
      body: JSON.stringify({ maxEntries: 10, forceAll: true }),
    });

    await act(async () => { finishAudit({ audited: 0, flagged: 0, results: [] }); });
    expect(force).not.toHaveAttribute("aria-busy", "true");
  });

  it("guards create against two synchronous submissions", async () => {
    let finishRequest;
    const request = new Promise((resolve) => { finishRequest = resolve; });
    adminFetch.mockReturnValue(request);
    const onCreated = vi.fn();
    surface(<CreateTab showFeedback={vi.fn()} onCreated={onCreated} isMobile={false} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "New procedure" },
    });
    const create = screen.getByRole("button", { name: "Create entry" });
    fireEvent.click(create);
    fireEvent.click(create);

    expect(adminFetch).toHaveBeenCalledTimes(1);
    finishRequest({ id: "kb-2" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("skips the admin-only review queue for technician sessions", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/wiki?limit=200") return { pages: [WIKI_PAGE] };
      throw new Error(`unexpected request ${path}`);
    });
    surface(
      <FieldIntelligenceTab
        showFeedback={vi.fn()}
        isMobile={false}
        canRegenerate={false}
        canReviewQueue={false}
      />,
    );

    expect(await screen.findByText("Nothing needs your judgment right now.")).toBeInTheDocument();
    await screen.findByRole("button", { name: /Product: Celsius WG/ });
    expect(adminFetch.mock.calls.some(([path]) => path === "/admin/wiki/review/queue")).toBe(false);
    expect(screen.queryByText("The Field Intelligence review queue could not be loaded."))
      .not.toBeInTheDocument();
  });

  it("cancels a block without posting and omits empty review notes when confirmed", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/wiki/review/queue") {
        return { pending: [WIKI_PAGE], blocked: [], recentYellow: [] };
      }
      if (path === "/admin/wiki?limit=200") return { pages: [] };
      return {};
    });
    surface(
      <FieldIntelligenceTab
        showFeedback={vi.fn()}
        isMobile={false}
        canRegenerate
      />,
    );

    const block = await screen.findByRole("button", { name: "Block" });
    fireEvent.click(block);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(adminFetch.mock.calls.some(([path]) => path.includes("/review/product"))).toBe(false);

    fireEvent.click(block);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Block" }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(
      "/admin/wiki/review/product/celsius-wg",
      { method: "POST", body: JSON.stringify({ action: "block", notes: undefined }) },
    ));
  });

  it("marks only the in-flight action as pending and merely disables its siblings", async () => {
    let finishApproval;
    const approval = new Promise((resolve) => { finishApproval = resolve; });
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/wiki/review/queue") return { pending: [], blocked: [], recentYellow: [] };
      if (path === "/admin/wiki?limit=200") return { pages: [WIKI_PAGE] };
      if (path === `/admin/wiki/${WIKI_PAGE.slug}`) return { page: WIKI_PAGE };
      if (path === `/admin/wiki/review/${WIKI_PAGE.slug}`) return approval;
      return {};
    });
    surface(<FieldIntelligenceTab showFeedback={vi.fn()} isMobile={false} canRegenerate />);

    fireEvent.click(await screen.findByRole("button", { name: /Product: Celsius WG/ }));
    const regenerate = await screen.findByRole("button", { name: "Regenerate" });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }))
      .toHaveAttribute("aria-busy", "true"));
    expect(regenerate).toBeDisabled();
    expect(regenerate).not.toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Block" })).toBeDisabled();

    await act(async () => { finishApproval({}); });
  });

  it("keeps another page's block draft open when an earlier approval resolves", async () => {
    let finishApproval;
    const approval = new Promise((resolve) => { finishApproval = resolve; });
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/wiki/review/queue") {
        return { pending: [WIKI_PAGE, SECOND_WIKI_PAGE], blocked: [], recentYellow: [] };
      }
      if (path === "/admin/wiki?limit=200") return { pages: [] };
      if (path === `/admin/wiki/review/${WIKI_PAGE.slug}`) return approval;
      return {};
    });
    surface(
      <FieldIntelligenceTab
        showFeedback={vi.fn()}
        isMobile={false}
        canRegenerate
      />,
    );

    const approveButtons = await screen.findAllByRole("button", { name: "Approve" });
    const blockButtons = screen.getAllByRole("button", { name: "Block" });
    fireEvent.click(approveButtons[0]);
    fireEvent.click(blockButtons[1]);
    fireEvent.change(screen.getByRole("textbox", { name: "Review notes" }), {
      target: { value: "Needs a source check" },
    });

    await act(async () => finishApproval({ success: true }));

    expect(screen.getByRole("dialog", { name: "Why is this page blocked? (stored as review notes)" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Review notes" }))
      .toHaveValue("Needs a source check");
    expect(adminFetch.mock.calls.filter(([, options]) => options?.method === "POST"))
      .toHaveLength(1);
  });
});
