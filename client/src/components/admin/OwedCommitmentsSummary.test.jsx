// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OwedCommitmentsSummary from "./OwedCommitmentsSummary";

const rowFor = (who) => ({
  id: `c-${who}`, call_log_id: `call-${who}`, party: "waves", kind: "callback", description: `Call ${who} back`,
  status: "open", due_at: null, overdue: false, call_started_at: "2026-09-01T14:00:00Z",
});

describe.each(["call", "sms"])("OwedCommitmentsSummary %s", (source) => {
  let pending;
  beforeEach(() => {
    pending = {};
    localStorage.setItem("waves_admin_token", "t");
    // Each customer's request resolves only when the test says so.
    vi.stubGlobal("fetch", vi.fn((url) => new Promise((resolve) => {
      const id = new URL(String(url), "http://x").searchParams.get("customer_id");
      pending[id] = () => resolve({ ok: true, status: 200, json: async () => ({ commitments: [rowFor(id)], enabled: true }) });
    })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows nothing of the previous customer on switch, and a late response for that customer never lands under the new one", async () => {
    const { rerender } = render(<OwedCommitmentsSummary customerId="A" source={source} />);
    pending.A();
    await screen.findByText("Call A back");
    rerender(<OwedCommitmentsSummary customerId="B" source={source} />);
    // On the very next render — before any effect — A's rows are gone.
    expect(screen.queryByText("Call A back")).toBeNull();
    expect(screen.queryByTestId("owed-summary")).toBeNull();
    pending.B();
    await screen.findByText("Call B back");
    expect(screen.queryByText("Call A back")).toBeNull();
  });

  it("a request for the previous customer that resolves after the switch is dropped, even when it resolves last", async () => {
    const { rerender } = render(<OwedCommitmentsSummary customerId="A" source={source} />);
    // A is still pending when the profile switches to B.
    rerender(<OwedCommitmentsSummary customerId="B" source={source} />);
    pending.B();
    await screen.findByText("Call B back");
    // A's slow response lands last.
    pending.A();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Call A back")).toBeNull();
    expect(screen.getByText("Call B back")).toBeInTheDocument();
  });
});

describe("SMS follow-up controls", () => {
  const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
  const report = { ...rowFor("report"), sms_log_id: "sms-1", sms_started_at: "2040-09-01T14:00:00Z",
    description: "Send the inspection report", kind: "send_report", overdue: true };
  beforeEach(() => localStorage.setItem("waves_admin_token", "t"));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each([["Mark done", "fulfill"], ["Dismiss", "dismiss"]])("%s persists the selected action and reloads the profile", async (label, action) => {
    let rows = [report];
    const fetcher = vi.fn(async (url, options) => {
      if (options?.method === "PATCH") {
        expect(JSON.parse(options.body)).toEqual({ action, customer_id: "customer-1" });
        rows = [];
        return response({ commitment: { ...report, status: action === "fulfill" ? "fulfilled" : "dismissed" } });
      }
      expect(String(url)).toContain("/commitments/sms?customer_id=customer-1");
      return response({ commitments: rows, enabled: true, has_more: false });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<OwedCommitmentsSummary customerId="customer-1" source="sms" />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(screen.queryByTestId("sms-followup-summary")).toBeNull());
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("shows later SMS obligations on the same profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const offset = new URL(String(url), "http://x").searchParams.get("offset");
      return response(offset === "0"
        ? { commitments: [report], enabled: true, has_more: true, next_offset: 20 }
        : { commitments: [{ ...report, id: "later", description: "Send the revised paperwork" }], enabled: true, has_more: false });
    }));
    render(<OwedCommitmentsSummary customerId="customer-1" source="sms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await screen.findByText("Send the revised paperwork");
    expect(screen.getByText("Send the inspection report")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("keeps a rejected closure visible with the server's reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => options?.method === "PATCH"
      ? response({ error: "SMS follow-up moved; reload this profile" }, 409)
      : response({ commitments: [report], enabled: true })));
    render(<OwedCommitmentsSummary customerId="customer-1" source="sms" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SMS follow-up moved");
    expect(screen.getByText("Send the inspection report")).toBeInTheDocument();
  });

  it("cannot offer writes while its server gate is off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ commitments: [report], enabled: false })));
    render(<OwedCommitmentsSummary customerId="customer-1" source="sms" />);
    await screen.findByText("Send the inspection report");
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});
