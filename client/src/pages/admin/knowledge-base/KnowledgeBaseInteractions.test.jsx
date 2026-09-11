// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiSurface } from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";
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
    expect(screen.getByRole("dialog", { name: "Delete knowledge base entry" }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(adminFetch.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(
      `/admin/kb/${ENTRY.id}`,
      { method: "DELETE" },
    ));
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
    fireEvent.click(screen.getByRole("button", { name: "Block page" }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(
      "/admin/wiki/review/product/celsius-wg",
      { method: "POST", body: JSON.stringify({ action: "block", notes: undefined }) },
    ));
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

    expect(screen.getByRole("dialog", { name: "Block wiki page" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Review notes" }))
      .toHaveValue("Needs a source check");
    expect(adminFetch.mock.calls.filter(([, options]) => options?.method === "POST"))
      .toHaveLength(1);
  });
});
