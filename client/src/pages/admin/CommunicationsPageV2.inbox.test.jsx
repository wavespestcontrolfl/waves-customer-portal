// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";
import { SMS_DRAFT_STORAGE_KEY } from "../../hooks/useSmsDraft";

vi.mock("../../utils/imageCompression", async (original) => ({ ...await original(), fitImagesToBudget: async (files) => ({ ok: true, files }) }));
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => mockNavigate };
});

const line = "+19413187612";
const inbound = (id, body, phone = "+19415550100") => ({
  id, from: phone, to: line, direction: "inbound", body, isRead: true,
  createdAt: "2024-07-01T12:00:00Z",
});
let messages, failLog, failStats, hasMore, loadLog;
const attachment = { url: "https://example.invalid/gate.png", key: "fixture/gate", fileName: "gate.png", size: 4, mimeType: "image/png", attachmentToken: "fixture-token" };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tick = async (ms = 350) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const logRequests = () => fetch.mock.calls.filter(([url]) => String(url).includes("/communications/log?"));
const setup = (route = "/") => render(<SmsTab active />, { wrapper: ({ children }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter> });
const setupWithOwner = (id, props = {}) => render(<MemoryRouter><Routes><Route element={<Outlet context={{ user: { id, role: "admin" } }} />}><Route path="*" element={<SmsTab active {...props} />} /></Route></Routes></MemoryRouter>);
const savedApproval = {
  msgBody: "Edited approval reply", fromNumber: "+19415550199", selectedCustomerId: "customer-a",
  threadLock: { contactPhone: "+19415550100", ourNumber: "+19415550199", label: "Fixture office" },
  loadedMessageDraft: { id: "approval-a", draftResponse: "Original reply", recipientPhone: "+19415550100", fromNumber: "+19415550199" },
};
const saveDraft = (owner, draft) => sessionStorage.setItem(SMS_DRAFT_STORAGE_KEY, JSON.stringify({ owners: { [owner]: { "9415550100": draft } } }));

beforeEach(() => {
  vi.useFakeTimers();
  mockNavigate.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("waves_admin_token", "synthetic-token");
  sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = () => "blob:fixture-preview";
    static revokeObjectURL = vi.fn();
  });
  messages = [inbound("a", "Please check the gate")];
  failLog = false; failStats = false; hasMore = false; loadLog = null;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const parsed = new URL(String(url), "http://localhost");
    if (parsed.pathname.endsWith("/log")) {
      if (loadLog) return loadLog(parsed);
      return failLog ? response({ error: "Unavailable" }, 503) : response({ messages, hasMore, page: Number(parsed.searchParams.get("page")) });
    }
    if (parsed.pathname.endsWith("/blocked-numbers")) return response({ numbers: [] });
    if (parsed.pathname.endsWith("/stats")) return failStats ? response({ error: "Unavailable" }, 503) : response({});
    if (parsed.pathname.endsWith("/attach")) return response({ attachments: [attachment] });
    if (parsed.pathname.endsWith("/sms")) return response({ sent: true, providerMessageId: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    if (parsed.pathname.endsWith("/drafts/approval-a")) return response({ id: "approval-a", draftResponse: "Original reply", recipientPhone: "+19415550100", customerPhone: "+19415550100", customerId: "customer-a", resolvedFromNumber: "+19415550199" });
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

it("shows a recoverable load error instead of an empty inbox", async () => {
  failLog = true;
  setup(); await tick();
  expect(screen.getByRole("alert")).toHaveTextContent("Messages could not be refreshed");
  expect(screen.queryByText("No conversations found.")).not.toBeInTheDocument();
  failLog = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" })); await tick();
  expect(screen.getByText("Please check the gate")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("retains messages on a failed refresh and recovers with new messages", async () => {
  setup(); await tick();
  failLog = true; await tick(30000);
  expect(screen.getByText("Please check the gate")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("last successful load");
  failLog = false; messages = [...messages, inbound("b", "Another request", "+19415550101")];
  await tick(30000);
  expect(screen.getByText("Another request")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("pauses polling while hidden or on another channel and refreshes on return", async () => {
  const view = setup(); await tick();
  const initialCalls = logRequests().length;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await tick(60000);
  expect(logRequests()).toHaveLength(initialCalls);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  fireEvent(document, new Event("visibilitychange")); await tick();
  expect(logRequests()).toHaveLength(initialCalls + 1);
  view.rerender(<SmsTab active={false} />); await tick(60000);
  expect(logRequests()).toHaveLength(initialCalls + 1);
  view.rerender(<SmsTab active />); await tick();
  expect(logRequests()).toHaveLength(initialCalls + 2);
});

it("polls messages without repeating statistics and blocklist queries", async () => {
  setup(); await tick();
  const callsTo = (path) => fetch.mock.calls.filter(([url]) => String(url).endsWith(path));
  await tick(90000);
  fireEvent(document, new Event("visibilitychange")); await tick();
  expect(logRequests()).toHaveLength(5);
  expect(callsTo("/stats")).toHaveLength(1);
  expect(callsTo("/blocked-numbers")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh messages" })); await tick();
  expect(callsTo("/stats")).toHaveLength(2);
  expect(callsTo("/blocked-numbers")).toHaveLength(2);
});

it("keeps an active statistics filter available to clear after its refresh fails", async () => {
  setup(); await tick();
  fireEvent.click(screen.getByRole("button", { name: /Sent This Month/ }));
  expect(screen.queryByText("Please check the gate")).not.toBeInTheDocument();
  failStats = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh messages" })); await tick();
  expect(screen.getByRole("alert")).toHaveTextContent("Activity counts are unavailable");
  fireEvent.click(screen.getByRole("button", { name: /Sent This Month/ }));
  expect(screen.getByText("Please check the gate")).toBeInTheDocument();
});

it("requires a recipient before composing text, media, or a scheduled send", async () => {
  const { container } = setup(); await tick();
  expect(screen.getByRole("textbox", { name: "Text message" })).toBeDisabled();
  expect(container.querySelector('input[type="file"]')).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "+19415550100" } });
  expect(screen.getByRole("textbox", { name: "Text message" })).toBeEnabled();
  expect(container.querySelector('input[type="file"]')).toBeEnabled();
});

it("keeps refreshed arrivals first in the log and uses the latest inbound for AI Draft", async () => {
  setup(); await tick();
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  messages = [{ ...inbound("new", "The gate is now open"), createdAt: "2024-07-01T12:02:00Z" }, ...messages];
  await tick(30000);
  fireEvent.click(screen.getByRole("button", { name: "Log View" }));
  const latest = screen.getByText("The gate is now open");
  const older = screen.getByText("Please check the gate");
  expect(latest.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "AI Draft", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/ai-draft"));
  expect(JSON.parse(request[1].body)).toMatchObject({ lastMessage: "The gate is now open" });
});

it("updates the open conversation when a delivery receipt changes without a new message", async () => {
  messages.push({ id: "reply", direction: "outbound", from: line, to: "+19415550100", body: "We will check", status: "sent", messageType: "manual", createdAt: "2024-07-01T12:01:00Z" });
  setup(); await tick();
  fireEvent.click(screen.getByText("We will check")); await tick();
  expect(screen.getByText("Sent to carrier")).toBeInTheDocument();
  messages = messages.map((message) => message.id === "reply" ? { ...message, status: "undelivered" } : message);
  await tick(30000);
  expect(screen.getByText("Undelivered")).toBeInTheDocument();
});

it("does not replace a newer search with a delayed previous result", async () => {
  setup(); await tick();
  let resolveOld;
  loadLog = (url) => url.searchParams.get("search") === "old"
    ? new Promise((resolve) => { resolveOld = resolve; })
    : response({ messages: [inbound("new", "Current search result")], page: 1 });
  const search = screen.getByPlaceholderText("Search all SMS by name, phone, or message text…");
  fireEvent.change(search, { target: { value: "old" } }); await tick();
  fireEvent.change(search, { target: { value: "new" } }); await tick();
  await act(async () => resolveOld(response({ messages: [inbound("old", "Stale result")], page: 1 })));
  expect(screen.getByText("Current search result")).toBeInTheDocument();
  expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
});

it("keeps older history but restarts pagination so refreshed pages cannot be skipped", async () => {
  loadLog = (url) => response({ messages: [inbound(url.searchParams.get("page"), `Page ${url.searchParams.get("page")}`, `+1941555010${url.searchParams.get("page")}`)], hasMore: true, page: Number(url.searchParams.get("page")) });
  setup(); await tick();
  fireEvent.click(screen.getByRole("button", { name: /Load older/ })); await tick();
  expect(screen.getByText("Page 2")).toBeInTheDocument();
  loadLog = (url) => response({ messages: [inbound(`fresh-${url.searchParams.get("page")}`, `Fresh page ${url.searchParams.get("page")}`, `+1941555020${url.searchParams.get("page")}`)], hasMore: true, page: Number(url.searchParams.get("page")) });
  await tick(30000);
  expect(screen.getByText("Page 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Load older/ })); await tick();
  expect(screen.getByText("Fresh page 2")).toBeInTheDocument();
  expect(new URL(String(logRequests().at(-1)[0]), "http://localhost").searchParams.get("page")).toBe("2");
});

it("loads and paginates the server needs-response filter, then restores the ordinary inbox", async () => {
  let pendingAvailable = true;
  loadLog = (url) => {
    const page = Number(url.searchParams.get("page"));
    if (url.searchParams.get("needsResponse") === "true") {
      return response({
        messages: pendingAvailable ? [inbound(`pending-${page}`, `Pending question ${page}`, `+1941555010${page}`)] : [],
        hasMore: pendingAvailable && page === 1,
        page,
      });
    }
    return response({ messages: [inbound("recent", "Recent ordinary message")], hasMore: false, page });
  };
  setup("/admin/communications?needsResponse=true"); await tick();
  const filter = screen.getByRole("combobox", { name: "Filter conversations" });
  expect(filter).toHaveValue("unanswered");
  expect(new URL(String(logRequests().at(-1)[0]), "http://localhost").searchParams.get("needsResponse")).toBe("true");
  expect(screen.getByText("Pending question 1")).toBeInTheDocument();
  expect(screen.queryByText("Recent ordinary message")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Load older/ })); await tick();
  const paged = new URL(String(logRequests().at(-1)[0]), "http://localhost");
  expect(paged.searchParams.get("needsResponse")).toBe("true");
  expect(paged.searchParams.get("page")).toBe("2");
  expect(screen.getByText("Pending question 2")).toBeInTheDocument();

  fireEvent.click(screen.getByText("Pending question 1"));
  expect(screen.queryByRole("combobox", { name: "Filter conversations" })).not.toBeInTheDocument();
  pendingAvailable = false;
  await tick(30000);
  expect(new URL(String(logRequests().at(-1)[0]), "http://localhost").searchParams.get("needsResponse")).toBe("true");
  expect(screen.getByRole("combobox", { name: "Filter conversations" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "all" } }); await tick();
  expect(new URL(String(logRequests().at(-1)[0]), "http://localhost").searchParams.has("needsResponse")).toBe(false);
  expect(screen.getByText("Recent ordinary message")).toBeInTheDocument();
});

it("updates the mounted inbox when badge navigation changes the route", async () => {
  render(<MemoryRouter initialEntries={["/admin/communications"]}>
    <Link to="/admin/communications?needsResponse=true">Pending badge</Link>
    <SmsTab active />
  </MemoryRouter>);
  await tick();
  fireEvent.click(screen.getByRole("link", { name: "Pending badge" })); await tick();
  expect(screen.getByRole("combobox", { name: "Filter conversations" })).toHaveValue("unanswered");
  expect(new URL(String(logRequests().at(-1)[0]), "http://localhost").searchParams.get("needsResponse")).toBe("true");
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "all" } }); await tick();
  expect(new URL(String(logRequests().at(-1)[0]), "http://localhost").searchParams.has("needsResponse")).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: "Pending badge" })); await tick();
  expect(screen.getByRole("combobox", { name: "Filter conversations" })).toHaveValue("unanswered");
  expect(new URL(String(logRequests().at(-1)[0]), "http://localhost").searchParams.get("needsResponse")).toBe("true");
});

it("restores the ordinary dataset when Log View hides the unanswered selector", async () => {
  loadLog = (url) => url.searchParams.get("needsResponse") === "true"
    ? response({ messages: [inbound("pending", "Pending filtered question")], page: 1 })
    : response({ messages: [inbound("ordinary", "Ordinary log message")], page: 1 });
  setup(); await tick();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "unanswered" } }); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Log View" })); await tick();
  expect(new URL(String(logRequests().at(-1)[0]), "http://localhost").searchParams.has("needsResponse")).toBe(false);
  expect(screen.getByText("Ordinary log message")).toBeInTheDocument();
});

it("refreshes loaded unanswered pages without discarding a still-pending page-two thread", async () => {
  let pageTwoPending = true;
  let pageTwoFailure = false;
  loadLog = (url) => {
    const page = Number(url.searchParams.get("page"));
    if (page === 2 && pageTwoFailure) return response({ error: "Unavailable" }, 503);
    return response({
      messages: page === 2 && !pageTwoPending
        ? []
        : [inbound(`pending-${page}`, `Pending page ${page}`, `+1941555010${page}`)],
      hasMore: page === 1 && pageTwoPending,
      page,
    });
  };
  setup(); await tick();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "unanswered" } }); await tick();
  fireEvent.click(screen.getByRole("button", { name: /Load older/ })); await tick();
  fireEvent.click(screen.getByText("Pending page 2"));
  await tick(30000);
  expect(logRequests().slice(-2).map(([url]) => new URL(String(url), "http://localhost").searchParams.get("page"))).toEqual(["1", "2"]);
  expect(screen.getAllByText("Pending page 2").length).toBeGreaterThan(0);
  expect(screen.queryByRole("combobox", { name: "Filter conversations" })).not.toBeInTheDocument();

  pageTwoFailure = true;
  await tick(30000);
  expect(screen.getAllByText("Pending page 2").length).toBeGreaterThan(0);

  pageTwoFailure = false;
  pageTwoPending = false;
  await tick(30000);
  expect(screen.queryByText("Pending page 2")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Filter conversations" })).toBeInTheDocument();
});

it("closes an answered open thread after a complete loaded-page refresh even when older pages remain", async () => {
  let answered = false;
  loadLog = (url) => {
    const page = Number(url.searchParams.get("page"));
    if (url.searchParams.get("needsResponse") !== "true") {
      return response({ messages: [inbound("ordinary", "Ordinary message")], hasMore: false, page });
    }
    if (url.searchParams.has("phone")) {
      return response({ messages: [], hasMore: false, page });
    }
    return response({
      messages: answered
        ? [{ ...inbound("other", "Another pending question", "+19415550101"), responseNeedsResponse: true }]
        : [{ ...inbound("selected", "Selected pending question"), responseNeedsResponse: true }],
      hasMore: true,
      page,
    });
  };
  setup(); await tick();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "unanswered" } }); await tick();
  fireEvent.click(screen.getByText("Selected pending question"));
  expect(screen.queryByRole("combobox", { name: "Filter conversations" })).not.toBeInTheDocument();

  answered = true;
  await tick(30000);

  expect(screen.queryByText("Selected pending question")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Filter conversations" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Load older/ })).toBeInTheDocument();
});

it("keeps an open pending thread when a newer peer pushes it beyond the loaded prefix", async () => {
  let shifted = false;
  loadLog = (url) => {
    const page = Number(url.searchParams.get("page"));
    const phone = url.searchParams.get("phone");
    if (url.searchParams.get("needsResponse") !== "true") {
      return response({ messages: [inbound("ordinary", "Ordinary message")], hasMore: false, page });
    }
    if (phone) {
      return response({
        messages: [{ ...inbound("selected", "Selected pending question refreshed"), responseNeedsResponse: true }],
        hasMore: false,
        page,
      });
    }
    return response({
      messages: shifted
        ? [{ ...inbound("newer", "Newer pending peer", "+19415550101"), responseNeedsResponse: true }]
        : [{ ...inbound("selected", "Selected pending question"), responseNeedsResponse: true }],
      hasMore: true,
      page,
    });
  };
  setup(); await tick();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "unanswered" } }); await tick();
  fireEvent.change(screen.getByPlaceholderText("Search all SMS by name, phone, or message text…"), { target: { value: "selected" } }); await tick();
  fireEvent.click(screen.getByText("Selected pending question"));

  shifted = true;
  await tick(30000);

  expect(screen.getAllByText("Selected pending question refreshed").length).toBeGreaterThan(0);
  expect(screen.queryByRole("combobox", { name: "Filter conversations" })).not.toBeInTheDocument();
  const targeted = logRequests().map(([url]) => new URL(String(url), "http://localhost"))
    .find((url) => url.searchParams.has("phone"));
  expect(targeted.searchParams.get("phone")).toBe("+19415550100");
  expect(targeted.searchParams.get("needsResponse")).toBe("true");
  expect(targeted.searchParams.get("search")).toBe("selected");
});

it("keeps stale open-thread state and shows a recoverable error when peer confirmation fails", async () => {
  let shifted = false;
  loadLog = (url) => {
    const page = Number(url.searchParams.get("page"));
    if (url.searchParams.get("needsResponse") !== "true") {
      return response({ messages: [inbound("ordinary", "Ordinary message")], hasMore: false, page });
    }
    if (url.searchParams.has("phone")) return response({ error: "Unavailable" }, 503);
    return response({
      messages: shifted
        ? [{ ...inbound("newer", "Newer pending peer", "+19415550101"), responseNeedsResponse: true }]
        : [{ ...inbound("selected", "Selected pending question"), responseNeedsResponse: true }],
      hasMore: true,
      page,
    });
  };
  setup(); await tick();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "unanswered" } }); await tick();
  fireEvent.click(screen.getByText("Selected pending question"));

  shifted = true;
  await tick(30000);

  expect(screen.getAllByText("Selected pending question").length).toBeGreaterThan(0);
  expect(screen.queryByRole("combobox", { name: "Filter conversations" })).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("last successful load");
});

it("refreshes every loaded unanswered page after a successful send", async () => {
  loadLog = (url) => {
    const page = Number(url.searchParams.get("page"));
    return response({
      messages: [{
        ...inbound(`pending-${page}`, `Pending page ${page}`, `+1941555010${page}`),
        responseNeedsResponse: true,
      }],
      hasMore: page < 3,
      page,
    });
  };
  setup(); await tick();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "unanswered" } }); await tick();
  fireEvent.click(screen.getByRole("button", { name: /Load older/ })); await tick();
  fireEvent.click(screen.getByText("Pending page 2"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "We can help" } });
  const beforeSend = logRequests().length;

  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();

  const refreshedPages = logRequests().slice(beforeSend)
    .map(([url]) => new URL(String(url), "http://localhost").searchParams.get("page"));
  expect(refreshedPages).toEqual(["1", "2"]);
});

it("restarts an unanswered search at page one after paginating another query", async () => {
  loadLog = (url) => {
    const page = Number(url.searchParams.get("page"));
    return response({
      messages: [inbound(`pending-${page}`, `Pending page ${page}`, `+1941555010${page}`)],
      hasMore: page === 1,
      page,
    });
  };
  setup(); await tick();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations" }), { target: { value: "unanswered" } }); await tick();
  fireEvent.click(screen.getByRole("button", { name: /Load older/ })); await tick();

  fireEvent.change(screen.getByPlaceholderText("Search all SMS by name, phone, or message text…"), { target: { value: "gate" } });
  await tick();

  const searched = logRequests()
    .map(([url]) => new URL(String(url), "http://localhost"))
    .filter((url) => url.searchParams.get("search") === "gate");
  expect(searched).toHaveLength(1);
  expect(searched[0].searchParams.get("page")).toBe("1");
});

it("restores each conversation's own text and attachments when switching customers", async () => {
  messages.push(inbound("b", "Please check the lawn", "+19415550101"));
  const { container } = setup(); await tick();
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  const field = screen.getByRole("textbox", { name: "Text message" });
  fireEvent.change(field, { target: { value: "Gate reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Override" }));
  const sender = screen.getByRole("combobox", { name: "Send from" });
  const chosenLine = [...sender.options].find((option) => option.value && option.value !== line).value;
  fireEvent.change(sender, { target: { value: chosenLine } });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [new File(["test"], "gate.png", { type: "image/png" })] } });
  await tick();
  expect(screen.getByRole("button", { name: "Remove gate.png" })).toBeInTheDocument();
  fireEvent.click(screen.getByText("Please check the lawn"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(field).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Remove gate.png" })).not.toBeInTheDocument();
  fireEvent.change(field, { target: { value: "Lawn reply" } });
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(field).toHaveValue("Gate reply");
  expect(sender).toHaveValue(chosenLine);
  expect(screen.getByRole("button", { name: "Remove gate.png" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ to: "+19415550100", body: "Gate reply", replyToMessageId: "a", mediaUrls: [attachment.url] });
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(field).toHaveValue("");
  fireEvent.click(screen.getByText("Please check the lawn"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(field).toHaveValue("Lawn reply");
});

it("does not carry a reply target into a manually changed recipient", async () => {
  setup(); await tick();
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "Gate reply" } });
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "+19415550102" } });
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "New recipient reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ to: "+19415550102", body: "New recipient reply" });
  expect(JSON.parse(request[1].body)).not.toHaveProperty("replyToMessageId");
});

it.each(["text", "media"])("keeps a saved %s draft's sender and reply target together across lines", async (content) => {
  messages = [
    { ...inbound("request-a", "Request on original line"), messageType: "inbound" },
    { ...inbound("applicant-b", "Reply on recruiting line"), to: "+19412972606", messageType: "job_applicant_reply", createdAt: "2024-07-01T12:01:00Z" },
  ];
  const { container } = setup(); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Log View" }));
  fireEvent.click(screen.getByText("Request on original line"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  if (content === "text") fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "Keep this draft" } });
  else {
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [new File(["test"], "gate.png", { type: "image/png" })] } });
    await tick();
  }
  fireEvent.click(screen.getByText("Request on original line"));
  fireEvent.click(screen.getByText("Reply on recruiting line"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(screen.getByText(/Saved draft kept on its original sending number and reply target/)).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Send from" })).toHaveValue(line);
  if (content === "text") expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Keep this draft");
  else expect(screen.getByRole("button", { name: "Remove gate.png" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ fromNumber: line, replyToMessageId: "request-a" });
});

it("replies to a historical phone without attaching the customer's changed phone identity", async () => {
  messages = [{
    ...inbound("old-phone-question", "Question from the original phone"),
    customerId: null, customerName: "Ada Changed", responseNeedsResponse: true,
  }];
  setup("/admin/communications?needsResponse=true"); await tick();
  fireEvent.click(screen.getByText("Question from the original phone"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "Confirmed." } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  const payload = JSON.parse(request[1].body);
  expect(payload).toMatchObject({ to: "+19415550100", fromNumber: line, replyToMessageId: "old-phone-question" });
  expect(payload).not.toHaveProperty("customerId");
});

it("replies to the outstanding request on its own line after newer recruiting activity", async () => {
  messages = [
    { ...inbound("request-a", "Need help"), messageType: "inbound", customerId: "customer-a" },
    { ...inbound("applicant-b", "Applicant reply"), to: "+19412972606", messageType: "job_applicant_reply", customerId: "customer-a", createdAt: "2024-07-01T12:01:00Z" },
  ];
  const { container } = setup(); await tick();
  fireEvent.change(container.querySelector("#sms-thread-filter"), { target: { value: "unanswered" } });
  fireEvent.click(screen.getByText("Applicant reply"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(screen.getByRole("combobox", { name: "Send from" })).toHaveValue(line);
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "We can help" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ fromNumber: line, to: "+19415550100", customerId: "customer-a", replyToMessageId: "request-a" });
});

it.each([false, true])("restores edited approvals with sender and approval authority (draft deep link: %s)", async (deepLink) => {
  const owner = `approval-owner-${deepLink}`;
  saveDraft(owner, savedApproval);
  window.history.replaceState({}, "", `/?phone=9415550100${deepLink ? "&draftId=approval-a" : ""}`);
  setupWithOwner(owner); await tick();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Edited approval reply");
  expect(screen.getByRole("combobox", { name: "Send from" })).toHaveValue("+19415550199");
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/drafts/approval-a/revise"));
  expect(request).toBeTruthy();
  expect(JSON.parse(request[1].body)).toEqual({ revisedResponse: "Edited approval reply", fromNumber: "+19415550199" });
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/communications/sms"))).toBe(false);
});

it("restores a contract link with the customer and send metadata that own it", async () => {
  const owner = "contract-draft-owner";
  const url = "https://example.invalid/contract/fixture";
  saveDraft(owner, { ...savedApproval, loadedMessageDraft: null, msgBody: `Please sign\n\n${url}`, insertedCustomerLinks: { contract: { url, recipientKey: "9415550100", customerId: "customer-a", contractId: "contract-a", immediateOnly: true } } });
  window.history.replaceState({}, "", "/?phone=9415550100");
  setupWithOwner(owner); await tick();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue(`Please sign\n\n${url}`);
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ customerId: "customer-a", contractId: "contract-a", fromNumber: "+19415550199", body: `Please sign\n\n${url}` });
});

it("keeps a fixed customer profile separate from an inbox draft on a shared phone", async () => {
  const owner = "profile-draft-owner";
  saveDraft(owner, { ...savedApproval, loadedMessageDraft: null, selectedCustomerId: "another-customer", msgBody: "Another record's draft" });
  setupWithOwner(owner, { customer: { id: "profile-customer", phone: "+19415550100" }, customerMessages: [{ channel: "sms", contactPhone: "+19415550100", ourEndpointId: "+19415550199" }] });
  await tick();
  const field = screen.getByRole("textbox", { name: "Text message" });
  expect(field).toHaveValue("");
  fireEvent.change(field, { target: { value: "Profile reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  fireEvent.change(field, { target: { value: "Second profile reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const requests = fetch.mock.calls.filter(([url]) => String(url).endsWith("/communications/sms"));
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(JSON.parse(request[1].body)).toMatchObject({ customerId: "profile-customer", fromNumber: "+19415550199" });
});

it("keeps a manually selected sending line when entering a new recipient", async () => {
  setup(); await tick();
  const sender = screen.getByRole("combobox", { name: "Send from" });
  const chosenLine = [...sender.options].find((option) => option.value && option.value !== line).value;
  fireEvent.change(sender, { target: { value: chosenLine } });
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "+19415550108" } });
  expect(sender).toHaveValue(chosenLine);
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "New conversation" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ to: "+19415550108", fromNumber: chosenLine });
});

it.each([true, false])("preserves a recovered profile sender and its lock state (locked: %s)", async (locked) => {
  const owner = `profile-sender-${locked}`;
  const profile = { id: "profile-customer", phone: "+19415550100" };
  const chosenLine = "+19412972606";
  const profileKey = JSON.stringify([profile.id, "9415550100"]);
  sessionStorage.setItem(SMS_DRAFT_STORAGE_KEY, JSON.stringify({ owners: { [owner]: { [profileKey]: {
    msgBody: "Recovered profile reply", fromNumber: chosenLine, selectedCustomerId: profile.id,
    threadLock: locked ? { contactPhone: profile.phone, ourNumber: chosenLine, label: "Saved line" } : null,
  } } } }));
  setupWithOwner(owner, { customer: profile, customerMessages: [{ channel: "sms", contactPhone: profile.phone, ourEndpointId: line }] });
  await tick();
  const sender = screen.getByRole("combobox", { name: "Send from" });
  expect(sender).toHaveValue(chosenLine);
  expect(sender.disabled).toBe(locked);
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Recovered profile reply");
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ fromNumber: chosenLine, customerId: profile.id });
});

it("keeps a manual profile sender override when newer history arrives", async () => {
  const profile = { id: "manual-profile", phone: "+19415550100" };
  const history = [{ channel: "sms", contactPhone: profile.phone, ourEndpointId: line }];
  const view = render(<SmsTab active customer={profile} customerMessages={history} />, { wrapper: MemoryRouter });
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Override" }));
  const sender = screen.getByRole("combobox", { name: "Send from" });
  const chosenLine = [...sender.options].find((option) => option.value && option.value !== line).value;
  fireEvent.change(sender, { target: { value: chosenLine } });
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "Keep my sender" } });
  view.rerender(<SmsTab active customer={profile} customerMessages={[{ ...history[0], ourEndpointId: "+19415550197" }, ...history]} />);
  expect(sender).toHaveValue(chosenLine);
  expect(sender).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ fromNumber: chosenLine, body: "Keep my sender" });
});

it("requires an explicit sender for a new message without a saved line", async () => {
  setup(); await tick();
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "+19415550101" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "New conversation" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
  expect(screen.getByText("Choose a sending number before sending this message.")).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/communications/sms"))).toHaveLength(0);
});

it.each([line, "+19412972606"])("keeps recovered sender, reply target, and override state on a call-log deep link from %s", async (queryLine) => {
  const owner = `call-log-draft-${queryLine}`;
  saveDraft(owner, { msgBody: "Saved reply", fromNumber: line, threadLock: null, attachments: [attachment], replyContext: { messageId: "a", messageType: "inbound", phone: "9415550100", customerId: null } });
  window.history.replaceState({}, "", `/?phone=%2B19415550100&fromNumber=${encodeURIComponent(queryLine)}`);
  setupWithOwner(owner); await tick();
  const sender = screen.getByRole("combobox", { name: "Send from" });
  expect(sender).toHaveValue(line);
  expect(sender).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Saved reply");
  expect(screen.getByRole("button", { name: "Remove gate.png" })).toBeInTheDocument();
  if (queryLine !== line) expect(screen.getByText(/Saved draft kept on its original sending number and reply target/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ fromNumber: line, replyToMessageId: "a", mediaUrls: [attachment.url] });
});

it.each([23, 24])("checks restored attachment expiry at send time (%s hours old)", async (ageHours) => {
  const owner = `attachment-owner-${ageHours}`;
  const media = { ...attachment, key: `sms-attachments/${Date.now() - ageHours * 60 * 60 * 1000}-fixture-gate.png` };
  saveDraft(owner, { msgBody: "Gate photo", fromNumber: line, attachments: [media] });
  window.history.replaceState({}, "", "/?phone=9415550100");
  setupWithOwner(owner); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const smsRequests = () => fetch.mock.calls.filter(([url]) => String(url).endsWith("/communications/sms"));
  if (ageHours === 23) {
    expect(smsRequests()).toHaveLength(1);
    expect(JSON.parse(smsRequests()[0][1].body).mediaUrls).toEqual([media.url]);
    return;
  }
  expect(smsRequests()).toHaveLength(0);
  expect(screen.getByText("An attachment has expired. Remove it and attach it again before sending.")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Gate photo");
  fireEvent.click(screen.getByRole("button", { name: "Remove gate.png" }));
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  expect(smsRequests()).toHaveLength(1);
  expect(JSON.parse(smsRequests()[0][1].body).body).toBe("Gate photo");
});


it("keeps a recovered draft bound to its customer when another customer shares the phone", async () => {
  const owner = "shared-phone-customer-owner";
  saveDraft(owner, { msgBody: "Reply for property A", fromNumber: line, selectedCustomerId: "customer-a", attachments: [attachment], replyContext: { messageId: "request-a", phone: "9415550100", customerId: "customer-a" } });
  const originalFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => String(url).includes("/admin/customers?")
    ? response({ customers: [{ id: "customer-b", first_name: "Property", last_name: "B", phone: "+19415550100" }] }) : originalFetch(url, options));
  setupWithOwner(owner); await tick();
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "Property" } }); await tick();
  fireEvent.click(screen.getByText("Property B")); await tick();
  expect(screen.getByText(/Saved draft kept with its original customer/)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Reply for property A");
  expect(screen.getByRole("button", { name: "Remove gate.png" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ customerId: "customer-a", replyToMessageId: "request-a", mediaUrls: [attachment.url] });
});

it("drops an unverifiable recovered agent selection while retaining the editable reply", async () => {
  const owner = "failed-agent-lookup-owner";
  saveDraft(owner, { msgBody: "My edited reply", fromNumber: line, selectedAgentDraft: { decisionId: "stale-decision", suggestedMessage: "Original suggestion" } });
  const originalFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => String(url).includes("/communications/agent-draft?")
    ? response({ error: "Unavailable" }, 503) : originalFetch(url, options));
  setupWithOwner(owner); await tick();
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "+19415550100" } }); await tick();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("My edited reply");
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).not.toHaveProperty("agentDecisionId");
  expect(JSON.parse(request[1].body)).toMatchObject({ body: "My edited reply", fromNumber: line });
});


it("discards an Agent Review selection before sending a fresh message", async () => {
  const owner = "discard-agent-draft-owner";
  const selectedAgentDraft = { decisionId: "decision-a", suggestedMessage: "Agent suggestion" };
  saveDraft(owner, { msgBody: selectedAgentDraft.suggestedMessage, fromNumber: line, selectedAgentDraft });
  window.history.replaceState({}, "", "/?phone=9415550100");
  const originalFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => String(url).includes("/communications/agent-draft?")
    ? response({ draft: selectedAgentDraft }) : originalFetch(url, options));
  setupWithOwner(owner); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Discard agent draft" }));
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "Fresh reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ body: "Fresh reply" });
  expect(JSON.parse(request[1].body)).not.toHaveProperty("agentDecisionId");
});


it("leaves a recovered approval and clears its metadata before composing a fresh message", async () => {
  const owner = "discard-approval-owner";
  saveDraft(owner, { ...savedApproval, attachments: [attachment], replyContext: { messageId: "old-reply", phone: "9415550100", customerId: "customer-a" }, sendTiming: "tomorrow", insertedCustomerLinks: { contract: { url: "https://example.invalid/contract", contractId: "old-contract" } } });
  window.history.replaceState({}, "", "/?phone=9415550100&draftId=approval-a");
  const view = setupWithOwner(owner); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Leave approval draft" })); await tick();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Remove gate.png" })).not.toBeInTheDocument();
  expect(window.location.search).not.toContain("draftId");
  view.unmount();
  setupWithOwner(owner); await tick();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("");
  fireEvent.change(screen.getByRole("combobox", { name: "Send from" }), { target: { value: line } });
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "Fresh reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ body: "Fresh reply" });
  expect(JSON.parse(request[1].body)).not.toHaveProperty("replyToMessageId");
  expect(JSON.parse(request[1].body)).not.toHaveProperty("contractId");
  expect(fetch.mock.calls.some(([url]) => /drafts\/approval-a\/(approve|revise)/.test(String(url)))).toBe(false);
});


it("does not restore a left approval when its pending lookup finishes", async () => {
  const owner = "discard-pending-approval-owner";
  saveDraft(owner, savedApproval);
  window.history.replaceState({}, "", "/?phone=9415550100&draftId=approval-a");
  let resolveDraft;
  const originalFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => String(url).endsWith("/drafts/approval-a")
    ? new Promise((resolve) => { resolveDraft = resolve; }) : originalFetch(url, options));
  setupWithOwner(owner); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Leave approval draft" }));
  await act(async () => resolveDraft(response({ id: "approval-a", draftResponse: "Late approval", recipientPhone: "+19415550100", resolvedFromNumber: "+19415550199" })));
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("");
});


it.each([null, { id: "another-approval", draftResponse: "Earlier approval", recipientPhone: "+19415550100", fromNumber: line }])("keeps an occupied draft intact when a different approval link opens (%s)", async (loadedMessageDraft) => {
  const owner = `occupied-approval-${loadedMessageDraft?.id || "manual"}`;
  saveDraft(owner, { msgBody: "Keep my work", fromNumber: line, selectedCustomerId: "customer-a", loadedMessageDraft, attachments: [attachment], replyContext: { messageId: "original-reply", phone: "9415550100", customerId: "customer-a" } });
  window.history.replaceState({}, "", "/?phone=9415550100&draftId=approval-a");
  setupWithOwner(owner); await tick();
  expect(screen.getByText(/Your saved draft was kept/)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Keep my work");
  expect(screen.getByRole("combobox", { name: "Send from" })).toHaveValue(line);
  expect(screen.getByRole("button", { name: "Remove gate.png" })).toBeInTheDocument();
  const stored = JSON.parse(sessionStorage.getItem(SMS_DRAFT_STORAGE_KEY)).owners[owner]["9415550100"];
  expect(stored.loadedMessageDraft).toEqual(loadedMessageDraft);
  expect(stored.replyContext.messageId).toBe("original-reply");
});

it("shows Analyze photos for an admin operator with an inbound photo on the OPEN thread", async () => {
  // canAnalyzePhotos gates the button's whole render on admin role AND at
  // least one analyzable photo in the ACTIVE thread — analyzablePhotos is
  // [] until a thread is opened (activeThread stays null on the threads
  // list), so this needs both a fixture message with media AND opening it.
  const photoPhone = "+19415550600";
  messages = [{
    id: "photo-admin-visible", from: photoPhone, to: line, direction: "inbound", body: "A photo",
    isRead: true, createdAt: "2024-07-01T12:00:00Z", customerId: "customer-visible",
    media: [{ key: "sms-media/inbound/visible", url: "https://signed.example/visible", contentType: "image/jpeg" }],
  }];
  setupWithOwner("admin-analyze-photos"); await tick();
  fireEvent.click(screen.getByText(photoPhone));
  expect(screen.getByRole("button", { name: "Analyze photos" })).toBeInTheDocument();
});

it("hides Analyze photos for an admin operator when the open thread has no inbound photos", async () => {
  setupWithOwner("admin-analyze-photos-no-photos"); await tick();
  fireEvent.click(screen.getByText("Please check the gate"));
  expect(screen.queryByRole("button", { name: "Analyze photos" })).not.toBeInTheDocument();
});

it("hides Analyze photos for a technician — the endpoint is admin-only (403 otherwise)", async () => {
  render(<MemoryRouter><Routes><Route element={<Outlet context={{ user: { id: "tech-1", role: "technician" } }} />}><Route path="*" element={<SmsTab active />} /></Route></Routes></MemoryRouter>);
  await tick();
  expect(screen.queryByRole("button", { name: "Analyze photos" })).not.toBeInTheDocument();
});

it("blocks submit when the selected photos belong to different customers", async () => {
  const photoPhone = "+19415550300";
  messages = [
    {
      id: "photo-a", from: photoPhone, to: line, direction: "inbound", body: "First customer's photo",
      isRead: true, createdAt: "2024-07-01T12:00:00Z", customerId: "customer-aaa",
      media: [{ key: "sms-media/inbound/aaa", url: "https://signed.example/aaa", contentType: "image/jpeg" }],
    },
    {
      id: "photo-b", from: photoPhone, to: line, direction: "inbound", body: "Second customer's photo",
      isRead: true, createdAt: "2024-07-01T12:05:00Z", customerId: "customer-bbb",
      media: [{ key: "sms-media/inbound/bbb", url: "https://signed.example/bbb", contentType: "image/jpeg" }],
    },
  ];
  setupWithOwner("mixed-customer-owner"); await tick();
  fireEvent.click(screen.getByText(photoPhone));
  fireEvent.click(screen.getByRole("button", { name: "Analyze photos" }));
  // photo-b (newest) starts pre-checked; check photo-a too so the selection
  // spans both customer-aaa and customer-bbb.
  const checkboxes = screen.getAllByRole("checkbox");
  expect(checkboxes).toHaveLength(2);
  fireEvent.click(checkboxes[1]);
  fireEvent.click(screen.getByRole("button", { name: "Run analysis" }));
  expect(screen.getByText("Selected photos belong to different customers — pick photos from one customer.")).toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => String(url).includes("/photo-assessments/"))).toBe(false);
});

it("blocks submit when a linked photo is mixed with an UNLINKED one (null customerId) — null is a distinct owner, not \"no opinion\"", async () => {
  const photoPhone = "+19415550700";
  messages = [
    {
      id: "photo-linked", from: photoPhone, to: line, direction: "inbound", body: "Linked customer's photo",
      isRead: true, createdAt: "2024-07-01T12:00:00Z", customerId: "customer-linked",
      media: [{ key: "sms-media/inbound/linked", url: "https://signed.example/linked", contentType: "image/jpeg" }],
    },
    {
      id: "photo-unlinked", from: photoPhone, to: line, direction: "inbound", body: "Unlinked sender's photo",
      isRead: true, createdAt: "2024-07-01T12:05:00Z", // no customerId — unlinked conversation
      media: [{ key: "sms-media/inbound/unlinked", url: "https://signed.example/unlinked", contentType: "image/jpeg" }],
    },
  ];
  setupWithOwner("linked-unlinked-owner"); await tick();
  fireEvent.click(screen.getByText(photoPhone));
  fireEvent.click(screen.getByRole("button", { name: "Analyze photos" }));
  // photo-unlinked (newest) starts pre-checked; check photo-linked too so
  // the selection spans a linked customer AND an unlinked (null) one.
  const checkboxes = screen.getAllByRole("checkbox");
  expect(checkboxes).toHaveLength(2);
  fireEvent.click(checkboxes[1]);
  fireEvent.click(screen.getByRole("button", { name: "Run analysis" }));
  expect(screen.getByText("Selected photos belong to different customers — pick photos from one customer.")).toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => String(url).includes("/photo-assessments/"))).toBe(false);
});

it("a successful Analyze photos submit navigates to the new assessment and closes the dialog", async () => {
  const photoPhone = "+19415550400";
  messages = [{
    id: "photo-solo", from: photoPhone, to: line, direction: "inbound", body: "A single photo",
    isRead: true, createdAt: "2024-07-01T12:00:00Z", customerId: "customer-solo",
    media: [{ key: "sms-media/inbound/solo", url: "https://signed.example/solo", contentType: "image/jpeg" }],
  }];
  const originalFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => String(url).includes("/photo-assessments/")
    ? response({ success: true, id: "assessment-789", type: "lawn" }, 201)
    : originalFetch(url, options));
  setupWithOwner("analyze-photos-success"); await tick();
  fireEvent.click(screen.getByText(photoPhone));
  fireEvent.click(screen.getByRole("button", { name: "Analyze photos" }));
  fireEvent.click(screen.getByRole("button", { name: "Run analysis" })); await tick();
  expect(mockNavigate).toHaveBeenCalledWith("/admin/lawn-assessments?open=lawn:assessment-789");
  expect(screen.queryByText("Analyze photos from this thread")).not.toBeInTheDocument();
});

it("a failed Analyze photos submit keeps the dialog open with the server's error and never navigates", async () => {
  const photoPhone = "+19415550500";
  messages = [{
    id: "photo-solo-2", from: photoPhone, to: line, direction: "inbound", body: "A single photo",
    isRead: true, createdAt: "2024-07-01T12:00:00Z", customerId: "customer-solo-2",
    media: [{ key: "sms-media/inbound/solo2", url: "https://signed.example/solo2", contentType: "image/jpeg" }],
  }];
  const originalFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => String(url).includes("/photo-assessments/")
    ? response({ error: "At least one photo is required" }, 400)
    : originalFetch(url, options));
  setupWithOwner("analyze-photos-failure"); await tick();
  fireEvent.click(screen.getByText(photoPhone));
  fireEvent.click(screen.getByRole("button", { name: "Analyze photos" }));
  fireEvent.click(screen.getByRole("button", { name: "Run analysis" })); await tick();
  expect(screen.getByText("At least one photo is required")).toBeInTheDocument();
  expect(screen.getByText("Analyze photos from this thread")).toBeInTheDocument();
  expect(mockNavigate).not.toHaveBeenCalled();
});

it("Analyze photos offers Tree & shrub and posts a tree_shrub assessment, then deep-links to it", async () => {
  const photoPhone = "+19415550800";
  messages = [{
    id: "photo-hedge", from: photoPhone, to: line, direction: "inbound", body: "Hedge photo",
    isRead: true, createdAt: "2024-07-01T12:00:00Z", customerId: "customer-hedge",
    media: [{ key: "sms-media/inbound/hedge", url: "https://signed.example/hedge", contentType: "image/jpeg" }],
  }];
  const originalFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => String(url).includes("/photo-assessments/")
    ? response({ success: true, id: "assessment-ts1", type: "tree_shrub" }, 201)
    : originalFetch(url, options));
  setupWithOwner("analyze-photos-tree-shrub"); await tick();
  fireEvent.click(screen.getByText(photoPhone));
  fireEvent.click(screen.getByRole("button", { name: "Analyze photos" }));
  const dialog = screen.getByRole("dialog", { name: "Analyze photos from this thread" });
  const typeSelect = within(dialog).getByDisplayValue("Lawn assessment");
  expect(within(typeSelect).getByRole("option", { name: "Tree & shrub assessment" })).toHaveValue("tree_shrub");
  fireEvent.change(typeSelect, { target: { value: "tree_shrub" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Run analysis" })); await tick();
  const [postUrl, postInit] = fetch.mock.calls.find(([url]) => String(url).includes("/photo-assessments/"));
  expect(String(postUrl)).toMatch(/\/admin\/photo-assessments\/tree_shrub$/);
  expect(JSON.parse(postInit.body).message_photos).toEqual([{ message_id: "photo-hedge", key: "sms-media/inbound/hedge" }]);
  expect(mockNavigate).toHaveBeenCalledWith("/admin/lawn-assessments?open=tree_shrub:assessment-ts1");
});
