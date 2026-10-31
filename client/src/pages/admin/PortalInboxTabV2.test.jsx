// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "../../utils/admin-fetch";
import PortalInboxTabV2 from "./PortalInboxTabV2";

vi.mock("../../utils/admin-fetch", () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const chat = {
  kind: "chat", id: "esc-1", createdAt: "2026-10-30T15:00:00.000Z",
  customer: { id: "cust-1", firstName: "Pat", lastName: "Synthetic" },
  customerMessage: "Can you add mosquito service to my account?", summary: "wants mosquito", reason: "complex_question",
  assistantReply: "I will pass that to the team.",
};
const request = {
  kind: "request", id: "req-1", createdAt: "2026-10-29T15:00:00.000Z",
  customer: { id: "cust-2", firstName: "Kim", lastName: "Sample" },
  category: "scheduling", subject: "Move my visit", description: "Please move my visit to next week.",
  requestedService: "", source: "portal", urgency: "routine", status: "new",
};

function listing(overrides = {}) {
  return { enabled: true, cutoff: "2026-10-17T12:00:00.000Z", items: [chat, request], older: { chats: 3, requests: 2 }, ...overrides };
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function mount(onCount) {
  render(
    <MemoryRouter initialEntries={["/admin/communications#tab=portal"]}>
      <Routes>
        <Route path="*" element={<><PortalInboxTabV2 onCount={onCount} /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing() : { ok: true }));
});

describe("Portal inbox tab", () => {
  it("shows each open item with its kind, customer, quoted words and the assistant reply", async () => {
    const onCount = vi.fn();
    mount(onCount);
    const chatRow = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    expect(within(chatRow).getByText("Chat")).toBeInTheDocument();
    expect(within(chatRow).getByText(/Can you add mosquito service/)).toBeInTheDocument();
    expect(within(chatRow).getByText(/I will pass that to the team\./)).toBeInTheDocument();
    const requestRow = screen.getByText("Kim Sample").closest("[data-testid]");
    expect(within(requestRow).getByText("Request")).toBeInTheDocument();
    expect(within(requestRow).getByText("Move my visit")).toBeInTheDocument();
    expect(within(requestRow).getByText(/scheduling/)).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2));
  });

  it("opens the SMS thread or the customer from the row buttons", async () => {
    mount();
    const chatRow = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    fireEvent.click(within(chatRow).getByRole("button", { name: "Reply by text" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/communications?thread=cust-1#tab=sms");
    cleanup();
    mount();
    const row = (await screen.findByText("Kim Sample")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Open customer" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/customers?customerId=cust-2");
  });

  it("marks a chat handled through the escalation route, then drops the row and lowers the count", async () => {
    const onCount = vi.fn();
    mount(onCount);
    const row = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Pat Synthetic")).not.toBeInTheDocument());
    expect(adminFetch).toHaveBeenCalledWith("/ai/admin/escalations/esc-1", {
      method: "PUT",
      body: JSON.stringify({ status: "resolved", resolution_notes: "Handled in Communications → Portal" }),
    });
    expect(screen.getByText("Kim Sample")).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
  });

  it("marks a request handled through the request route", async () => {
    mount();
    const row = (await screen.findByText("Kim Sample")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Kim Sample")).not.toBeInTheDocument());
    expect(adminFetch).toHaveBeenCalledWith("/admin/requests/req-1", { method: "PATCH", body: JSON.stringify({ status: "resolved" }) });
  });

  it("keeps the row and shows a plain error on that row when Mark handled fails", async () => {
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return listing();
      throw new Error("HTTP 500");
    });
    mount();
    const row = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Could not mark this handled. Try again.");
    expect(screen.getByText("Pat Synthetic")).toBeInTheDocument();
    expect(screen.getByText("Kim Sample").closest("[data-testid]")).not.toHaveTextContent("Could not mark");
  });

  it("closes older items only after an inline confirm, and sends the list's cutoff", async () => {
    mount();
    expect(await screen.findByText("Older than 14 days: 3 chat hand-offs and 2 requests")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close all older" }));
    expect(screen.getByText("Close 5 items? Customers get no message.")).toBeInTheDocument();
    expect(adminFetch).not.toHaveBeenCalledWith("/admin/portal-inbox/close-older", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Customers get no message/)).not.toBeInTheDocument();

    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing() : { closed: { chats: 3, requests: 2 } }));
    fireEvent.click(screen.getByRole("button", { name: "Close all older" }));
    fireEvent.click(screen.getByRole("button", { name: "Close them" }));
    expect(await screen.findByText("Closed 5 items.")).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith("/admin/portal-inbox/close-older", {
      method: "POST",
      body: JSON.stringify({ cutoff: "2026-10-17T12:00:00.000Z" }),
    });
  });

  it("keeps the confirm open and says nothing changed when closing older fails", async () => {
    mount();
    await screen.findByText("Pat Synthetic");
    adminFetch.mockRejectedValue(new Error("HTTP 500"));
    fireEvent.click(screen.getByRole("button", { name: "Close all older" }));
    fireEvent.click(screen.getByRole("button", { name: "Close them" }));
    expect(await screen.findByText("Could not close them. Nothing changed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close them" })).toBeInTheDocument();
  });

  it("shows an empty state, and no Older line, when nothing is open", async () => {
    adminFetch.mockImplementation(async () => listing({ items: [], older: { chats: 0, requests: 0 } }));
    mount();
    expect(await screen.findByText(/Nothing open/)).toBeInTheDocument();
    expect(screen.queryByText(/Older than 14 days/)).not.toBeInTheDocument();
  });
});
