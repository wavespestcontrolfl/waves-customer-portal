// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LiveCallPanelV2, { elapsedLabel } from "./LiveCallPanelV2";

const NOW = new Date("2026-11-17T15:02:05.000Z");
const call = (lines) => ({
  id: "call-1",
  started_at: "2026-11-17T15:00:00.000Z",
  caller_phone: "+19415550101",
  customer: { id: "cust-1", name: "Casey Sample" },
  answered_by: "Pat Example",
  lines,
});
const lines = (n) => Array.from({ length: n }, (_, i) => ({
  speaker: i % 2 ? "staff" : "caller", text: `line ${i + 1}`, at: `2026-11-17T15:00:${String(i).padStart(2, "0")}.000Z`,
}));
const answer = (calls) => ({ ok: true, json: async () => ({ calls }) });
let visibility = "visible";

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("LiveCallPanelV2", () => {
  it("renders nothing while no call is live", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer([])));
    const { container } = render(<LiveCallPanelV2 />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the caller, agent, running time and the newest 8 lines, newest last", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer([call(lines(10))])));
    render(<LiveCallPanelV2 />);
    await flush();
    expect(screen.getByRole("link", { name: "Casey Sample" })).toHaveAttribute("href", "/admin/customers?customerId=cust-1");
    expect(screen.getByRole("link", { name: "+19415550101" })).toHaveAttribute("href", "#tab=calls&call=call-1");
    expect(screen.getByText("Answered by Pat Example")).toBeInTheDocument();
    expect(screen.getByText("2:05")).toBeInTheDocument();
    const shown = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(shown).toHaveLength(8);
    expect(shown[0]).toBe("Callerline 3");
    expect(shown[7]).toBe("Agentline 10");
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("2:06")).toBeInTheDocument();
  });

  it("shows the ask, price and open times above the lines, and hides a row with no text", async () => {
    const withAssist = (assist) => ({ ...call(lines(2)), assist });
    vi.stubGlobal("fetch", vi.fn(async () => answer([
      withAssist({ intent: "Wants quarterly pest control", price: "Standard pest control pricing: $99 per application", times: "Tuesday November 18 at 9 AM; Wednesday November 19 at 10 AM", at: "2026-11-17T15:01:00.000Z" }),
    ])));
    const { unmount } = render(<LiveCallPanelV2 />);
    await flush();
    const rows = within(screen.getByTestId("live-call-assist")).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual([
      "Asking forWants quarterly pest control",
      "PriceStandard pest control pricing: $99 per application",
      "Open timesTuesday November 18 at 9 AM; Wednesday November 19 at 10 AM",
    ]);
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => answer([withAssist({ intent: "Billing question", price: null, times: null, at: null })])));
    render(<LiveCallPanelV2 />);
    await flush();
    const only = within(screen.getByTestId("live-call-assist")).getAllByRole("listitem").map((li) => li.textContent);
    expect(only).toEqual(["Asking forBilling question"]);
    expect(screen.queryByText("Price")).not.toBeInTheDocument();
    expect(screen.queryByText("Open times")).not.toBeInTheDocument();
  });

  it("shows no assist block when assist is null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer([{ ...call(lines(2)), assist: null }])));
    render(<LiveCallPanelV2 />);
    await flush();
    expect(screen.queryByTestId("live-call-assist")).not.toBeInTheDocument();
  });

  it("pauses while the tab is hidden and polls again when it shows", async () => {
    const fetchMock = vi.fn(async () => answer([call(lines(2))]));
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveCallPanelV2 />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good calls when a poll fails, and does not stack requests", async () => {
    let release;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(answer([call(lines(2))]))
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveCallPanelV2 />);
    await flush();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    release({ ok: false, status: 500 });
    await flush();
    expect(screen.getByText("line 2")).toBeInTheDocument();
  });

  it("asks only once a minute while live text is switched off", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ enabled: false, calls: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveCallPanelV2 />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(35000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("Hold button (GATE_CALL_HOLD)", () => {
    const withHold = (hold) => ({ ...call(lines(2)), hold });
    // GET /live answers the calls; the POST answers the hold route's status.
    const server = (hold, postAnswer = { ok: true, json: async () => ({ result: "requested" }) }) => vi.fn(async (url, opts) => (
      opts?.method === "POST" ? postAnswer : answer([withHold(hold)])
    ));

    it("an answered conference-ring call shows Hold; a press posts to the call's hold route and waits for the hold", async () => {
      const fetchMock = server({ can_hold: true, on_hold: false, since: null });
      vi.stubGlobal("fetch", fetchMock);
      render(<LiveCallPanelV2 />);
      await flush();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hold" })); });
      await flush();
      const post = fetchMock.mock.calls.find(([, opts]) => opts?.method === "POST");
      expect(post[0]).toBe("/api/admin/call-recordings/live/call-1/hold");
      expect(post[1].headers.Authorization).toMatch(/^Bearer /);
      expect(screen.getByRole("button", { name: "Putting on hold…" })).toBeDisabled();
    });

    it("a press that shows no hold within 15 s gives the button back", async () => {
      vi.stubGlobal("fetch", server({ can_hold: true, on_hold: false, since: null }));
      render(<LiveCallPanelV2 />);
      await flush();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hold" })); });
      await flush();
      await act(async () => { vi.advanceTimersByTime(14000); });
      expect(screen.getByRole("button", { name: "Putting on hold…" })).toBeDisabled();
      await act(async () => { vi.advanceTimersByTime(2000); });
      expect(screen.getByRole("button", { name: "Hold" })).toBeEnabled();
    });

    it("a refused press says to press star and gives the button back", async () => {
      vi.stubGlobal("fetch", server({ can_hold: true, on_hold: false, since: null }, { ok: false, status: 502, json: async () => ({ result: "failed" }) }));
      render(<LiveCallPanelV2 />);
      await flush();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hold" })); });
      await flush();
      expect(screen.getByText("The hold did not start. Press star on the phone.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Hold" })).toBeEnabled();
    });

    it("a call on hold shows how long, and the way back; no Hold button", async () => {
      vi.stubGlobal("fetch", server({ can_hold: false, on_hold: true, since: "2026-11-17T15:01:05.000Z" }));
      render(<LiveCallPanelV2 />);
      await flush();
      expect(screen.getByTestId("live-call-hold")).toHaveTextContent("On hold 1:00. Press 1 on the phone to go back.");
      expect(screen.queryByRole("button", { name: "Hold" })).not.toBeInTheDocument();
    });

    it("no Hold button when the hold is off, the call is not on the conference ring, or it cannot hold now", async () => {
      for (const hold of [undefined, null, { can_hold: false, on_hold: false, since: null }]) {
        vi.stubGlobal("fetch", server(hold));
        const { unmount } = render(<LiveCallPanelV2 />);
        await flush();
        expect(screen.getByText("line 2")).toBeInTheDocument();
        expect(screen.queryByTestId("live-call-hold")).not.toBeInTheDocument();
        unmount();
      }
    });
  });

  it("formats the running time as m:ss", () => {
    expect(elapsedLabel("2026-11-17T15:00:00.000Z", Date.parse("2026-11-17T15:57:05.000Z"))).toBe("57:05");
    expect(elapsedLabel("2026-11-17T15:03:00.000Z", NOW.getTime())).toBe("0:00");
  });
});
