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
  customer: { id: "cust-1", firstName: "Pat", lastName: "Synthetic", phone: "+19415550100", hasTexts: true },
  customerMessage: "Can you add mosquito service to my account?", summary: "wants mosquito", reason: "complex_question",
  assistantReply: "I will pass that to the team.",
};
const request = {
  kind: "request", id: "req-1", createdAt: "2026-10-29T15:00:00.000Z",
  customer: { id: "cust-2", firstName: "Kim", lastName: "Sample", phone: "+19415550101", hasTexts: false },
  category: "scheduling", subject: "Move my visit", description: "Please move my visit to next week.",
  requestedService: "", source: "portal", urgency: "routine", status: "new",
};

function listing(overrides = {}) {
  return { enabled: true, cutoff: "2026-10-17T12:00:00.000Z", items: [chat, request], total: 2, older: { chats: 3, requests: 2 }, ...overrides };
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

// What the two existing update routes answer when the item really closed.
function updated(url) {
  const id = url.split("/").pop();
  if (url.startsWith("/ai/admin/escalations/")) return { escalation: { id, status: "resolved" } };
  if (url.startsWith("/admin/requests/")) return { request: { id, status: "resolved" }, statusChanged: true };
  return { ok: true };
}

beforeEach(() => {
  adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing() : updated(url)));
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

  it("opens a new text to the customer's phone when there is no thread, and disables Reply with no phone", async () => {
    const noPhone = { ...request, id: "req-2", customer: { id: "cust-3", firstName: "Lee", lastName: "Example", phone: "", hasTexts: false } };
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing({ items: [request, noPhone], total: 2 }) : { ok: true }));
    mount();
    const row = (await screen.findByText("Kim Sample")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Reply by text" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/communications?phone=%2B19415550101&action=sms#tab=sms");
    const bare = screen.getByText("Lee Example").closest("[data-testid]");
    expect(within(bare).getByRole("button", { name: "Reply by text" })).toBeDisabled();
  });

  it("shows how many of the total are listed, and loads the rest once the listed rows are handled", async () => {
    const onCount = vi.fn();
    let calls = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url !== "/admin/portal-inbox") return updated(url);
      calls += 1;
      const third = { ...request, id: "req-3", customer: { id: "cust-4", firstName: "Sam", lastName: "Placeholder", phone: "+19415550104", hasTexts: false } };
      return calls === 1 ? listing({ total: 3 }) : listing({ items: [third], total: 1 });
    });
    mount(onCount);
    expect(await screen.findByText("Showing 2 of 3. The rest load as you handle these.")).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(3));
    fireEvent.click(within(screen.getByText("Pat Synthetic").closest("[data-testid]")).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Pat Synthetic")).not.toBeInTheDocument());
    fireEvent.click(within(screen.getByText("Kim Sample").closest("[data-testid]")).getByRole("button", { name: "Mark handled" }));
    expect(await screen.findByText("Sam Placeholder")).toBeInTheDocument();
    expect(calls).toBe(2);
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
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
    expect(adminFetch).toHaveBeenCalledWith("/admin/requests/req-1", { method: "PATCH", body: JSON.stringify({ status: "resolved", quiet: true }) });
  });

  it("shows the saved hand-off summary, which can hold what the last message does not (an email change)", async () => {
    const emailChange = {
      ...chat, id: "esc-9", customerMessage: "yes that's right",
      summary: "Customer confirmed a new email address: pat.new@example.com (read back and confirmed).",
      assistantReply: "Thanks Pat. I've sent this to our team.",
    };
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing({ items: [emailChange], total: 1 }) : updated(url)));
    mount();
    const row = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    expect(within(row).getByTestId("chat-summary")).toHaveTextContent("What they asked for: Customer confirmed a new email address: pat.new@example.com");
  });

  it("tracks each row's Mark handled on its own: a second click on a row still saving sends nothing", async () => {
    const onCount = vi.fn();
    let finishChat;
    adminFetch.mockImplementation((url) => {
      if (url === "/admin/portal-inbox") return Promise.resolve(listing());
      if (url.startsWith("/ai/admin/escalations/")) return new Promise((resolve) => { finishChat = () => resolve(updated(url)); });
      return Promise.resolve(updated(url));
    });
    mount(onCount);
    const chatRow = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    fireEvent.click(within(chatRow).getByRole("button", { name: "Mark handled" }));
    const requestRow = screen.getByText("Kim Sample").closest("[data-testid]");
    fireEvent.click(within(requestRow).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Kim Sample")).not.toBeInTheDocument());
    expect(within(chatRow).getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.click(within(chatRow).getByRole("button", { name: "Saving…" }));
    finishChat();
    await waitFor(() => expect(screen.queryByText("Pat Synthetic")).not.toBeInTheDocument());
    expect(adminFetch.mock.calls.filter(([url]) => url === "/ai/admin/escalations/esc-1")).toHaveLength(1);
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(0));
  });

  it("keeps a request whose resolve lost a race, says so, and leaves the count alone", async () => {
    const onCount = vi.fn();
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox"
      ? listing()
      : { request: { id: "req-1", status: "acknowledged" }, statusChanged: false }));
    mount(onCount);
    const row = (await screen.findByText("Kim Sample")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("This changed before you could mark it handled. It is still open.");
    expect(screen.getByText("Kim Sample")).toBeInTheDocument();
    expect(onCount).toHaveBeenLastCalledWith(2);
  });

  it("shows which saved property a request is about", async () => {
    const withHome = { ...request, property: { id: "prop-2", label: "Rental", address: "12 Example St, Bradenton", isPrimary: false } };
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing({ items: [withHome], total: 1 }) : updated(url)));
    mount();
    const row = (await screen.findByText("Kim Sample")).closest("[data-testid]");
    expect(within(row).getByTestId("request-property")).toHaveTextContent("Rental · 12 Example St, Bradenton (secondary property)");
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
    adminFetch.mockImplementation(async () => listing({ items: [], total: 0, older: { chats: 0, requests: 0 } }));
    mount();
    expect(await screen.findByText(/Nothing open/)).toBeInTheDocument();
    expect(screen.queryByText(/Older than 14 days/)).not.toBeInTheDocument();
  });
});
