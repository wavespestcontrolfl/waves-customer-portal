// @vitest-environment jsdom
// Estimator audit P1-8: ai_agent drafts carry their reasoning/assumptions/
// uncertainty in estimate_data.agentDraftReview (the notes column is
// customer-visible), and the pipeline must actually RENDER that material —
// the badge opens the review modal, and the modal shows every section.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineReviewModal, MobileEstimateRow } from "./EstimatesPageV2";

const AGENT_REVIEW = {
  reasoning: "Quarterly pest fits the request and the home size.",
  assumptions: ["Single story"],
  uncertainty: ["Lot size unverified"],
  sqftSource: "property_lookup",
  belowTargetServices: ["lawn_care"],
  unverifiedLineCount: 0,
  createdAt: "2026-07-19T12:00:00.000Z",
};

const ESTIMATE = {
  id: "estimate-1",
  token: "customer-link-token",
  status: "draft",
  source: "ai_agent",
  customerId: "customer-1",
  customerName: "Ada Lovelace",
  customerPhone: "+19415550100",
  monthlyTotal: 54.17,
  createdAt: "2026-07-16T12:00:00.000Z",
  serviceLines: [],
  agentDraftReview: AGENT_REVIEW,
};

afterEach(() => cleanup());

describe("agent draft review badge", () => {
  it("shows the review badge for an ai_agent draft (no estimatorEngine lane) and opens the review", () => {
    const onEngineReview = vi.fn();
    render(
      <MemoryRouter>
        <MobileEstimateRow estimate={ESTIMATE} onEngineReview={onEngineReview} v3Flag />
      </MemoryRouter>,
    );

    // Uncertainty + below-target margin flag it for review.
    const badge = screen.getByText("AI Review");
    fireEvent.click(badge.closest("button"));
    expect(onEngineReview).toHaveBeenCalledWith(expect.objectContaining({ id: "estimate-1" }));
  });

  it("renders an unflagged AI Draft badge when there is nothing to warn about", () => {
    render(
      <MemoryRouter>
        <MobileEstimateRow
          estimate={{
            ...ESTIMATE,
            agentDraftReview: { ...AGENT_REVIEW, uncertainty: [], belowTargetServices: [] },
          }}
          onEngineReview={vi.fn()}
          v3Flag
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("AI Draft")).toBeInTheDocument();
  });

  it("flags the badge when priced-line margins could not be verified", () => {
    render(
      <MemoryRouter>
        <MobileEstimateRow
          estimate={{
            ...ESTIMATE,
            agentDraftReview: {
              ...AGENT_REVIEW,
              uncertainty: [],
              belowTargetServices: [],
              unverifiedLineCount: 2,
            },
          }}
          onEngineReview={vi.fn()}
          v3Flag
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("AI Review")).toBeInTheDocument();
  });
});

describe("agent draft review modal", () => {
  it("renders reasoning, assumptions, uncertainty, and below-target sections", () => {
    render(<EngineReviewModal estimate={ESTIMATE} onClose={vi.fn()} />);

    expect(screen.getByText("Agent reasoning")).toBeInTheDocument();
    expect(
      screen.getByText("Quarterly pest fits the request and the home size."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sqft source:/)).toBeInTheDocument();
    expect(screen.getByText("Assumptions made")).toBeInTheDocument();
    expect(screen.getByText("Single story")).toBeInTheDocument();
    expect(screen.getByText("Uncertainty flags")).toBeInTheDocument();
    expect(screen.getByText("Lot size unverified")).toBeInTheDocument();
    expect(screen.getByText("Below margin target")).toBeInTheDocument();
    expect(screen.getByText("lawn_care")).toBeInTheDocument();
    expect(screen.getByText("Flagged for review")).toBeInTheDocument();
  });

  it("warns when priced-line margins could not be verified", () => {
    render(
      <EngineReviewModal
        estimate={{ ...ESTIMATE, agentDraftReview: { ...AGENT_REVIEW, unverifiedLineCount: 2 } }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Margin could not be verified on 2 priced lines/)).toBeInTheDocument();
  });

  it("renders engine marginWarnings as a report-only margin section and flags the badge (P1-3)", () => {
    render(
      <EngineReviewModal
        estimate={{
          ...ESTIMATE,
          agentDraftReview: null,
          estimatorEngine: {
            lane: "green",
            laneReasons: [],
            reviewNotes: null,
            marginWarnings: ["waveguard_discount_below_margin_floor"],
          },
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Margin review \(report-only/)).toBeInTheDocument();
    expect(screen.getByText("waveguard discount below margin floor")).toBeInTheDocument();
    // A green lane with margin warnings still reads as flagged.
    expect(screen.getByText("Flagged for review")).toBeInTheDocument();
  });

  it("still renders the estimator-engine material unchanged", () => {
    render(
      <EngineReviewModal
        estimate={{
          ...ESTIMATE,
          agentDraftReview: null,
          estimatorEngine: {
            lane: "yellow",
            laneReasons: ["Phone divergence"],
            reviewNotes: "Engine evidence text",
          },
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Review reasons")).toBeInTheDocument();
    expect(screen.getByText("Phone divergence")).toBeInTheDocument();
    expect(screen.getByText("Engine evidence text")).toBeInTheDocument();
  });
});
