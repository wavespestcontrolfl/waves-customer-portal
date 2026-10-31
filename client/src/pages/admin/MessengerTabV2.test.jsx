// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "../../utils/admin-fetch";
import MessengerTabV2 from "./MessengerTabV2";

vi.mock("../../utils/admin-fetch", () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));

afterEach(() => { cleanup(); vi.clearAllMocks(); window.location.hash = ""; });

const open = {
  id: "t-open", name: "Pat Synthetic", lastMessageAt: "2026-10-31T15:00:00.000Z", lastInboundAt: "2026-10-31T15:00:00.000Z",
  snippet: "Can someone call me about wasps?", unread: 2, answered: false, canReply: true,
};
const late = {
  id: "t-late", name: "Kim Sample", lastMessageAt: "2026-10-29T15:00:00.000Z", lastInboundAt: "2026-10-29T15:00:00.000Z",
  snippet: "Need a quote", unread: 0, answered: false, canReply: false,
};
const answered = {
  id: "t-done", name: "Lee Example", lastMessageAt: "2026-10-30T15:00:00.000Z", lastInboundAt: "2026-10-30T14:00:00.000Z",
  snippet: "Anytime", unread: 0, answered: true, canReply: true,
};

function detailFor(thread) {
  return {
    enabled: true,
    thread,
    messages: [
      { id: `${thread.id}-1`, direction: "inbound", body: thread.snippet, createdAt: thread.lastInboundAt, author: { type: "customer", name: thread.name } },
    ],
  };
}

let threads;
beforeEach(() => {
  threads = [open, late, answered];
  adminFetch.mockImplementation(async (url, options = {}) => {
    if (url === "/admin/messenger/threads") return { enabled: true, threads };
    const match = /^\/admin\/messenger\/threads\/([^/]+)(\/read|\/reply)?$/.exec(url);
    if (match && !match[2]) return detailFor(threads.find((t) => t.id === match[1]));
    if (match && match[2] === "/read") return { updated: 2 };
    if (match && match[2] === "/reply") return { sent: true, message: { id: "m-new" }, options };
    return {};
  });
});

describe("Messenger tab", () => {
  it("lists each thread with its name, latest words and unread count, and reports how many wait for an answer", async () => {
    const onCount = vi.fn();
    render(<MessengerTabV2 onCount={onCount} />);
    const row = await screen.findByTestId("messenger-thread-t-open");
    expect(within(row).getByText("Pat Synthetic")).toBeInTheDocument();
    expect(within(row).getByText("Can someone call me about wasps?")).toBeInTheDocument();
    expect(within(row).getByText("2 new")).toBeInTheDocument();
    expect(within(screen.getByTestId("messenger-thread-t-late")).getByText("Not answered")).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2));
  });

  it("says so when there are no threads", async () => {
    threads = [];
    render(<MessengerTabV2 />);
    expect(await screen.findByText("No Facebook messages yet.")).toBeInTheDocument();
  });

  it("opens a thread, shows its messages, and marks it read once", async () => {
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-open"));
    const detail = await screen.findByTestId("messenger-detail");
    expect(within(detail).getByText("Can someone call me about wasps?")).toBeInTheDocument();
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/messenger/threads/t-open/read", { method: "POST" }));
    await waitFor(() => expect(within(screen.getByTestId("messenger-thread-t-open")).queryByText("2 new")).not.toBeInTheDocument());
  });

  it("opens the thread named in the page link", async () => {
    window.location.hash = "#tab=messenger&thread=t-late";
    render(<MessengerTabV2 />);
    const detail = await screen.findByTestId("messenger-detail");
    expect(within(detail).getByText("Kim Sample")).toBeInTheDocument();
  });

  it("sends a reply, then reloads the thread and the list", async () => {
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-open"));
    const box = await screen.findByLabelText("Reply on Facebook");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: "  We can call at 3.  " } });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/messenger/threads/t-open/reply", { method: "POST", body: JSON.stringify({ text: "We can call at 3." }) }));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(adminFetch.mock.calls.filter(([url]) => url === "/admin/messenger/threads").length).toBeGreaterThanOrEqual(2);
  });

  it("disables Send with the reason while a reply is in flight, and sends it only once", async () => {
    let finish;
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/messenger/threads") return { enabled: true, threads };
      if (url.endsWith("/reply")) return new Promise((resolve) => { finish = () => resolve({ sent: true }); });
      if (url.endsWith("/read")) return { updated: 0 };
      return detailFor(open);
    });
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-open"));
    fireEvent.change(await screen.findByLabelText("Reply on Facebook"), { target: { value: "On our way" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const busy = await screen.findByRole("button", { name: "Sending…" });
    expect(busy).toBeDisabled();
    expect(screen.getByText("Sending to Facebook. Wait for it to finish.")).toBeInTheDocument();
    fireEvent.click(busy);
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
    expect(adminFetch.mock.calls.filter(([url]) => url.endsWith("/reply"))).toHaveLength(1);
  });

  it("shows a plain error and keeps the text when Facebook refuses the reply", async () => {
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/messenger/threads") return { enabled: true, threads };
      if (url.endsWith("/reply")) throw Object.assign(new Error("send_failed"), { status: 502 });
      if (url.endsWith("/read")) return { updated: 0 };
      return detailFor(open);
    });
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-open"));
    const box = await screen.findByLabelText("Reply on Facebook");
    fireEvent.change(box, { target: { value: "On our way" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Facebook did not accept the reply. Nothing was sent.");
    expect(box).toHaveValue("On our way");
  });

  it("outside the 24-hour window, shows the rule and a Reply in Facebook link instead of a reply box", async () => {
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-late"));
    const note = await screen.findByTestId("messenger-outside-window");
    expect(within(note).getByText("Facebook allows a reply for 24 hours after the customer's last message.")).toBeInTheDocument();
    const link = within(note).getByRole("link", { name: /Reply in Facebook/ });
    expect(link).toHaveAttribute("href", "https://business.facebook.com/latest/inbox/all");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByLabelText("Reply on Facebook")).not.toBeInTheDocument();
  });
  it("switching threads: Send stays disabled and posts nothing until the picked thread has loaded, and the draft goes only to the thread it is shown for", async () => {
    let releaseLate;
    adminFetch.mockImplementation(async (url, options = {}) => {
      if (url === "/admin/messenger/threads") return { enabled: true, threads };
      if (url === "/admin/messenger/threads/t-late") return new Promise((resolve) => { releaseLate = () => resolve(detailFor(late)); });
      if (url.endsWith("/read")) return { updated: 0 };
      if (url.endsWith("/reply")) return { sent: true, options };
      return detailFor(threads.find((t) => url.endsWith(t.id)));
    });
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-open"));
    fireEvent.change(await screen.findByLabelText("Reply on Facebook"), { target: { value: "Meant for Pat" } });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

    // Pick Kim: her thread is still loading, Pat's detail and draft are still on screen.
    fireEvent.click(screen.getByTestId("messenger-thread-t-late"));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(screen.getByLabelText("Reply on Facebook")).toBeDisabled();
    expect(screen.getByText("Loading the thread you picked. Wait for it to open.")).toBeInTheDocument();
    fireEvent.click(send);
    expect(adminFetch.mock.calls.some(([url]) => url.endsWith("/reply"))).toBe(false);

    // Kim's thread arrives: it is outside the window, so there is no composer at all for it.
    releaseLate();
    expect(await screen.findByTestId("messenger-outside-window")).toBeInTheDocument();
    expect(adminFetch.mock.calls.some(([url]) => url.endsWith("/reply"))).toBe(false);
  });

  it("ignores a thread response that arrives after another thread was picked", async () => {
    let releaseOpen;
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/messenger/threads") return { enabled: true, threads };
      if (url === "/admin/messenger/threads/t-open") return new Promise((resolve) => { releaseOpen = () => resolve(detailFor(open)); });
      if (url.endsWith("/read")) return { updated: 0 };
      return detailFor(threads.find((t) => url.endsWith(t.id)));
    });
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-open"));
    fireEvent.click(screen.getByTestId("messenger-thread-t-done"));
    const detail = await screen.findByTestId("messenger-detail");
    expect(within(detail).getByText("Lee Example")).toBeInTheDocument();
    // Pat's slow answer lands now and must not replace Lee's thread or its read mark.
    releaseOpen();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(screen.getByTestId("messenger-detail")).getByText("Lee Example")).toBeInTheDocument();
    expect(adminFetch.mock.calls.some(([url]) => url === "/admin/messenger/threads/t-open/read")).toBe(false);
  });

  it("posts the reply to the thread that is displayed", async () => {
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-done"));
    fireEvent.change(await screen.findByLabelText("Reply on Facebook"), { target: { value: "Glad to help" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/messenger/threads/t-done/reply", { method: "POST", body: JSON.stringify({ text: "Glad to help" }) }));
    expect(adminFetch.mock.calls.filter(([url]) => url.endsWith("/reply"))).toHaveLength(1);
  });

  it("says when older messages are not shown", async () => {
    adminFetch.mockImplementation(async (url) => {
      if (url === "/admin/messenger/threads") return { enabled: true, threads };
      if (url.endsWith("/read")) return { updated: 0 };
      return { ...detailFor(open), hasOlder: true };
    });
    render(<MessengerTabV2 />);
    fireEvent.click(await screen.findByTestId("messenger-thread-t-open"));
    expect(await screen.findByText("Showing the latest 500 messages.")).toBeInTheDocument();
  });
});
