// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";

// GATE_SMS_LIKE (owner 2026-11-02, "SMS Like Button"): the like button under
// the customer's newest text, and like lines, in the Messages thread.
vi.mock("react-router-dom", async (importOriginal) => ({ ...(await importOriginal()), useNavigate: () => vi.fn() }));

const THUMB = "\u{1F44D}";
const line = "+19413187612";
const phone = "+19415550100";
const sms = (id, direction, body, minute, extra = {}) => ({
  id, direction, body, isRead: true,
  from: direction === "inbound" ? phone : line,
  to: direction === "inbound" ? line : phone,
  createdAt: `2026-11-02T16:${String(minute).padStart(2, "0")}:00Z`,
  ...extra,
});
const fields = (extra = {}) => ({ officeLike: null, customerReaction: null, likeable: false, ...extra });
let log;
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tick = async (ms = 350) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const likeCalls = () => fetch.mock.calls.filter(([url]) => String(url).includes("/like"));
const likeButton = () => screen.queryByRole("button", { name: /Text a thumbs-up/ });

async function openThread(preview, route = "/") {
  render(<SmsTab active />, { wrapper: ({ children }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter> });
  await tick();
  fireEvent.click(screen.getByText(preview));
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("waves_admin_token", "synthetic-token");
  sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  log = { smsLike: true, messages: [] };
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const parsed = new URL(String(url), "http://localhost");
    if (parsed.pathname.endsWith("/log")) return response({ ...log, hasMore: false, page: 1 });
    if (parsed.pathname.endsWith("/like")) {
      return response({ success: true, officeLike: { status: "sent", by: "Adam", at: "2026-11-02T16:16:00Z" } });
    }
    if (parsed.pathname.endsWith("/blocked-numbers")) return response({ numbers: [] });
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("the customer's newest text gets a Like button that texts a thumbs-up, then shows who liked it", async () => {
  log.messages = [
    sms("in-1", "inbound", "Thanks, see you Tuesday!", 15, fields({ likeable: true })),
    sms("out-1", "outbound", "Your technician arrives Tuesday.", 2, fields()),
  ];
  await openThread("Thanks, see you Tuesday!");
  expect(likeButton()).toBeInTheDocument();

  // What the reload returns once the server sent the thumbs-up.
  log.messages = [
    sms("out-2", "outbound", THUMB, 16, fields()),
    sms("in-1", "inbound", "Thanks, see you Tuesday!", 15, fields({ likeable: true, officeLike: { status: "sent", by: "Adam", at: "2026-11-02T16:16:00Z" } })),
    log.messages[1],
  ];
  fireEvent.click(likeButton());
  await tick();

  expect(likeCalls()).toHaveLength(1);
  const [url, options] = likeCalls()[0];
  expect(String(url)).toContain("/admin/communications/messages/in-1/like");
  expect(options.method).toBe("POST");
  expect(screen.getByText(/Adam/)).toBeInTheDocument();
  expect(likeButton()).not.toBeInTheDocument();
});

it("a failed like shows the server's reason and keeps the button", async () => {
  log.messages = [sms("in-1", "inbound", "Thanks!", 15, fields({ likeable: true }))];
  fetch.mockImplementation(async (url) => {
    const parsed = new URL(String(url), "http://localhost");
    if (parsed.pathname.endsWith("/like")) return response({ error: "A newer text is in this thread. Only the newest customer text can get a like." }, 409);
    if (parsed.pathname.endsWith("/log")) return response({ ...log, hasMore: false, page: 1 });
    return response({ numbers: [] });
  });
  await openThread("Thanks!");
  fireEvent.click(likeButton());
  await tick();

  expect(screen.getByRole("alert")).toHaveTextContent("A newer text is in this thread.");
  expect(likeButton()).toBeInTheDocument();
});

it("a customer like becomes a labeled line on our quoted text; one that matches nothing stays a bubble", async () => {
  log.messages = [
    sms("r-2", "inbound", 'Liked "Something we never sent"', 4, fields({ customerReaction: { emoji: THUMB, removed: false, target: "Something we never sent" } })),
    sms("r-1", "inbound", 'Liked "Your technician arrives Tuesday."', 3, fields({ customerReaction: { emoji: THUMB, removed: false, target: "Your technician arrives Tuesday." } })),
    sms("out-1", "outbound", "Your technician arrives Tuesday.", 2, fields()),
  ];
  await openThread('Liked "Something we never sent"');

  expect(document.getElementById("sms-message-r-1")).toBeNull();
  expect(screen.getByTitle("The customer reacted to this text")).toHaveTextContent(`${THUMB} Liked \u00b7 11:03 AM`);
  expect(document.getElementById("sms-message-r-2")).toHaveTextContent('Liked "Something we never sent"');
  // The newest text is a reaction: no like button.
  expect(likeButton()).not.toBeInTheDocument();
});

it("a loud like (no customerReaction) stays a bubble; a like taken back removes its line", async () => {
  const target = "Your technician arrives Tuesday.";
  const reaction = (removed) => ({ emoji: THUMB, removed, target });
  log.messages = [
    sms("loud", "inbound", `Liked "${target}"`, 6, fields()),
    sms("r-2", "inbound", `Removed a like from "${target}"`, 5, fields({ customerReaction: reaction(true) })),
    sms("r-1", "inbound", `Liked "${target}"`, 3, fields({ customerReaction: reaction(false) })),
    sms("out-1", "outbound", target, 2, fields()),
  ];
  await openThread(`Liked "${target}"`);

  expect(document.getElementById("sms-message-loud")).toHaveTextContent(`Liked "${target}"`);
  expect(document.getElementById("sms-message-r-1")).toBeNull();
  expect(document.getElementById("sms-message-r-2")).toBeNull();
  expect(screen.queryByTitle("The customer reacted to this text")).toBeNull();
});

it("keeps the like button through an Unanswered refresh that combines loaded pages", async () => {
  const pageOne = [sms("in-1", "inbound", "Thanks, see you Tuesday!", 15, fields({ likeable: true, responseNeedsResponse: true }))];
  const pageTwo = [sms("out-0", "outbound", "An older text", 1, fields())];
  fetch.mockImplementation(async (url) => {
    const parsed = new URL(String(url), "http://localhost");
    if (parsed.pathname.endsWith("/log")) {
      const page = Number(parsed.searchParams.get("page") || 1);
      return response({ smsLike: true, messages: page === 1 ? pageOne : pageTwo, hasMore: page === 1, page });
    }
    return response({ numbers: [] });
  });
  await openThread("Thanks, see you Tuesday!", "/?needsResponse=true");
  fireEvent.click(screen.getByRole("button", { name: "Load older SMS history" }));
  await tick();
  expect(likeButton()).toBeInTheDocument();

  // The 30-second refresh re-reads both loaded pages and combines them.
  await tick(30000);
  expect(likeButton()).toBeInTheDocument();
});

it("gate off: no Like button, and a customer like stays its own bubble", async () => {
  log = {
    messages: [
      sms("r-1", "inbound", 'Liked "Your technician arrives Tuesday."', 3),
      sms("out-1", "outbound", "Your technician arrives Tuesday.", 2),
    ],
  };
  await openThread('Liked "Your technician arrives Tuesday."');

  expect(document.getElementById("sms-message-r-1")).toHaveTextContent('Liked "Your technician arrives Tuesday."');
  expect(screen.queryByTitle("The customer reacted to this text")).not.toBeInTheDocument();
  expect(likeButton()).not.toBeInTheDocument();
});
