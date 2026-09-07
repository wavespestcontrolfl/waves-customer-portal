// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));
vi.mock("./CommunicationsPage", () => ({ ALL_NUMBERS: [], NUMBER_LABEL_MAP: {} }));

import { SandyTransferCard } from "./CallLogTabV2";

afterEach(cleanup);

describe("SandyTransferCard", () => {
  it("renders the packet: intent, summary, unresolved, facts, tools ok/failed, commitments, tier, turns", () => {
    render(
      <SandyTransferCard
        handoff={{
          context_available: true,
          verification_tier: "full",
          caller_attested: true,
          intent: "billing dispute",
          summary: "June invoice charged twice, wants a refund",
          unresolved_question: "refund timing",
          facts_collected: { first_name: "Pat", zip: "34205", email: null },
          tools: [{ name: "get_account_overview", ok: true }, { name: "get_invoice_history", ok: false }],
          commitments: [{ kind: "estimate", verdict: true }],
          turn_count: 4,
        }}
      />,
    );
    expect(screen.getByText("Sandy transfer")).toBeInTheDocument();
    expect(screen.getByText("Verified caller")).toBeInTheDocument();
    expect(screen.getByText("billing dispute")).toBeInTheDocument();
    expect(screen.getByText("June invoice charged twice, wants a refund")).toBeInTheDocument();
    expect(screen.getByText("refund timing")).toBeInTheDocument();
    expect(screen.getByText("first name: Pat · zip: 34205")).toBeInTheDocument();
    expect(screen.getByText(/get_account_overview ok/)).toBeInTheDocument();
    expect(screen.getByText(/get_invoice_history failed/)).toHaveClass("text-alert-fg");
    expect(screen.getByText("estimate")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("an ANI-only primary-number match is a recognized number, never a verified caller (codex r2 P1)", () => {
    render(<SandyTransferCard handoff={{ context_available: true, verification_tier: "full", caller_attested: false, intent: "x" }} />);
    expect(screen.getByText("Recognized primary number")).toBeInTheDocument();
    expect(screen.queryByText("Verified caller")).not.toBeInTheDocument();
  });

  it("renders the context-unavailable state", () => {
    render(<SandyTransferCard handoff={{ context_available: false, verification_tier: "unverified" }} />);
    expect(screen.getByText(/Context unavailable/)).toBeInTheDocument();
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    expect(screen.queryByText("Intent")).not.toBeInTheDocument();
  });

  it("renders nothing without a packet", () => {
    const { container } = render(<SandyTransferCard handoff={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
