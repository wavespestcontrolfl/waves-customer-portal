// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();
vi.mock("../../utils/admin-fetch", () => ({ adminFetch: (...a) => adminFetch(...a) }));

import AgentQueueTab from "./AgentQueueTab";

const QUEUE = {
  generatedAt: new Date().toISOString(),
  totals: { pending: 2, parked: 1, failed: 1 },
  lanes: [
    { key: "jobs", label: "Scheduled jobs", error: null, pending: 0, parked: 0, failed: 1, total: 1, items: [
      { id: "pricing-sweep", title: "pricing-sweep", status: "failed", detail: "3 consecutive failures — boom", at: new Date(Date.now() - 120000).toISOString() },
    ] },
    { key: "calls", label: "Call processing", error: null, pending: 2, parked: 1, failed: 0, total: 30, items: [
      { id: "c1", title: "Inbound call · +19415550100", status: "parked", detail: "stalled in processing for over 10 minutes", at: new Date().toISOString(), href: "/admin/communications#tab=calls" },
      { id: "c2", title: "Inbound call · +19415550101", status: "pending", detail: "waiting for the processor", at: new Date().toISOString() },
    ] },
    { key: "approvals", label: "Email-reply approvals", error: 'relation "content_email_approvals" does not exist', pending: 0, parked: 0, failed: 0, total: 0, items: [] },
    { key: "ib", label: "Intelligence Bar confirmations", error: null, pending: 0, parked: 0, failed: 0, total: 0, items: [] },
  ],
};

beforeEach(() => { adminFetch.mockReset(); });
afterEach(cleanup);

describe("AgentQueueTab", () => {
  it("renders totals, per-lane counts, and expands a lane to its rows", async () => {
    adminFetch.mockResolvedValue(QUEUE);
    render(<AgentQueueTab embedded />);
    await waitFor(() => expect(screen.getByText("Scheduled jobs")).toBeInTheDocument());
    expect(adminFetch).toHaveBeenCalledWith("/admin/agents/queue");

    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("1 parked")).toBeInTheDocument();
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(screen.getByText("clear")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Call processing/ }));
    expect(screen.getByText("stalled in processing for over 10 minutes")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Inbound call · +19415550100" })).toHaveAttribute("href", "/admin/communications#tab=calls");
    expect(screen.getByText("Showing 2 of 30.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Email-reply approvals/ }));
    expect(screen.getByText(/This lane could not be read/)).toBeInTheDocument();
  });

  it("shows the load error and can retry", async () => {
    adminFetch.mockRejectedValueOnce(new Error("HTTP 404")).mockResolvedValueOnce(QUEUE);
    render(<AgentQueueTab />);
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 404");
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(screen.getByText("Scheduled jobs")).toBeInTheDocument());
  });
});
