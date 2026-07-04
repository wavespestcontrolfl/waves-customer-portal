import { describe, expect, it } from "vitest";
import {
  MIN_CONFIDENT_N,
  agingVerdict,
  capitalVerdict,
  captureVerdict,
  completionVerdict,
  confidenceTier,
  ebitdaVerdict,
  fmtPayback,
  funnelVerdict,
  mrrVerdict,
} from "./scorecard-metrics";

describe("confidenceTier", () => {
  it("tiers sample sizes: none / low (<5) / ok (>=5)", () => {
    expect(confidenceTier(null).tier).toBe("none");
    expect(confidenceTier(0).tier).toBe("none");
    expect(confidenceTier(1)).toEqual({ tier: "low", label: "Low sample · n=1" });
    expect(confidenceTier(4).tier).toBe("low");
    expect(confidenceTier(MIN_CONFIDENT_N).tier).toBe("ok");
    expect(confidenceTier(50).label).toBeNull();
  });

  it("low-tier labels are render-ready (visible badge, not tooltip copy)", () => {
    expect(confidenceTier(3).label).toBe("Low sample · n=3");
  });
});

describe("fmtPayback", () => {
  it("formats months within the 12-mo LTV horizon", () => {
    expect(fmtPayback(4)).toBe("4 mo payback");
    expect(fmtPayback(11.96)).toBe("12 mo payback");
  });
  it("clamps the extremes to honest ranges", () => {
    expect(fmtPayback(0.4)).toBe("<1 mo");
    expect(fmtPayback(24)).toBe(">12 mo");
  });
  it("never fabricates a payback", () => {
    expect(fmtPayback(null)).toBeNull();
    expect(fmtPayback(undefined)).toBeNull();
  });
});

describe("capitalVerdict (LTV:CAC card)", () => {
  const headline = (over = {}) => ({
    headline: {
      blendedLtvCac: 8.2,
      blendedBand: "healthy",
      blendedConfidence: "ok",
      blendedCustomers: 12,
      blendedCac: 85,
      blendedPaybackMonths: 1.5,
      paidSpend: 1020,
      topOpportunity: null,
      biggestLeak: null,
      ...over,
    },
  });

  it("states the gross-profit basis and all-in spend in what-happened", () => {
    const v = capitalVerdict(headline());
    expect(v.happened).toContain("lifetime gross profit");
    expect(v.happened).toContain("all-in marketing spend");
    expect(v.happened).toContain("8.2:1");
    expect(v.happened).toContain("$85");
  });

  it("low sample overrides every recommendation — no reallocation advice off n<5", () => {
    const v = capitalVerdict(headline({
      blendedConfidence: "low",
      blendedCustomers: 2,
      topOpportunity: { source: "Google Ads", ltvCac: 40, band: "pour_in" },
    }));
    expect(v.action).toContain("too few to reallocate");
    expect(v.action).not.toContain("Google Ads");
    expect(v.tone).toBe("neutral");
  });

  it("leak beats opportunity — stop the bleeding first", () => {
    const v = capitalVerdict(headline({
      biggestLeak: { source: "Facebook", ltvCac: 0.4 },
      topOpportunity: { source: "Google LSA", ltvCac: 15, band: "scale" },
    }));
    expect(v.action).toMatch(/^Cut or fix Facebook/);
    expect(v.action).toContain("Google LSA");
    expect(v.tone).toBe("bad");
  });

  it("names the scalable channel when there is one and no leak", () => {
    const v = capitalVerdict(headline({ topOpportunity: { source: "Google Ads", ltvCac: 34, band: "pour_in" } }));
    expect(v.action).toContain("Google Ads");
    expect(v.tone).toBe("good");
  });

  it("null when there is no paid blend to judge", () => {
    expect(capitalVerdict(null)).toBeNull();
    expect(capitalVerdict({ headline: { blendedLtvCac: null } })).toBeNull();
  });
});

describe("ebitdaVerdict", () => {
  const bridge = (over = {}) => ({
    rows: [],
    revenue: 20000,
    cogs: 9000,
    grossProfit: 11000,
    marketing: { total: 2100 },
    contribution: 8900,
    contributionMarginPct: 44.5,
    overhead: { total: 2600 },
    overheadEntered: true,
    ebitda: 6300,
    ebitdaMarginPct: 31.5,
    uncostedRevenue: 0,
    ...over,
  });

  it("healthy month: states the revenue→EBITDA path", () => {
    const v = ebitdaVerdict(bridge());
    expect(v.happened).toContain("$20,000");
    expect(v.happened).toContain("$6,300");
    expect(v.happened).toContain("31.5%");
    expect(v.tone).toBe("good");
  });

  it("unentered overhead stops at contribution and points at Settings", () => {
    const v = ebitdaVerdict(bridge({ overheadEntered: false, overhead: null, ebitda: null, ebitdaMarginPct: null }));
    expect(v.happened).toContain("contribution");
    expect(v.action).toContain("operating costs");
    expect(v.tone).toBe("neutral");
  });

  it("operating loss names the biggest cost block", () => {
    const v = ebitdaVerdict(bridge({ ebitda: -1200, ebitdaMarginPct: -6, cogs: 15000 }));
    expect(v.tone).toBe("bad");
    expect(v.action).toContain("COGS");
  });

  it("thin margin (<10%) warns before recommending more spend", () => {
    const v = ebitdaVerdict(bridge({ ebitda: 1500, ebitdaMarginPct: 7.5 }));
    expect(v.tone).toBe("warn");
  });

  it("surfaces uncosted revenue as a visible caveat only when material (>5%)", () => {
    expect(ebitdaVerdict(bridge({ uncostedRevenue: 5000 })).caveat).toContain("$5,000");
    expect(ebitdaVerdict(bridge({ uncostedRevenue: 100 })).caveat).toBeNull();
  });

  it("null on missing payload", () => {
    expect(ebitdaVerdict(null)).toBeNull();
    expect(ebitdaVerdict({})).toBeNull();
  });
});

describe("small-sample verdicts stay neutral (visible, not tooltip'd)", () => {
  it("captureVerdict refuses a close-rate judgement off <5 decided estimates", () => {
    const v = captureVerdict({ captureRate: 100, captured: 500, missed: 0, wonCount: 2, lostCount: 1 });
    expect(v.tone).toBe("neutral");
    expect(v.sampleN).toBe(3);
    expect(v.action).toContain("Too few");
  });

  it("funnelVerdict refuses tuning advice off a tiny batch", () => {
    const v = funnelVerdict({ funnel: { sent: 2, viewed: 2, accepted: 2 }, rates: { view_rate: 100, close_rate: 100 } });
    expect(v.tone).toBe("neutral");
    expect(v.sampleN).toBe(2);
  });

  it("but judges normally at n>=5", () => {
    const v = captureVerdict({ captureRate: 80, captured: 4000, missed: 1000, wonCount: 4, lostCount: 2 });
    expect(v.tone).toBe("good");
  });
});

describe("remaining card verdicts", () => {
  it("completionVerdict: remaining jobs are the action", () => {
    const v = completionVerdict({ total: 6, completed: 3, remaining: 2, cancelled: 1, noShow: 0 });
    expect(v.happened).toContain("3 of 6");
    expect(v.action).toContain("2 jobs");
  });

  it("mrrVerdict: negative net is a churn alarm", () => {
    const v = mrrVerdict({ net: -55, new: 0, churned: 55 });
    expect(v.tone).toBe("bad");
    expect(v.action).toContain("at-risk");
  });

  it("mrrVerdict: a dead-flat period is neutral, not 'pure growth'", () => {
    const v = mrrVerdict({ net: 0, new: 0, churned: 0 });
    expect(v.tone).toBe("neutral");
    expect(v.happened).toContain("No recurring-revenue movement");
  });

  it("agingVerdict: 90+ buckets dominate the action", () => {
    const v = agingVerdict({
      aging: { current: 500, days_30: 200, days_120: 300, days_120_plus: 100 },
      total_outstanding: 1100,
      total_overdue: 600,
    });
    expect(v.tone).toBe("bad");
    expect(v.action).toContain("$400");
  });

  it("all return null on empty payloads", () => {
    expect(completionVerdict({ total: 0 })).toBeNull();
    expect(mrrVerdict(null)).toBeNull();
    expect(agingVerdict({ aging: {} })).toBeNull();
    expect(captureVerdict(null)).toBeNull();
    expect(funnelVerdict({ funnel: { sent: 0 } })).toBeNull();
  });
});
