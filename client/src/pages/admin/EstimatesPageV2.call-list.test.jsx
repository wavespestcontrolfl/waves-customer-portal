// @vitest-environment jsdom
// GATE_ESTIMATE_CALL_LIST (flag `estimate_call_list`): the "Call today" and "Pick reason" filters, the
// two Needs-attention cards and the reason-only decline modal. Gate off = none of them exist.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
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
  CALL_WATCH_INTERVAL_MS,
  CALL_WATCH_MAX_MS,
  useCallListWatch,
} from "./EstimatesPageV2";

const flags = { estimate_call_list: false, estimates_v2_status_pills: false };

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

function renderPage(width = 1440) {
  window.innerWidth = width;
  return render(
    <MemoryRouter initialEntries={["/admin/pipeline?tab=estimates"]}>
      <EstimatesPageV2 />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  flags.estimate_call_list = false;
  flags.estimates_v2_status_pills = false;
  patches = [];
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init = {}) => {
      const parsed = new URL(String(url), "http://fixture.invalid");
      if (init.method === "PATCH") {
        patches.push({ path: parsed.pathname, body: JSON.parse(init.body) });
        return response({ success: true });
      }
      if (parsed.pathname === "/api/admin/estimates") {
        if (parsed.searchParams.get("archived") === "only") return response({ estimates: [] });
        if (parsed.searchParams.get("status") === "draft") return response({ estimates: [] });
        return response({ estimates: ROWS, truncated: false });
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

const rowIds = (container) =>
  Array.from(container.querySelectorAll("[data-estimate-id]")).map((n) => n.getAttribute("data-estimate-id"));

it("gate off (desktop): no Call today / Pick reason cards or buttons", async () => {
  renderPage();
  await screen.findByText("Fresh View");
  expect(screen.queryByText("Call today")).not.toBeInTheDocument();
  expect(screen.queryByText("Pick reason")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pick reason" })).not.toBeInTheDocument();
});

it("gate on (desktop): the Call today card counts only the 2h-48h, uncalled viewed offers and filters oldest first", async () => {
  flags.estimate_call_list = true;
  const { container } = renderPage();
  await screen.findByText("Fresh View");
  const card = screen.getByText("Call today").closest("button");
  expect(within(card).getByText("2")).toBeInTheDocument(); // 5h and 30h; not 1h, not called, not 3d
  fireEvent.click(card);
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
  // The Call action is on those rows.
  expect(screen.getAllByRole("button", { name: /^Call .* via Waves$/ })).toHaveLength(2);
});

it("gate on (desktop): Pick reason lists recently expired opened offers and saves a reason without a status", async () => {
  flags.estimate_call_list = true;
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
])("gate on (mobile, %s): both filters join the chip set and Call today runs oldest first", async (_label, pills) => {
  flags.estimate_call_list = true;
  flags.estimates_v2_status_pills = pills;
  const { container } = renderPage(390);
  await screen.findByText("Fresh View");
  fireEvent.click(screen.getByRole("button", { name: /^Filter: / }));
  expect(await screen.findByText(/^Pick reason \(1\)$/)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/^Call today \(2\)$/));
  await waitFor(() => expect(rowIds(container)).toEqual(["v-30h", "v-5h"]));
});

it.each([
  ["status pills off", false],
  ["status pills on", true],
])("gate off (mobile, %s): neither filter is offered", async (_label, pills) => {
  flags.estimates_v2_status_pills = pills;
  renderPage(390);
  await screen.findByText("Fresh View");
  fireEvent.click(screen.getByRole("button", { name: /^Filter: / }));
  await screen.findByText("Filter estimates");
  expect(screen.queryByText(/^Call today/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^Pick reason/)).not.toBeInTheDocument();
});

// The click-to-call answers before the customer picks up, so the answered-call proof (lastCalledAt)
// lands only after the call ends: after a call from Call today the page re-reads the list once a
// minute until the offer leaves Call today, for at most 15 minutes.
function tickMinutes(n) {
  for (let i = 0; i < n; i += 1) {
    act(() => {
      vi.advanceTimersByTime(CALL_WATCH_INTERVAL_MS);
    });
  }
}

it("call watch: re-reads quietly once a minute after a Call today call, and stops once the offer leaves the list", () => {
  vi.useFakeTimers();
  try {
    const refresh = vi.fn();
    const row = viewed("w-1", "Watched Offer", 5 * HOUR);
    const { result, rerender } = renderHook(
      ({ estimates }) => useCallListWatch({ enabled: true, estimates, refresh }),
      { initialProps: { estimates: [row] } },
    );
    act(() => result.current("w-1"));
    expect(refresh).not.toHaveBeenCalled(); // the call has only reached the staff leg
    tickMinutes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ silent: true });
    // The answered call landed: the re-read row carries lastCalledAt after its last open.
    rerender({ estimates: [{ ...row, lastCalledAt: new Date().toISOString() }] });
    tickMinutes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("call watch: gives up after 15 minutes when the customer never answers", () => {
  vi.useFakeTimers();
  try {
    const refresh = vi.fn();
    const rows = [viewed("w-2", "Never Answered", 5 * HOUR)];
    const { result } = renderHook(() => useCallListWatch({ enabled: true, estimates: rows, refresh }));
    act(() => result.current("w-2"));
    tickMinutes(20);
    expect(refresh).toHaveBeenCalledTimes(CALL_WATCH_MAX_MS / CALL_WATCH_INTERVAL_MS);
  } finally {
    vi.useRealTimers();
  }
});

it("call watch: does nothing with the gate off", () => {
  vi.useFakeTimers();
  try {
    const refresh = vi.fn();
    const rows = [viewed("w-3", "Gate Off", 5 * HOUR)];
    const { result } = renderHook(() => useCallListWatch({ enabled: false, estimates: rows, refresh }));
    act(() => result.current("w-3"));
    tickMinutes(3);
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
