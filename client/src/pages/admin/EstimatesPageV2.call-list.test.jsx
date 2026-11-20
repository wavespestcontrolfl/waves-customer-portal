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
  callOutcomeLine,
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
        if (parsed.searchParams.get("status") === "draft") return response({ estimates: [] });
        const rows = listRows.map((r) => (savedOutcomes.has(r.id) ? { ...r, lastCallOutcome: savedOutcomes.get(r.id) } : r));
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

it("a held row leaves once anyone logs an outcome after the call was placed, not before", () => {
  const { result } = renderHook(() =>
    useCallOutcomes({ setEstimates: vi.fn(), refresh: vi.fn(), onNotInterested: vi.fn() }),
  );
  const called = viewed("h-1", "Held Offer", 5 * HOUR, { lastCalledAt: new Date().toISOString() });
  expect(result.current.onCallToday(called)).toBe(false); // the answered call alone takes it off
  act(() => result.current.hold("h-1"));
  expect(result.current.onCallToday(called)).toBe(true);
  const earlier = { outcome: "call_back", at: ago(DAY), by: "Adam" };
  expect(result.current.onCallToday({ ...called, lastCallOutcome: earlier })).toBe(true);
  const later = { outcome: "booked", at: new Date(Date.now() + 1000).toISOString(), by: "Virginia" };
  expect(result.current.onCallToday({ ...called, lastCallOutcome: later })).toBe(false);
});
