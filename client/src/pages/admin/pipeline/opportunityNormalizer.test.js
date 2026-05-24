import { describe, expect, it } from "vitest";
import {
  buildOpportunitySearchText,
  deriveOpportunityStage,
  normalizeOpportunities,
  opportunityMatchesFilter,
} from "./opportunityNormalizer";
import { PIPELINE_STAGES } from "./pipelineStages";

const NOW = new Date("2026-05-24T12:00:00.000Z");

function lead(overrides = {}) {
  return {
    id: "lead-1",
    first_name: "Jane",
    last_name: "Smith",
    phone: "(555) 123-4567",
    email: "jane@example.com",
    service_interest: "Weekly pool service",
    status: "new",
    created_at: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function estimate(overrides = {}) {
  return {
    id: "est-1",
    customerName: "Jane Smith",
    customerPhone: "555-123-4567",
    customerEmail: "jane@example.com",
    serviceInterest: "Weekly pool service",
    status: "draft",
    createdAt: "2026-05-21T12:00:00.000Z",
    monthlyTotal: 420,
    ...overrides,
  };
}

describe("deriveOpportunityStage", () => {
  it("maps a new lead with no estimate to New Lead", () => {
    expect(deriveOpportunityStage({ lead: lead(), estimate: null }).stage).toBe(PIPELINE_STAGES.NEW_LEAD);
  });

  it("maps contacted lead with no estimate to Contacted", () => {
    expect(deriveOpportunityStage({ lead: lead({ status: "contacted" }), estimate: null }).stage).toBe(PIPELINE_STAGES.CONTACTED);
  });

  it("maps qualified lead with no estimate to Estimate Needed", () => {
    expect(deriveOpportunityStage({ lead: lead({ status: "qualified" }), estimate: null }).stage).toBe(PIPELINE_STAGES.ESTIMATE_NEEDED);
  });

  it("maps a linked draft estimate to Estimate Draft", () => {
    expect(deriveOpportunityStage({ lead: lead(), estimate: estimate({ status: "draft" }) }).stage).toBe(PIPELINE_STAGES.ESTIMATE_DRAFT);
  });

  it("maps a sent estimate to Estimate Sent", () => {
    expect(deriveOpportunityStage({ lead: lead(), estimate: estimate({ status: "sent", sentAt: "2026-05-23T12:00:00.000Z" }) }).stage).toBe(PIPELINE_STAGES.ESTIMATE_SENT);
  });

  it("maps a viewed estimate to Estimate Viewed", () => {
    expect(deriveOpportunityStage({ lead: lead(), estimate: estimate({ status: "sent", viewedAt: "2026-05-23T12:00:00.000Z" }) }).stage).toBe(PIPELINE_STAGES.ESTIMATE_VIEWED);
  });

  it("maps accepted estimate to Won", () => {
    expect(deriveOpportunityStage({ lead: lead({ status: "lost" }), estimate: estimate({ status: "accepted" }) }).stage).toBe(PIPELINE_STAGES.WON);
  });

  it("maps declined estimate to Lost", () => {
    expect(deriveOpportunityStage({ lead: lead(), estimate: estimate({ status: "declined" }) }).stage).toBe(PIPELINE_STAGES.LOST);
  });
});

describe("normalizeOpportunities", () => {
  it("deduplicates when lead.estimate_id points at an estimate", () => {
    const opportunities = normalizeOpportunities({
      leads: [lead({ estimate_id: "est-1" })],
      estimates: [estimate({ id: "est-1" })],
      now: NOW,
    });

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      opportunityId: "lead:lead-1",
      sourceType: "lead_estimate",
      leadId: "lead-1",
      estimateId: "est-1",
    });
  });

  it("deduplicates when estimate.lead_id points at a lead", () => {
    const opportunities = normalizeOpportunities({
      leads: [lead({ id: "lead-1" })],
      estimates: [estimate({ id: "est-1", lead_id: "lead-1" })],
      now: NOW,
    });

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].sourceType).toBe("lead_estimate");
  });

  it("keeps unlinked estimates as standalone opportunities", () => {
    const opportunities = normalizeOpportunities({
      leads: [lead({ id: "lead-1" })],
      estimates: [estimate({ id: "est-2", customerPhone: "999-999-9999", customerEmail: "other@example.com" })],
      now: NOW,
    });

    expect(opportunities).toHaveLength(2);
    expect(opportunities.some((o) => o.opportunityId === "estimate:est-2")).toBe(true);
  });

  it("marks uncertain phone/email matches as duplicate risk without merging", () => {
    const opportunities = normalizeOpportunities({
      leads: [lead({ id: "lead-1", estimate_id: null })],
      estimates: [estimate({ id: "est-2" })],
      now: NOW,
    });

    expect(opportunities).toHaveLength(2);
    expect(opportunities.find((o) => o.opportunityId === "estimate:est-2").isDuplicateRisk).toBe(true);
  });
});

describe("search and filters", () => {
  it("search text includes normalized phone digits", () => {
    const [opportunity] = normalizeOpportunities({ leads: [lead()], estimates: [], now: NOW });
    expect(buildOpportunitySearchText(opportunity)).toContain("5551234567");
  });

  it("search text includes estimate reference", () => {
    const [opportunity] = normalizeOpportunities({ leads: [], estimates: [estimate({ id: "est-123" })], now: NOW });
    expect(buildOpportunitySearchText(opportunity)).toContain("#est-123");
  });

  it("follow-up filter uses nextAction and is not a canonical stage", () => {
    const [opportunity] = normalizeOpportunities({
      leads: [],
      estimates: [estimate({
        status: "sent",
        sentAt: "2026-05-20T12:00:00.000Z",
      })],
      now: NOW,
    });

    expect(opportunity.stage).toBe(PIPELINE_STAGES.ESTIMATE_SENT);
    expect(opportunity.nextAction).toBe("follow_up");
    expect(opportunityMatchesFilter(opportunity, "follow_up")).toBe(true);
  });
});
