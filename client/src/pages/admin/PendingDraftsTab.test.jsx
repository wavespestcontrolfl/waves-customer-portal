// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();
vi.mock("../../utils/admin-fetch", () => ({
  adminFetch: (...args) => adminFetch(...args),
}));

import PendingDraftsTab from "./PendingDraftsTab";

const DRAFTS = {
  drafts: [
    {
      id: "d1",
      customerName: "Pat Customer",
      customerPhone: "+19415550100",
      recipientPhone: "+19415550100",
      inboundMessage: null,
      draftResponse: "Hi Pat, thanks for clicking through on your estimate.",
      intent: "click_followup",
      campaignType: "click_followup",
      contextSummary: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "d2",
      customerName: "Sam Owner",
      customerPhone: "+19415550101",
      recipientPhone: "+19415550101",
      inboundMessage: "What time are you coming?",
      draftResponse: "We have you down for tomorrow between 9 and 11.",
      intent: "scheduling",
      campaignType: null,
      contextSummary: null,
      createdAt: new Date().toISOString(),
    },
  ],
  pendingCount: 2,
};

describe("PendingDraftsTab", () => {
  beforeEach(() => {
    adminFetch.mockReset();
    adminFetch.mockResolvedValue(DRAFTS);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists pending drafts with lane chips and deep links", async () => {
    render(<PendingDraftsTab embedded />);
    expect(await screen.findByText("Pat Customer")).toBeInTheDocument();
    expect(screen.getByText("2 pending drafts")).toBeInTheDocument();
    expect(screen.getByText("Click follow-up")).toBeInTheDocument();
    expect(screen.getByText("Reply draft")).toBeInTheDocument();
    const links = screen.getAllByText("Open in Communications");
    expect(links[0]).toHaveAttribute("href", "/admin/communications?draftId=d1");
    expect(adminFetch).toHaveBeenCalledWith("/admin/drafts?status=pending");
  });

  it("approve confirms, PUTs, and removes the card", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    adminFetch.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getAllByText("Approve & send")[0]);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/drafts/d1/approve", { method: "PUT" }));
    await waitFor(() => expect(screen.queryByText("Pat Customer")).not.toBeInTheDocument());
    expect(screen.getByText("Sam Owner")).toBeInTheDocument();
  });

  it("a declined confirm sends nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    fireEvent.click(screen.getAllByText("Approve & send")[0]);
    expect(adminFetch).toHaveBeenCalledTimes(1); // only the initial list load
  });

  it("revise sends the edited text through /revise", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Sam Owner");
    fireEvent.click(screen.getAllByText("Revise")[1]);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Tomorrow 9-11am. See you then." } });
    adminFetch.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByText("Send revised"));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/drafts/d2/revise", {
      method: "PUT",
      body: JSON.stringify({ revisedResponse: "Tomorrow 9-11am. See you then." }),
    }));
  });

  it("a 409 (already actioned elsewhere) reloads the live queue", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    const conflict = Object.assign(new Error("Draft is no longer pending"), { status: 409 });
    adminFetch.mockRejectedValueOnce(conflict);
    adminFetch.mockResolvedValueOnce({ drafts: [], pendingCount: 0 });
    fireEvent.click(screen.getAllByText("Reject")[0]);
    await waitFor(() => expect(screen.getByText("Draft is no longer pending")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No pending drafts", { exact: false })).toBeInTheDocument());
  });

  it("empty queue renders the explainer", async () => {
    adminFetch.mockResolvedValue({ drafts: [], pendingCount: 0 });
    render(<PendingDraftsTab embedded />);
    expect(await screen.findByText("No pending drafts", { exact: false })).toBeInTheDocument();
  });
});
