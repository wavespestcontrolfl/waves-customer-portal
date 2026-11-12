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

// A customer left the card step of an estimate our office sent (GATE_PORTAL_BOOKING_ITEMS): a bell, not a request.
const booking = {
  kind: "booking", id: "bell-1", version: "0123456789abcdef0123456789abcdef", createdAt: "2026-10-31T15:00:00.000Z",
  customer: { id: "cust-7", firstName: "Jo", lastName: "Visitor", phone: "+19415550107", hasTexts: false },
  service: "Mosquito Control", estimateId: "est-7",
};
// An estimate card step with no customer on file: only the contact the bell carries.
const cardStep = {
  kind: "booking", id: "bell-2", version: "fedcba9876543210fedcba9876543210", createdAt: "2026-10-30T15:00:00.000Z",
  customer: { id: null, firstName: "Sam Walkin", lastName: "", phone: "+19415550108", hasTexts: false },
  service: "Pest Control", estimateId: "est-1",
};

const olderChat = {
  ...chat, id: "esc-old", createdAt: "2026-09-20T15:00:00.000Z",
  customer: { id: "cust-5", firstName: "Dana", lastName: "Backlog", phone: "+19415550105", hasTexts: true },
  customerMessage: "Do you treat for chinch bugs?", summary: "", assistantReply: "",
};
const olderRequest = {
  ...request, id: "req-old", createdAt: "2026-08-02T15:00:00.000Z",
  customer: { id: "cust-6", firstName: "Rey", lastName: "Archive", phone: "+19415550106", hasTexts: false },
  subject: "Gate code changed",
};

function listing(overrides = {}) {
  return {
    enabled: true, cutoff: "2026-10-17T12:00:00.000Z", items: [chat, request], olderItems: [olderChat, olderRequest],
    total: 2, older: { chats: 3, requests: 2 }, ...overrides,
  };
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
  if (url.startsWith("/admin/notifications/")) return { success: true, updated: true };
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

  it("lists older open items one by one under the Older line, with the same row actions", async () => {
    mount();
    const list = await screen.findByTestId("portal-older-list");
    const chatRow = within(list).getByText("Dana Backlog").closest("[data-testid]");
    expect(within(chatRow).getByText("Chat")).toBeInTheDocument();
    expect(within(chatRow).getByText(/Do you treat for chinch bugs/)).toBeInTheDocument();
    const requestRow = within(list).getByText("Rey Archive").closest("[data-testid]");
    expect(within(requestRow).getByText("Gate code changed")).toBeInTheDocument();
    // Recent rows stay in their own list.
    expect(within(list).queryByText("Pat Synthetic")).not.toBeInTheDocument();
    // 2 of 5 older items are listed, so the tab says so.
    expect(screen.getByText("Showing 2 of 5 older items, newest first.")).toBeInTheDocument();
    fireEvent.click(within(chatRow).getByRole("button", { name: "Reply by text" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/communications?thread=cust-5#tab=sms");
    cleanup();
    mount();
    const again = within(await screen.findByTestId("portal-older-list")).getByText("Rey Archive").closest("[data-testid]");
    fireEvent.click(within(again).getByRole("button", { name: "Open customer" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/customers?customerId=cust-6");
  });

  it("marks an older row handled: the row goes, the matching older count drops, the recent total stays", async () => {
    const onCount = vi.fn();
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing({ older: { chats: 1, requests: 1 } }) : updated(url)));
    mount(onCount);
    const row = within(await screen.findByTestId("portal-older-list")).getByText("Dana Backlog").closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Dana Backlog")).not.toBeInTheDocument());
    expect(adminFetch).toHaveBeenCalledWith("/ai/admin/escalations/esc-old", {
      method: "PUT",
      body: JSON.stringify({ status: "resolved", resolution_notes: "Handled in Communications → Portal" }),
    });
    expect(screen.getByText("Older than 14 days: 0 chat hand-offs and 1 request")).toBeInTheDocument();
    expect(screen.getByText("Rey Archive")).toBeInTheDocument();
    expect(screen.getByText("Pat Synthetic")).toBeInTheDocument();
    expect(onCount).toHaveBeenLastCalledWith(2);

    fireEvent.click(within(screen.getByText("Rey Archive").closest("[data-testid]")).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Rey Archive")).not.toBeInTheDocument());
    expect(adminFetch).toHaveBeenCalledWith("/admin/requests/req-old", { method: "PATCH", body: JSON.stringify({ status: "resolved", quiet: true }) });
    // Nothing older left: the Older line goes away.
    expect(screen.queryByText(/Older than 14 days/)).not.toBeInTheDocument();
  });

  it("loads the next older rows once the listed ones are all handled (the older list is capped)", async () => {
    let lists = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url !== "/admin/portal-inbox") return updated(url);
      lists += 1;
      // First load: 1 of 2 older requests listed. Second load: the next one.
      return lists === 1
        ? listing({ olderItems: [olderRequest], older: { chats: 0, requests: 2 } })
        : listing({ olderItems: [{ ...olderRequest, id: "req-next", subject: "Next one" }], older: { chats: 0, requests: 1 } });
    });
    mount();
    const row = within(await screen.findByTestId("portal-older-list")).getByText("Rey Archive").closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    expect(await screen.findByText("Next one")).toBeInTheDocument();
    expect(lists).toBe(2);
  });

  it("keeps an older row when its resolve lost a race", async () => {
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox"
      ? listing()
      : { request: { id: "req-old", status: "acknowledged" }, statusChanged: false }));
    mount();
    const row = within(await screen.findByTestId("portal-older-list")).getByText("Rey Archive").closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("It is still open.");
    expect(screen.getByText("Rey Archive")).toBeInTheDocument();
    expect(screen.getByText("Older than 14 days: 3 chat hand-offs and 2 requests")).toBeInTheDocument();
  });

  it("Close all older clears the older rows too", async () => {
    mount();
    await screen.findByTestId("portal-older-list");
    adminFetch.mockImplementation(async () => ({ closed: { chats: 3, requests: 2 } }));
    fireEvent.click(screen.getByRole("button", { name: "Close all older" }));
    fireEvent.click(screen.getByRole("button", { name: "Close them" }));
    expect(await screen.findByText("Closed 5 items.")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-older-list")).not.toBeInTheDocument();
    expect(screen.queryByText("Dana Backlog")).not.toBeInTheDocument();
    expect(screen.queryByText("Rey Archive")).not.toBeInTheDocument();
  });

  it("treats a response with no olderItems as none (an older server)", async () => {
    adminFetch.mockImplementation(async () => {
      const { olderItems: _olderItems, ...rest } = listing();
      return rest;
    });
    mount();
    expect(await screen.findByText("Older than 14 days: 3 chat hand-offs and 2 requests")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-older-list")).not.toBeInTheDocument();
  });

  it("shows an empty state, and no Older line, when nothing is open", async () => {
    adminFetch.mockImplementation(async () => listing({ items: [], olderItems: [], total: 0, older: { chats: 0, requests: 0 } }));
    mount();
    expect(await screen.findByText(/Nothing open/)).toBeInTheDocument();
    expect(screen.queryByText(/Older than 14 days/)).not.toBeInTheDocument();
  });

  it("shows a booking item with the service, where they left, and a link to the estimate", async () => {
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing({ items: [booking, cardStep], total: 2 }) : updated(url)));
    mount();
    const pageRow = (await screen.findByText("Jo Visitor")).closest("[data-testid]");
    expect(within(pageRow).getByText("Booking not finished")).toBeInTheDocument();
    expect(within(pageRow).getByTestId("booking-service")).toHaveTextContent("Mosquito Control");
    expect(within(pageRow).getByTestId("booking-where")).toHaveTextContent("They left at the card step of an estimate without finishing.");
    expect(within(pageRow).getByRole("link", { name: "Open the estimate" })).toHaveAttribute("href", "/admin/estimates?estimateId=est-7");
    const cardRow = screen.getByText("Sam Walkin").closest("[data-testid]");
    expect(within(cardRow).getByTestId("booking-where")).toHaveTextContent("They left at the card step of an estimate without finishing.");
    expect(within(cardRow).getByRole("link", { name: "Open the estimate" })).toHaveAttribute("href", "/admin/estimates?estimateId=est-1");
    // Reply and Open customer work like the other kinds: by phone when there is no customer.
    fireEvent.click(within(cardRow).getByRole("button", { name: "Reply by text" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/communications?phone=%2B19415550108&action=sms#tab=sms");
    expect(within(cardRow).getByRole("button", { name: "Open customer" })).toBeDisabled();
  });

  it("marks a booking handled with the bell's own Done and its version, then drops the row and lowers the count", async () => {
    const onCount = vi.fn();
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing({ items: [booking, request], total: 2 }) : updated(url)));
    mount(onCount);
    const row = (await screen.findByText("Jo Visitor")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Jo Visitor")).not.toBeInTheDocument());
    expect(adminFetch).toHaveBeenCalledWith("/admin/notifications/bell-1/done", {
      method: "PUT",
      body: JSON.stringify({ version: "0123456789abcdef0123456789abcdef", resolution: "Handled in Communications → Portal" }),
    });
    expect(screen.getByText("Kim Sample")).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
  });

  it("keeps a booking whose Done lost a race (nothing updated, or the bell changed) and says so", async () => {
    const onCount = vi.fn();
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing({ items: [booking], total: 1 }) : { success: true, updated: false }));
    mount(onCount);
    const row = (await screen.findByText("Jo Visitor")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("This changed before you could mark it handled. It is still open.");
    expect(screen.getByText("Jo Visitor")).toBeInTheDocument();
    expect(onCount).toHaveBeenLastCalledWith(1);
    // The Done route answers 409 when the bell's text changed after the list loaded.
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return listing({ items: [booking], total: 1 });
      throw Object.assign(new Error("changed"), { status: 409 });
    });
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(within(row).getByRole("alert")).toHaveTextContent("This changed before you could mark it handled. It is still open."));
    expect(screen.getByText("Jo Visitor")).toBeInTheDocument();
  });

  it("counts older bookings in the Older line, lists them, and Close all older sums them", async () => {
    const olderBooking = { ...booking, id: "bell-old", createdAt: "2026-09-10T15:00:00.000Z", customer: { ...booking.customer, id: "cust-8", firstName: "Old", lastName: "Dropoff" } };
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox"
      ? listing({ olderItems: [olderBooking], older: { chats: 0, requests: 0, bookings: 2 } })
      : { closed: { chats: 0, requests: 0, bookings: 2 } }));
    mount();
    expect(await screen.findByText("Older than 14 days: 0 chat hand-offs and 0 requests and 2 bookings not finished")).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 2 older items, newest first.")).toBeInTheDocument();
    expect(within(screen.getByTestId("portal-older-list")).getByText("Old Dropoff")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close all older" }));
    expect(screen.getByText("Close 2 items? Customers get no message.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close them" }));
    expect(await screen.findByText("Closed 2 items.")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-older-list")).not.toBeInTheDocument();
  });

  it("marks an older booking handled: the row goes and the older bookings count drops", async () => {
    const olderBooking = { ...booking, id: "bell-old", createdAt: "2026-09-10T15:00:00.000Z", customer: { ...booking.customer, id: "cust-8", firstName: "Old", lastName: "Dropoff" } };
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox"
      ? listing({ olderItems: [olderBooking, { ...olderBooking, id: "bell-old-2", customer: { ...olderBooking.customer, id: "cust-9", firstName: "Other", lastName: "Dropoff" } }], older: { chats: 0, requests: 0, bookings: 3 } })
      : updated(url)));
    mount();
    const row = (await screen.findByText("Old Dropoff")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Old Dropoff")).not.toBeInTheDocument());
    expect(screen.getByText("Other Dropoff")).toBeInTheDocument();
    expect(screen.getByText("Older than 14 days: 0 chat hand-offs and 0 requests and 2 bookings not finished")).toBeInTheDocument();
  });
});

// GATE_PORTAL_MESSAGES: the server says replies are on; a customer's own portal message is an item.
const message = {
  kind: "message", id: "thread-1", throughId: "msg-9", createdAt: "2026-11-04T15:00:00.000Z",
  customer: { id: "cust-3", firstName: "Lee", lastName: "Sample", phone: "+19415550103", hasTexts: false },
  customerMessage: "Is the lawn treatment safe for my dog?", lastAnswer: "Yes, once it dries.",
};

describe("Portal inbox tab: answers in the portal", () => {
  const withReplies = (overrides = {}) => listing({ replies: true, ...overrides });

  it("shows Reply in portal only when the server says replies are on, and never on a booking", async () => {
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? listing({ items: [chat, booking] }) : updated(url)));
    mount();
    await screen.findByText("Pat Synthetic");
    expect(screen.queryByRole("button", { name: "Reply in portal" })).toBeNull();
    cleanup();
    adminFetch.mockImplementation(async (url) => (url === "/admin/portal-inbox" ? withReplies({ items: [chat, booking] }) : updated(url)));
    mount();
    const chatRow = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    expect(within(chatRow).getByRole("button", { name: "Reply in portal" })).toBeInTheDocument();
    const bookingRow = screen.getByText("Jo Visitor").closest("[data-testid]");
    expect(within(bookingRow).queryByRole("button", { name: "Reply in portal" })).toBeNull();
  });

  it("sends the answer with a request id, drops the row, lowers the count and says how the customer was told", async () => {
    const onCount = vi.fn();
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return withReplies();
      if (url === "/admin/portal-inbox/reply") return { message: { id: "m1" }, closed: true, notice: { bell: true, pushAccepted: 1, email: "not_needed" } };
      return updated(url);
    });
    mount(onCount);
    const row = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Reply in portal" }));
    const box = within(row).getByRole("textbox", { name: "Answer in the portal" });
    expect(within(row).getByRole("button", { name: "Send in portal" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "  Yes, we can add mosquito service.  " } });
    fireEvent.click(within(row).getByRole("button", { name: "Send in portal" }));
    expect(await screen.findByTestId("portal-sent-note")).toHaveTextContent("Sent to Pat Synthetic in the portal. They got a notice in the Waves app.");
    expect(screen.queryByText("Pat Synthetic")).toBeNull();
    const [, init] = adminFetch.mock.calls.find(([url]) => url === "/admin/portal-inbox/reply");
    const sentBody = JSON.parse(init.body);
    expect(sentBody).toMatchObject({ kind: "chat", id: "esc-1", body: "Yes, we can add mosquito service." });
    expect(sentBody.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
  });

  it.each([
    [{ bell: true, pushAccepted: 0, email: "sent" }, "Sent to Pat Synthetic in the portal. We emailed them your answer."],
    [{ bell: true, pushAccepted: 0, email: "failed", pending: true }, "Sent to Pat Synthetic in the portal. Their notice did not go out yet; we try again in a few minutes."],
    [{ bell: true, pushAccepted: 0, email: "email_opted_out" }, "Sent to Pat Synthetic in the portal, but we could not reach them by app or email. Reply by text too."],
  ])("says how the customer was told: %j", async (notice, line) => {
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return withReplies();
      if (url === "/admin/portal-inbox/reply") return { message: { id: "m1" }, closed: true, notice };
      return updated(url);
    });
    mount();
    const row = (await screen.findByText("Pat Synthetic")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Reply in portal" }));
    fireEvent.change(within(row).getByRole("textbox", { name: "Answer in the portal" }), { target: { value: "Answer." } });
    fireEvent.click(within(row).getByRole("button", { name: "Send in portal" }));
    expect(await screen.findByTestId("portal-sent-note")).toHaveTextContent(line);
  });

  it("keeps the text after a failure: same text, same request id; changed text, a new one; shows the server's words", async () => {
    const inactive = Object.assign(new Error("This customer cannot open the portal. Reply by text instead."), { status: 409, code: "customer_inactive" });
    let calls = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return withReplies();
      if (url === "/admin/portal-inbox/reply") {
        calls += 1;
        if (calls === 1) throw inactive;
        if (calls === 2) throw new TypeError("Failed to fetch");
        return { message: { id: "m1" }, closed: true, notice: { bell: true, pushAccepted: 0, email: "sent" } };
      }
      return updated(url);
    });
    mount();
    const row = (await screen.findByText("Kim Sample")).closest("[data-testid]");
    fireEvent.click(within(row).getByRole("button", { name: "Reply in portal" }));
    const box = within(row).getByRole("textbox", { name: "Answer in the portal" });
    fireEvent.change(box, { target: { value: "Next week works." } });
    fireEvent.click(within(row).getByRole("button", { name: "Send in portal" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("This customer cannot open the portal. Reply by text instead.");
    expect(box).toHaveValue("Next week works.");
    fireEvent.click(within(row).getByRole("button", { name: "Send in portal" }));
    expect(await within(row).findByText("Could not send. Try again.")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "Next Tuesday works." } });
    fireEvent.click(within(row).getByRole("button", { name: "Send in portal" }));
    await screen.findByTestId("portal-sent-note");
    const ids = adminFetch.mock.calls.filter(([url]) => url === "/admin/portal-inbox/reply").map(([, init]) => JSON.parse(init.body).requestId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("shows a portal message with the customer's words and the last answer, and opens the whole thread", async () => {
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return withReplies({ items: [message], total: 1 });
      if (url === "/admin/portal-inbox/messages/thread-1") {
        return { messages: [
          { id: "msg-8", direction: "outbound", body: "Yes, once it dries.", createdAt: "2026-11-03T15:00:00.000Z", adminUserId: "admin-1" },
          { id: "msg-9", direction: "inbound", body: "Is the lawn treatment safe for my dog?\nShe is a puppy.", createdAt: "2026-11-04T15:00:00.000Z", adminUserId: null },
        ], hasMore: true };
      }
      if (url.startsWith("/admin/portal-inbox/messages/thread-1?before=")) {
        return { messages: [{ id: "msg-1", direction: "inbound", body: "First question.", createdAt: "2026-10-01T15:00:00.000Z", adminUserId: null }], hasMore: false };
      }
      return updated(url);
    });
    mount();
    const row = (await screen.findByText("Lee Sample")).closest("[data-testid]");
    expect(within(row).getByText("Message")).toBeInTheDocument();
    expect(within(row).getByText(/Is the lawn treatment safe for my dog\?/)).toBeInTheDocument();
    expect(within(row).getByText(/Yes, once it dries\./)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Show whole thread" }));
    const thread = await within(row).findByTestId("portal-thread-thread-1");
    expect(within(thread).getByText((_, el) => el.textContent === "Is the lawn treatment safe for my dog?\nShe is a puppy." && el.children.length === 0)).toBeInTheDocument();
    fireEvent.click(within(thread).getByRole("button", { name: "Show earlier messages" }));
    expect(await within(thread).findByText("First question.")).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith(`/admin/portal-inbox/messages/thread-1?before=${encodeURIComponent("2026-11-03T15:00:00.000Z")}`);
    expect(within(thread).queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  });

  it("labels the Waves AI's answer in the item and in the whole thread, and says the item stays open", async () => {
    const answered = { ...message, aiReply: { handOff: false, body: "Yes, once it dries it is safe for pets." } };
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return withReplies({ items: [answered, { ...message, id: "thread-2", customer: { ...message.customer, id: "cust-4", firstName: "Kim", lastName: "Sample" }, aiReply: { handOff: true, body: "Thanks for your message. A member of our team will answer here after 8 AM." } }], total: 2 });
      if (url === "/admin/portal-inbox/messages/thread-1") {
        return { messages: [
          { id: "msg-9", direction: "inbound", body: "Is it safe?", createdAt: "2026-11-04T03:00:00.000Z", adminUserId: null },
          { id: "msg-10", direction: "outbound", body: "Yes, once it dries it is safe for pets.", createdAt: "2026-11-04T03:01:00.000Z", adminUserId: null, ai: true },
          { id: "msg-11", direction: "outbound", body: "Staff note.", createdAt: "2026-11-04T13:01:00.000Z", adminUserId: "admin-1" },
        ], hasMore: false };
      }
      return updated(url);
    });
    mount();
    const row = (await screen.findByText("Lee Sample")).closest("[data-testid]");
    expect(within(row).getByTestId("portal-ai-reply-thread-1")).toHaveTextContent("Waves AI answered: Yes, once it dries it is safe for pets.");
    expect(within(row).getByTestId("portal-ai-reply-thread-1")).toHaveTextContent("This item stays open until you answer or mark it handled.");
    const handOffRow = screen.getByText("Kim Sample").closest("[data-testid]");
    expect(within(handOffRow).getByTestId("portal-ai-reply-thread-2")).toHaveTextContent("Waves AI told them the team will answer after 8 AM.");
    fireEvent.click(within(row).getByRole("button", { name: "Show whole thread" }));
    const thread = await within(row).findByTestId("portal-thread-thread-1");
    expect(within(thread).getByText(/^Waves AI · /)).toBeInTheDocument();
    expect(within(thread).getByText(/^Waves · /)).toBeInTheDocument();
    expect(within(thread).getByText(/^Customer · /)).toBeInTheDocument();
  });

  it("marks a portal message handled through the message it showed; a newer message reloads the row with its words", async () => {
    let open = true;
    let listed = message;
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return withReplies({ items: [listed], total: 1 });
      if (url === "/admin/portal-inbox/messages/thread-1/handled") return { handled: true, open };
      return updated(url);
    });
    mount();
    await screen.findByText("Lee Sample");
    // The customer writes again after the list loaded.
    listed = { ...message, throughId: "msg-10", customerMessage: "Also, can you come Friday?" };
    const row = () => screen.getByTestId("portal-row-message-thread-1");
    fireEvent.click(within(row()).getByRole("button", { name: "Mark handled" }));
    expect(await screen.findByText("They wrote again after this. Their new words are shown now.")).toBeInTheDocument();
    expect(await screen.findByText(/Also, can you come Friday\?/)).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith("/admin/portal-inbox/messages/thread-1/handled", { method: "POST", body: JSON.stringify({ throughId: "msg-9" }) });
    // The next Mark handled covers the new message.
    open = false;
    fireEvent.click(within(row()).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(screen.queryByText("Lee Sample")).toBeNull());
    expect(adminFetch).toHaveBeenLastCalledWith("/admin/portal-inbox/messages/thread-1/handled", { method: "POST", body: JSON.stringify({ throughId: "msg-10" }) });
  });

  it("counts older portal messages in the Older line, and Close all older sums them", async () => {
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/portal-inbox") return withReplies({ olderItems: [], older: { chats: 1, requests: 0, messages: 2 } });
      if (url === "/admin/portal-inbox/close-older") return { closed: { chats: 1, requests: 0, messages: 2 } };
      return updated(url);
    });
    mount();
    expect(await screen.findByText(/Older than 14 days: 1 chat hand-off and 0 requests and 2 portal messages/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close all older" }));
    expect(screen.getByText("Close 3 items? Customers get no message.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close them" }));
    expect(await screen.findByText("Closed 3 items.")).toBeInTheDocument();
  });
});
