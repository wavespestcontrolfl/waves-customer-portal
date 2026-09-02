// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CallIntelligencePanel, { commitmentStatusTone } from "./CallIntelligencePanel";

const CALL_ID = "11111111-2222-4333-8444-555555555555";

function intelligence(overrides = {}) {
  return {
    call_id: CALL_ID,
    summary: "Caller has ants in the kitchen and wants a price.",
    outcome: { disposition: "estimate_send", recommended_disposition: null, call_nature: "new_lead", lead_quality: "warm", sentiment: "neutral" },
    intent: { primary_service_category: "pest_general", specific_service_name: null, service_intent: "quote_only", urgency: "within_one_week", pests_observed: ["ants_general"] },
    property: { address: "123 Fixture Ln, Bradenton, FL", property_type: "single_family", pets_on_property: true, pet_notes: "two dogs" },
    appointment: { status: "requested", confirmed_start_at: null, preferred_time_of_day: "morning" },
    prices: { quoted_price_usd: 149, quote_type: "estimate_to_follow", quote_promised: true, quote_requested: true },
    objections: ["price"],
    buying_signals: [],
    confidence: { overall: 0.8 },
    next_action: { action: "Send the caller an estimate", owner: "office", due_at: null, commitment_id: "c1" },
    links: { customer_id: "cust-1", customer_name: "Test Customer", lead_id: null, customer_link: { source: "generated", customer_id: "cust-1" } },
    recordings: { current: "RE1", additional: [], superseded: [] },
    processing: { status: "processed", phase: "complete", detail: null, review_status: null, generation: 2, timings: { total_ms: 4200 }, validation_errors: null },
    commitments: [
      {
        id: "c1", party: "waves", kind: "send_estimate", description: "Send the caller an estimate", status: "open", source: "ai", human_state: null,
        confidence: 0.8, due_at: null, last_seen_generation: 2,
        evidence: [{ quote: "I'll email you an estimate this afternoon", speaker: "agent", matched: true, segment_index: 2, start_ms: 6200 }],
      },
      {
        id: "c2", party: "customer", kind: "send_photos", description: "Text photos of the ant trail", status: "fulfilled", source: "ai", human_state: null,
        confidence: 0.9, due_at: null, last_seen_generation: 1,
        fulfillment: { kind: "inbound_media", basis: "inbound_message_with_media_from_caller_after_call", matched_at: "2026-09-01T16:00:00Z" },
        evidence: [],
      },
    ],
    outcomes: { lead: { status: "new", lost_reason: null, basis: "stamped_on_call" }, estimates: [], appointments: [], invoices: [], revenue_cents: 0, basis_note: "" },
    ...overrides,
  };
}

let calls;
beforeEach(() => {
  calls = [];
  localStorage.setItem("waves_admin_token", "t");
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/intelligence")) return { ok: true, status: 200, json: async () => ({ intelligence: intelligence() }) };
    if (String(url).includes("/commitments/")) return { ok: true, status: 200, json: async () => ({ commitment: {} }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CallIntelligencePanel", () => {
  it("loads only when opened and renders the honest processing state, the commitments, and their provenance", async () => {
    render(<CallIntelligencePanel callId={CALL_ID} onJumpToQuote={() => {}} />);
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /call intelligence/i }));
    await waitFor(() => expect(screen.getByText("Complete")).toBeInTheDocument());
    expect(calls[0].url).toContain(`/admin/call-recordings/calls/${CALL_ID}/intelligence`);
    expect(screen.getByText("Caller has ants in the kitchen and wants a price.")).toBeInTheDocument();
    // The description appears both as the commitment row and as the next action.
    expect(screen.getAllByText("Send the caller an estimate", { selector: "div" })).toHaveLength(2);
    expect(screen.getByText(/Next:/)).toBeInTheDocument();
    expect(screen.getByText("not detected on pass 2")).toBeInTheDocument();
    expect(screen.getByText(/Kept: inbound media/)).toBeInTheDocument();
    expect(screen.getByText("generated")).toBeInTheDocument();
    expect(screen.getByText("$149 (estimate to follow)")).toBeInTheDocument();
  });

  it("hands the verbatim quote to the transcript on Jump", async () => {
    const onJump = vi.fn();
    render(<CallIntelligencePanel callId={CALL_ID} onJumpToQuote={onJump} />);
    fireEvent.click(screen.getByRole("button", { name: /call intelligence/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Jump" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(onJump).toHaveBeenCalledWith("I'll email you an estimate this afternoon");
  });

  it("posts a confirm verdict for a commitment and reloads", async () => {
    render(<CallIntelligencePanel callId={CALL_ID} onJumpToQuote={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /call intelligence/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.url).toContain("/admin/call-recordings/commitments/c1");
    expect(patch.body).toEqual({ action: "confirm" });
    // Reloaded after the write.
    expect(calls.filter((c) => c.url.includes("/intelligence"))).toHaveLength(2);
  });

  it("shows the load error with a retry instead of an empty panel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, statusText: "Server Error", clone: () => ({ json: async () => ({ error: "boom" }) }) })));
    render(<CallIntelligencePanel callId={CALL_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /call intelligence/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("edits show the due time as Eastern wall clock and send an instant, never a naive string", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
      if (String(url).includes("/intelligence")) {
        const view = intelligence();
        view.commitments[0].due_at = "2026-09-05T17:00:00.000Z"; // 1 pm EDT
        return { ok: true, status: 200, json: async () => ({ intelligence: view }) };
      }
      return { ok: true, status: 200, json: async () => ({ commitment: {} }) };
    }));
    render(<CallIntelligencePanel callId={CALL_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /call intelligence/i }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Edit" })[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const due = screen.getByLabelText("Edit due date");
    expect(due.value).toBe("2026-09-05T13:00");
    fireEvent.change(due, { target: { value: "2026-09-05T15:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH").body).toEqual({ action: "edit", description: "Send the caller an estimate", due_at: "2026-09-05T19:30:00.000Z" });
  });

  it("renders an association-only match as 'possibly kept', never as kept", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const view = intelligence();
      view.commitments = [{
        id: "c9", party: "waves", kind: "send_appointment_confirmation", description: "Send the confirmation", status: "open", source: "ai", human_state: null,
        confidence: 0.7, due_at: null, last_seen_generation: 2, evidence: [],
        fulfillment: { kind: "sms_sent", strength: "association", basis: "confirmation_text_to_caller_within_14_days", matched_at: "2026-09-02T14:00:00Z" },
      }];
      return { ok: true, status: 200, json: async () => ({ intelligence: view }) };
    }));
    render(<CallIntelligencePanel callId={CALL_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /call intelligence/i }));
    await waitFor(() => expect(screen.getByText(/Possibly kept: sms sent/)).toBeInTheDocument());
    expect(screen.queryByText(/^Kept:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark done" })).toBeInTheDocument();
  });

  it("colours an overdue open commitment as an alert and a kept one as strong", () => {
    expect(commitmentStatusTone({ status: "open", due_at: "2000-01-01T00:00:00Z" })).toBe("alert");
    expect(commitmentStatusTone({ status: "open", due_at: null })).toBe("neutral");
    expect(commitmentStatusTone({ status: "fulfilled" })).toBe("strong");
  });
});
