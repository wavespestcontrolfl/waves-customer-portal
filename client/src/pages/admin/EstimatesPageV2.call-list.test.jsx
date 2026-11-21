// @vitest-environment jsdom
// The estimate call list: the "Call today" and "Pick reason" filters, the
// two Needs-attention cards, the reason-only decline modal and the Call today
// outcome buttons.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EstimatesPageV2, {
  CALL_OUTCOMES_UNREAD_NOTE,
  HELD_REFRESH_INTERVAL_MS,
  HELD_REFRESH_MAX_MS,
  callOutcomeLine,
  callOutcomesUnreadNote,
  stillDecidingLine,
  useCallOutcomes,
} from "./EstimatesPageV2";

const flags = { estimates_v2_status_pills: false };

vi.mock("../../components/admin/customer360/CustomerSmsPanel", () => ({
  useCustomerSms: () => vi.fn(),
  CustomerSmsProvider: ({ children }) => children,
  openEstimateMessages: vi.fn(),
}));
vi.mock("../../hooks/useFeatureFlag", () => ({
  useFeatureFlag: (key) => !!flags[key],
}));
vi.mock("../../components/schedule/CreateAppointmentModal", () => ({
  default: () => null,
}));
vi.mock("./WinLossSlicesCard", () => ({ default: () => null }));
vi.mock("./SourcePerformanceCard", () => ({ default: () => null }));

const HOUR = 3600000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function viewed(id, name, viewedAgoMs, extra = {}) {
  return {
    id,
    token: `token-${id}`,
    status: "viewed",
    customerId: `customer-${id}`,
    customerName: name,
    customerPhone: "+19415550101",
    address: "1 Fixture Avenue",
    monthlyTotal: 40,
    createdAt: ago(viewedAgoMs + 2 * DAY),
    sentAt: ago(viewedAgoMs + DAY),
    viewedAt: ago(viewedAgoMs),
    lastViewedAt: ago(viewedAgoMs),
    serviceLines: [],
    ...extra,
  };
}

const ROWS = [
  viewed("v-1h", "Fresh View", 1 * HOUR),
  viewed("v-5h", "Five Hours", 5 * HOUR),
  viewed("v-30h", "Thirty Hours", 30 * HOUR),
  viewed("v-called", "Already Called", 6 * HOUR, { lastCalledAt: ago(HOUR) }),
  viewed("v-cold", "Gone Cold", 3 * DAY),
  {
    id: "x-1",
    token: "token-x-1",
    status: "expired",
    customerId: "customer-x-1",
    customerName: "Expired Opened",
    customerPhone: "+19415550102",
    address: "2 Fixture Avenue",
    monthlyTotal: 40,
    createdAt: ago(20 * DAY),
    sentAt: ago(15 * DAY),
    viewedAt: ago(14 * DAY),
    expiresAt: ago(3 * DAY),
    disposition: "expired_viewed",
    dispositionSource: "system",
    serviceLines: [],
  },
  {
    id: "x-old",
    token: "token-x-old",
    status: "expired",
    customerId: "customer-x-old",
    customerName: "Expired Long Ago",
    address: "3 Fixture Avenue",
    monthlyTotal: 40,
    createdAt: ago(90 * DAY),
    sentAt: ago(80 * DAY),
    viewedAt: ago(79 * DAY),
    expiresAt: ago(60 * DAY),
    disposition: "expired_viewed",
    dispositionSource: "system",
    serviceLines: [],
  },
];

function response(body) {
  return { ok: true, status: 200, json: async () => body, clone() { return this; } };
}

let patches;
let posts;
let savedOutcomes;
let listRows;
// The list route's outcome read failed: every row comes back callOutcomeUnknown, with no outcome.
let outcomesUnread;
// The draft read's rows (status=draft), merged into the page's list.
let draftRows;

// The page's current URL and a navigate function, read from inside the router.
const routerProbe = { search: null, navigate: null };
function RouterProbe() {
  routerProbe.search = useLocation().search;
  routerProbe.navigate = useNavigate();
  return null;
}

function renderPage(width = 1440, search = "?tab=estimates") {
  window.innerWidth = width;
  const tree = () => (
    <MemoryRouter initialEntries={[`/admin/pipeline${search}`]}>
      <RouterProbe />
      <EstimatesPageV2 />
    </MemoryRouter>
  );
  const view = render(tree());
  return { ...view, rerenderSame: () => view.rerender(tree()) };
}

beforeEach(() => {
  flags.estimates_v2_status_pills = false;
  patches = [];
  posts = [];
  savedOutcomes = new Map();
  listRows = ROWS;
  outcomesUnread = false;
  draftRows = [];
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init = {}) => {
      const parsed = new URL(String(url), "http://fixture.invalid");
      if (init.method === "PATCH") {
        patches.push({ path: parsed.pathname, body: JSON.parse(init.body) });
        return response({ success: true });
      }
      // A call outcome tap: the server stamps when and who; later list reads carry it.
      const outcomePath = /^\/api\/admin\/estimates\/([^/]+)\/call-outcome$/.exec(parsed.pathname);
      if (init.method === "POST" && outcomePath) {
        const body = JSON.parse(init.body);
        posts.push({ path: parsed.pathname, body });
        const callOutcome = { outcome: body.outcome, at: new Date().toISOString(), by: "Virginia" };
        savedOutcomes.set(outcomePath[1], callOutcome);
        return response({ callOutcome });
      }
      if (init.method === "POST" && parsed.pathname === "/api/admin/communications/call") {
        posts.push({ path: parsed.pathname, body: JSON.parse(init.body) });
        return response({ success: true });
      }
      if (parsed.pathname === "/api/admin/estimates") {
        if (parsed.searchParams.get("archived") === "only") return response({ estimates: [] });
        if (parsed.searchParams.get("status") === "draft") return response({ estimates: draftRows });
        const rows = outcomesUnread
          ? listRows.map((r) => ({ ...r, lastCallOutcome: null, callOutcomeUnknown: true }))
          : listRows.map((r) => (savedOutcomes.has(r.id) ? { ...r, lastCallOutcome: savedOutcomes.get(r.id) } : r));
        return response({ estimates: rows, truncated: false });
      }
      return response({ resolved: 0, drafted: 0, sources: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The pipeline's draft read runs once per load, so it counts loads.
const draftReadCount = () => globalThis.fetch.mock.calls.filter(([url, init = {}]) => {
  const parsed = new URL(String(url), "http://fixture.invalid");
  return parsed.pathname === "/api/admin/estimates" && init.method !== "PATCH" && parsed.searchParams.get("status") === "draft";
}).length;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

const rowIds = (container) =>
  Array.from(container.querySelectorAll("[data-estimate-id]")).map((n) => n.getAttribute("data-estimate-id"));

it("(desktop) the Call today card counts only the 2h-48h, uncalled viewed offers and filters oldest first", async () => {
  const { container } = renderPage();
  await screen.findByText("Fresh View");
  const card = screen.getByText("Call today").closest("button");
  expect(within(card).getByText("2")).toBeInTheDocument(); // 5h and 30h; not 1h, not called, not 3d
  fireEvent.click(card);
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  // The Call action is on those rows.
  expect(screen.getAllByRole("button", { name: /^Call .* via Waves$/ })).toHaveLength(2);
});

// The 9 AM push links to /admin/estimates?view=call_today, which redirects to /admin/pipeline?tab=estimates&view=call_today.
it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) ?view=call_today opens the list on the Call today filter, then drops view from the URL", async (_label, width) => {
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  // Taken once: a later filter change, a refresh or a return to the page is not pinned to Call today.
  expect(routerProbe.search).toBe("?tab=estimates");
});

it("(desktop) the link also works on a list that is already open", async () => {
  const { container } = renderPage(1440, "?tab=estimates");
  await screen.findByText("Fresh View");
  expect(rowIds(container)).toContain("v-1h");
  act(() => routerProbe.navigate("/admin/pipeline?tab=estimates&view=call_today"));
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  await waitFor(() => expect(routerProbe.search).toBe("?tab=estimates"));
});

// A search left on an open list would hide rows the push counted: the link clears it (and the date filter and page).
it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) the link on an open list clears a search that hid the Call today rows", async (_label, width) => {
  const { container } = renderPage(width, "?tab=estimates");
  await screen.findByText("Fresh View");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search estimates" }), { target: { value: "Fresh View" } });
  await waitFor(() => expect(rowIds(container)).toEqual(["v-1h"]));
  act(() => routerProbe.navigate("/admin/pipeline?tab=estimates&view=call_today"));
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  expect(screen.getByRole("searchbox", { name: "Search estimates" })).toHaveValue("");
  await waitFor(() => expect(routerProbe.search).toBe("?tab=estimates"));
});

// The link a list opens on is loaded by the mount's own fetch: a second load would rerun the whole pipeline batch
// (sent, draft pricing-risk and, on desktop, archived wins) for nothing. Each load reads the draft list once.
it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) a list opened by the link loads the pipeline once", async (_label, width) => {
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  await waitFor(() => expect(routerProbe.search).toBe("?tab=estimates"));
  await settle();
  expect(draftReadCount()).toBe(1);
});

// React StrictMode replays each mount effect in development (the mount fetch too, so two loads either way). The link
// a list opens on is still taken once: the same reads as a list opened without the link.
it("(desktop) under StrictMode, the link a list opens on adds no pipeline load", async () => {
  const mount = (search) => {
    window.innerWidth = 1440;
    return render(
      <React.StrictMode>
        <MemoryRouter initialEntries={[`/admin/pipeline${search}`]}>
          <RouterProbe />
          <EstimatesPageV2 />
        </MemoryRouter>
      </React.StrictMode>,
    );
  };
  const plain = mount("?tab=estimates");
  await screen.findByText("Fresh View");
  await settle();
  const plainLoads = draftReadCount();
  plain.unmount();
  globalThis.fetch.mockClear();
  const { container } = mount("?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  await waitFor(() => expect(routerProbe.search).toBe("?tab=estimates"));
  await settle();
  expect(draftReadCount()).toBe(plainLoads);
});

// With Call today already selected, a new link changes no filter: the list must still load fresh rows, or it keeps
// showing an estimate another admin has called since (or misses one viewed since).
it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) a second link on an open Call today list loads the rows fresh", async (_label, width) => {
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  await waitFor(() => expect(routerProbe.search).toBe("?tab=estimates"));
  const before = globalThis.fetch.getMockImplementation();
  globalThis.fetch.mockImplementation(async (url, init = {}) => {
    const parsed = new URL(String(url), "http://fixture.invalid");
    const listRead = parsed.pathname === "/api/admin/estimates" && init.method !== "PATCH"
      && parsed.searchParams.get("archived") !== "only" && parsed.searchParams.get("status") !== "draft";
    if (!listRead) return before(url, init);
    // Another admin called the five-hour estimate after the first load.
    return response({ estimates: ROWS.map((r) => (r.id === "v-5h" ? { ...r, lastCalledAt: new Date().toISOString() } : r)), truncated: false });
  });
  act(() => routerProbe.navigate("/admin/pipeline?tab=estimates&view=call_today"));
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h"]));
  await waitFor(() => expect(routerProbe.search).toBe("?tab=estimates"));
});

it("(mobile) the status-pills flag loading after the link keeps Call today; after the customer picks All it stays All", async () => {
  flags.estimates_v2_status_pills = false;
  const { container, rerenderSame } = renderPage(390, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  flags.estimates_v2_status_pills = true; // the flag resolves after mount
  rerenderSame();
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  fireEvent.click(screen.getByRole("button", { name: /^Filter: / }));
  fireEvent.click(await screen.findByText(/^All \(\d+\)$/));
  await waitFor(() => expect(rowIds(container)).toContain("v-1h"));
  flags.estimates_v2_status_pills = false; // a flag refetch flips it again
  rerenderSame();
  await waitFor(() => expect(rowIds(container)).toContain("v-1h"));
  expect(routerProbe.search).toBe("?tab=estimates");
});

it.each([
  ["an unknown view", "?tab=estimates&view=nope"],
  ["no view", "?tab=estimates"],
])("(desktop) %s leaves the list on its default filter", async (_label, search) => {
  const { container } = renderPage(1440, search);
  await screen.findByText("Fresh View");
  expect(rowIds(container)).toContain("v-1h");
  expect(rowIds(container)).toContain("v-cold");
});

it("(desktop) Pick reason lists recently expired opened offers and saves a reason without a status", async () => {
  const { container } = renderPage();
  await screen.findByText("Fresh View");
  const card = screen.getByText("Pick reason", { selector: "div" }).closest("button");
  expect(within(card).getByText("1")).toBeInTheDocument(); // not the 60-day-old one
  fireEvent.click(card);
  await waitFor(() => expect(rowIds(container)).toEqual(["x-1"]));

  fireEvent.click(screen.getByRole("button", { name: "Pick reason" }));
  fireEvent.click(await screen.findByLabelText("Too expensive"));
  fireEvent.click(screen.getByRole("button", { name: "Save reason" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].path).toBe("/api/admin/estimates/x-1");
  expect(patches[0].body).toEqual({ disposition: "declined_price" });
  expect(patches[0].body).not.toHaveProperty("status");
});

it.each([
  ["status pills off", false],
  ["status pills on", true],
])("(mobile, %s): both filters join the chip set and Call today runs oldest first", async (_label, pills) => {
  flags.estimates_v2_status_pills = pills;
  const { container } = renderPage(390);
  await screen.findByText("Fresh View");
  fireEvent.click(screen.getByRole("button", { name: /^Filter: / }));
  expect(await screen.findByText(/^Pick reason \(1\)$/)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/^Call today \(2\)$/));
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
});

// A quote the customer opened from the portal (plan restart, plan start) that nobody delivered
// carries the zero-follow-up contract: the list row's undeliveredSelfServe keeps it out of every
// follow-up prompt on the page (codex pre-push P1). The same row unflagged is the control.
it.each([
  ["a staff quote (control)", false, { followUp: 6, awaiting: 0, action: 4 }],
  ["a self-serve quote nobody delivered", true, { followUp: 5, awaiting: 1, action: 3 }],
])("%s viewed 3 days ago: row badge, Follow Up Now, Awaiting Response and Action Required", async (_label, flagged, counts) => {
  listRows = [...ROWS, viewed("ss-1", "Portal Quote", 3 * DAY, { source: "plan_start", undeliveredSelfServe: flagged })];
  const { container } = renderPage();
  await screen.findByText("Portal Quote");
  const row = container.querySelector('[data-estimate-id="ss-1"]');
  if (flagged) expect(within(row).queryByText("Follow up")).not.toBeInTheDocument();
  else expect(within(row).getByText("Follow up")).toBeInTheDocument();
  // The row's Follow Up action too (codex pre-push P1).
  expect(Boolean(within(row).queryByRole("button", { name: "Follow Up" }))).toBe(!flagged);
  cleanup();

  renderPage(390);
  await screen.findByText("Portal Quote");
  fireEvent.click(screen.getByRole("button", { name: /^Filter: / }));
  expect(await screen.findByText(`Follow Up Now (${counts.followUp})`)).toBeInTheDocument();
  expect(screen.getByText(`Awaiting Response (${counts.awaiting})`)).toBeInTheDocument();
  cleanup();

  flags.estimates_v2_status_pills = true;
  renderPage(390);
  await screen.findByText("Portal Quote");
  fireEvent.click(screen.getByRole("button", { name: /^Filter: / }));
  expect(await screen.findByText(`Action Required (${counts.action})`)).toBeInTheDocument();
});

// The Sent tile counts the rows its drilldown lists (codex pre-push P1): a self-serve quote nobody
// delivered is no send, so both leave it out; the same row unflagged is the control. One staff
// scheduled to send (ss-2) counts either way, as scheduled.
it.each([
  ["a staff quote (control)", false],
  ["a self-serve quote nobody delivered", true],
])("%s viewed 3 days ago: the Sent tile counts the rows its drilldown lists", async (_label, flagged) => {
  const scheduled = {
    ...viewed("ss-2", "Portal Scheduled", 4 * DAY, { source: "plan_start", undeliveredSelfServe: true }),
    status: "scheduled",
  };
  listRows = [...ROWS, viewed("ss-1", "Portal Quote", 3 * DAY, { source: "plan_start", undeliveredSelfServe: flagged }), scheduled];
  const { container } = renderPage();
  await screen.findByText("Portal Quote");
  const sentRows = ["v-1h", "v-5h", "v-30h", "v-called", "v-cold", "ss-2", ...(flagged ? [] : ["ss-1"])];
  const tile = screen.getByRole("button", { name: /^Sent/ });
  expect(tile.querySelector(".u-nums").textContent).toBe(String(sentRows.length));
  fireEvent.click(tile);
  await waitFor(() => expect([...rowIds(container)].sort()).toEqual([...sentRows].sort()));
});

// Call today outcomes (owner 2026-11-20, D1 A): each Call today row gets four buttons. One tap saves the outcome with
// who and when, and the row leaves the list until the customer opens or taps the estimate again. "Not interested" also
// opens the Mark lost box. A call placed from the list keeps its row on screen until a tap, even once it connects.
const rowOf = (container, id) => container.querySelector(`[data-estimate-id="${id}"]`);

it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) one outcome tap saves it and takes the row off Call today", async (_label, width) => {
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  const buttons = within(rowOf(container, "v-5h")).getByRole("group", { name: "Call outcome for Five Hours" });
  expect(within(buttons).getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Booked",
    "Call back",
    "Not interested",
    "No answer",
  ]);
  fireEvent.click(within(buttons).getByRole("button", { name: "No answer" }));
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h"]));
  expect(posts).toEqual([{ path: "/api/admin/estimates/v-5h/call-outcome", body: { outcome: "no_answer" } }]);
  expect(screen.queryByText("Mark as lost")).not.toBeInTheDocument();
});

it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) Not interested saves the outcome and opens the Mark lost box", async (_label, width) => {
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  fireEvent.click(within(rowOf(container, "v-30h")).getByRole("button", { name: "Not interested" }));
  expect(await screen.findByText("Mark as lost")).toBeInTheDocument();
  expect(posts).toEqual([{ path: "/api/admin/estimates/v-30h/call-outcome", body: { outcome: "not_interested" } }]);
  await waitFor(() => expect(rowIds(container)).toEqual(["v-5h"]));
});

it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) a call placed from the list keeps its row until an outcome is tapped, even once the call connects", async (_label, width) => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  fireEvent.click(within(rowOf(container, "v-5h")).getByRole("button", { name: /via Waves$/ }));
  await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/admin/communications/call"]));
  // The answered call lands: a fresh read carries lastCalledAt after the last open, which alone takes a row off.
  listRows = ROWS.map((r) => (r.id === "v-5h" ? { ...r, lastCalledAt: new Date().toISOString() } : r));
  act(() => routerProbe.navigate("/admin/pipeline?tab=estimates&view=call_today"));
  await waitFor(() => expect(routerProbe.search).toBe("?tab=estimates"));
  await settle();
  expect(rowIds(container)).toEqual(["v-30h", "v-5h"]);
  fireEvent.click(within(rowOf(container, "v-5h")).getByRole("button", { name: "Booked" }));
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h"]));
  expect(posts.at(-1)).toEqual({ path: "/api/admin/estimates/v-5h/call-outcome", body: { outcome: "booked" } });
});

// The hold is for the caller to log the call they placed from Call today, so a call from any other list holds nothing,
// and a held row still needs the rule's row checks (codex pre-push P1s).
it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) a call placed from another list holds nothing: once it connects, the row is off Call today", async (_label, width) => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const { container } = renderPage(width, "?tab=estimates");
  await screen.findByText("Five Hours");
  fireEvent.click(within(rowOf(container, "v-5h")).getByRole("button", { name: /via Waves$/ }));
  await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/admin/communications/call"]));
  listRows = ROWS.map((r) => (r.id === "v-5h" ? { ...r, lastCalledAt: new Date().toISOString() } : r));
  act(() => routerProbe.navigate("/admin/pipeline?tab=estimates&view=call_today"));
  await waitFor(() => expect(routerProbe.search).toBe("?tab=estimates"));
  await settle();
  expect(rowIds(container)).toEqual(["v-30h"]);
});

// The held row's own refresh, once a minute, brings the news: no reload, no navigation (codex pre-push P1).
it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) a held row leaves at the next minute's quiet re-read when the customer accepts during the call", async (_label, width) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = renderPage(width, "?tab=estimates&view=call_today");
    await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
    fireEvent.click(within(rowOf(container, "v-5h")).getByRole("button", { name: /via Waves$/ }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/admin/communications/call"]));
    listRows = ROWS.map((r) =>
      r.id === "v-5h" ? { ...r, status: "accepted", lastCalledAt: new Date().toISOString() } : r,
    );
    expect(rowIds(container)).toEqual(["v-30h", "v-5h"]);
    await act(async () => {
      vi.advanceTimersByTime(HELD_REFRESH_INTERVAL_MS);
    });
    await waitFor(() => expect(rowIds(container)).toEqual(["v-30h"]));
    expect(screen.queryByRole("group", { name: "Call outcome for Five Hours" })).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

// A failed outcome read must not put a logged row back on the list (codex pre-push P1): Call today withholds every
// row and says why.
it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) when the outcomes cannot be read, Call today pauses with a note and a tapped row stays off", async (_label, width) => {
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  expect(screen.queryByText(CALL_OUTCOMES_UNREAD_NOTE)).not.toBeInTheDocument();
  outcomesUnread = true;
  fireEvent.click(within(rowOf(container, "v-5h")).getByRole("button", { name: "No answer" }));
  expect(await screen.findByText(CALL_OUTCOMES_UNREAD_NOTE)).toBeInTheDocument();
  expect(rowIds(container)).toEqual([]);
  expect(posts).toEqual([{ path: "/api/admin/estimates/v-5h/call-outcome", body: { outcome: "no_answer" } }]);
});

// The page merges the sent list with the draft read (and, on desktop, the archived wins). A failed outcome read on
// one of those never pauses a Call today list whose own rows were read (codex pre-push P1).
it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) a draft read that lost its outcomes does not pause Call today", async (_label, width) => {
  draftRows = [{ ...viewed("d-1", "Draft Offer", 5 * HOUR), status: "draft", callOutcomeUnknown: true }];
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  await settle();
  expect(screen.queryByText(CALL_OUTCOMES_UNREAD_NOTE)).not.toBeInTheDocument();
});

it("the unread note shows only on Call today, and only when a row's outcomes could not be read", () => {
  const unread = [viewed("u-1", "Unread", 5 * HOUR, { callOutcomeUnknown: true })];
  const read = [viewed("r-1", "Read", 5 * HOUR, { callOutcomeUnknown: false })];
  expect(callOutcomesUnreadNote(unread, "call_today")).toBe(CALL_OUTCOMES_UNREAD_NOTE);
  expect(callOutcomesUnreadNote(unread, "all")).toBe("");
  expect(callOutcomesUnreadNote(read, "call_today")).toBe("");
  expect(callOutcomesUnreadNote([], "call_today")).toBe("");
  // Only a row Call today could list counts: a draft, an archived or an accepted row never does.
  const unreadDraft = { ...unread[0], status: "draft" };
  const unreadArchived = { ...unread[0], archivedAt: ago(HOUR) };
  const unreadWon = { ...unread[0], status: "accepted" };
  expect(callOutcomesUnreadNote([unreadDraft, unreadArchived, unreadWon, ...read], "call_today")).toBe("");
});

it("a held row re-reads the list quietly once a minute, for at most 15 minutes after the newest call", () => {
  vi.useFakeTimers();
  try {
    const refresh = vi.fn();
    const { result } = renderHook(() =>
      useCallOutcomes({ setEstimates: vi.fn(), refresh, onNotInterested: vi.fn() }),
    );
    act(() => {
      vi.advanceTimersByTime(5 * HELD_REFRESH_INTERVAL_MS);
    });
    expect(refresh).not.toHaveBeenCalled(); // nothing held, nothing re-read
    act(() => result.current.hold(viewed("h-3", "Held Offer", 5 * HOUR)));
    act(() => {
      vi.advanceTimersByTime(HELD_REFRESH_INTERVAL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ silent: true });
    act(() => {
      vi.advanceTimersByTime(HELD_REFRESH_MAX_MS + 5 * HELD_REFRESH_INTERVAL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(HELD_REFRESH_MAX_MS / HELD_REFRESH_INTERVAL_MS);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) the buttons show only on Call today; a saved outcome shows on the row", async (_label, width) => {
  listRows = ROWS.map((r) =>
    r.id === "v-cold" ? { ...r, lastCallOutcome: { outcome: "call_back", at: ago(2 * DAY), by: "Virginia" } } : r,
  );
  const { container } = renderPage(width, "?tab=estimates");
  await screen.findByText("Gone Cold");
  expect(screen.queryByRole("group", { name: /^Call outcome for / })).not.toBeInTheDocument();
  expect(within(rowOf(container, "v-cold")).getByText(/^Call back · .+ · Virginia$/)).toBeInTheDocument();
});

it("a saved outcome reads: what, when (with the date when not today, ET), who", () => {
  const now = new Date("2026-11-20T18:00:00Z"); // 1:00 PM EST
  expect(callOutcomeLine({ outcome: "no_answer", at: "2026-11-20T14:42:00Z", by: "Virginia" }, now)).toBe(
    "No answer · 9:42 AM · Virginia",
  );
  expect(callOutcomeLine({ outcome: "call_back", at: "2026-11-18T14:42:00Z", by: "Adam" }, now)).toBe(
    "Call back · Nov 18, 9:42 AM · Adam",
  );
  // Just after midnight ET is already the next ET day.
  expect(callOutcomeLine({ outcome: "booked", at: "2026-11-20T04:30:00Z", by: null }, now)).toBe(
    "Booked · Nov 19, 11:30 PM",
  );
  expect(callOutcomeLine({ outcome: "voicemail", at: "2026-11-20T14:42:00Z" }, now)).toBe("");
  expect(callOutcomeLine(null, now)).toBe("");
});

// Owner 2026-11-21 (estimate page changes, change 1): what the customer said would help them decide.
it("a sent reason reads: Still deciding, what would help, when (with the date when not today, ET)", () => {
  const now = new Date("2026-11-21T18:00:00Z"); // 1:00 PM EST
  const at = "2026-11-21T14:42:00Z";
  expect(stillDecidingLine({ reason: "person", at }, now)).toBe("Still deciding: wants to talk to a person first · 9:42 AM");
  expect(stillDecidingLine({ reason: "price", at }, now)).toBe("Still deciding: wants a lower price · 9:42 AM");
  expect(stillDecidingLine({ reason: "quotes", at }, now)).toBe("Still deciding: is comparing other quotes · 9:42 AM");
  expect(stillDecidingLine({ reason: "timing", at }, now)).toBe("Still deciding: says it is not the right time yet · 9:42 AM");
  expect(stillDecidingLine({ reason: "other", at }, now)).toBe('Still deciding: picked "Something else" · 9:42 AM');
  expect(stillDecidingLine({ reason: "price", at: "2026-11-19T14:42:00Z" }, now)).toBe(
    "Still deciding: wants a lower price · Nov 19, 9:42 AM",
  );
  // A reason this page does not know, a reason with no time, no reason: no line.
  expect(stillDecidingLine({ reason: "constructor", at }, now)).toBe("");
  expect(stillDecidingLine({ reason: "price" }, now)).toBe("");
  expect(stillDecidingLine(null, now)).toBe("");
});

it.each([
  ["desktop", 1440],
  ["mobile", 390],
])("(%s) a customer who sent a reason is on Call today at once, with the reason on the row", async (_label, width) => {
  // "Fresh View" opened the estimate 1 h ago (inside the 2 h wait) and sent a reason 30 minutes ago.
  listRows = ROWS.map((r) => (r.id === "v-1h" ? { ...r, stillDeciding: { reason: "person", at: ago(HOUR / 2) } } : r));
  const { container } = renderPage(width, "?tab=estimates&view=call_today");
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h", "v-1h"]));
  expect(
    within(rowOf(container, "v-1h")).getByText(/^Still deciding: wants to talk to a person first · /),
  ).toBeInTheDocument();
  expect(within(rowOf(container, "v-5h")).queryByText(/^Still deciding/)).not.toBeInTheDocument();
});

it("a held row leaves once anyone logs an outcome after the call was placed, not before", () => {
  const { result } = renderHook(() =>
    useCallOutcomes({ setEstimates: vi.fn(), refresh: vi.fn(), onNotInterested: vi.fn() }),
  );
  // The row already carried yesterday's outcome when the call was placed.
  const earlier = { outcome: "call_back", at: ago(DAY), by: "Adam" };
  const called = viewed("h-1", "Held Offer", 5 * HOUR, { lastCalledAt: new Date().toISOString(), lastCallOutcome: earlier });
  expect(result.current.onCallToday(called)).toBe(false); // the answered call alone takes it off
  act(() => result.current.hold(called));
  expect(result.current.onCallToday(called)).toBe(true);
  const later = { outcome: "booked", at: new Date(Date.now() + 1000).toISOString(), by: "Virginia" };
  expect(result.current.onCallToday({ ...called, lastCallOutcome: later })).toBe(false);
  // This browser's clock runs 10 minutes fast: the server stamps another person's outcome "5 minutes ago" by the
  // browser's clock, and it is still newer than the one the row carried, so the row leaves (codex pre-push P1).
  const skewed = { outcome: "no_answer", at: ago(5 * 60000), by: "Virginia" };
  expect(result.current.onCallToday({ ...called, lastCallOutcome: skewed })).toBe(false);
});

it("a held row with no outcome when the call was placed leaves at the first outcome anyone logs", () => {
  const { result } = renderHook(() =>
    useCallOutcomes({ setEstimates: vi.fn(), refresh: vi.fn(), onNotInterested: vi.fn() }),
  );
  const called = viewed("h-4", "Held Offer", 5 * HOUR, { lastCalledAt: new Date().toISOString() });
  act(() => result.current.hold(called));
  expect(result.current.onCallToday(called)).toBe(true);
  const logged = { outcome: "call_back", at: ago(60000), by: "Virginia" };
  expect(result.current.onCallToday({ ...called, lastCallOutcome: logged })).toBe(false);
});

it("a held row keeps the rule's row checks; only the answered call and a touch during the call are set aside", () => {
  const { result } = renderHook(() =>
    useCallOutcomes({ setEstimates: vi.fn(), refresh: vi.fn(), onNotInterested: vi.fn() }),
  );
  const now = new Date().toISOString();
  const called = viewed("h-2", "Held Offer", 5 * HOUR, { lastCalledAt: now });
  act(() => result.current.hold(called));
  expect(result.current.onCallToday(called)).toBe(true);
  // The customer opens the estimate during the call: too fresh for the rule, still held.
  expect(result.current.onCallToday({ ...called, lastViewedAt: now })).toBe(true);
  expect(result.current.onCallToday({ ...called, status: "accepted" })).toBe(false);
  expect(result.current.onCallToday({ ...called, archivedAt: now })).toBe(false);
  expect(result.current.onCallToday({ ...called, callOutcomeUnknown: true })).toBe(false);
  // Not held: the rule alone.
  expect(result.current.onCallToday({ ...called, id: "h-other" })).toBe(false);
});
