// Pure selectors for the dashboard scorecard: sample-size confidence tiers,
// CAC-payback formatting, and the per-card "What happened? → What should I do?"
// verdict builders. No React, no fetches — every function takes the API payload
// its card already receives and returns plain data, so each is unit-testable
// and the formulas live in exactly one place (see also, server side:
// services/capital-allocation.js and services/ebitda-bridge.js).

// Below this many observations a rate is noise, not signal. Mirrors the server
// MIN_CONFIDENT_CUSTOMERS in capital-allocation.js and KpiTile's fade.
export const MIN_CONFIDENT_N = 5;

// Sample-size tier for a count of observations. The label is meant to be
// RENDERED (a visible badge), never tucked into a tooltip.
export function confidenceTier(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return { tier: "none", label: "No data yet" };
  if (v < MIN_CONFIDENT_N) return { tier: "low", label: `Low sample · n=${v}` };
  return { tier: "ok", label: null };
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usd = (n) => USD.format(Math.round(Number(n) || 0));

// CAC payback for display. The horizon is the 12-month gross-profit LTV the
// server ratio is built on, so anything beyond it reads as "not within a year".
export function fmtPayback(months) {
  if (months == null || !Number.isFinite(Number(months))) return null;
  const m = Number(months);
  if (m > 12) return ">12 mo";
  if (m < 1) return "<1 mo";
  return `${Math.round(m * 10) / 10} mo payback`;
}

// ─── Verdict builders ─────────────────────────────────────────────
//
// Each returns { happened, action, tone } (+ optional caveat) or null when the
// card has nothing to judge (the card then shows its own empty state). tone:
// 'good' | 'warn' | 'bad' | 'neutral' — the Verdict component maps it to the
// dashboard's documented traffic-light exception.

// Where to Put Ad Dollars — /admin/ads/capital-allocation payload.
export function capitalVerdict(capAlloc) {
  const h = capAlloc?.headline;
  if (!h || h.blendedLtvCac == null) return null;
  const lowN = h.blendedConfidence === "low";
  const parts = [
    `Paid channels returned ${h.blendedLtvCac}:1 in lifetime gross profit on ${usd(h.paidSpend)} of all-in marketing spend`,
  ];
  if (h.blendedCac != null) {
    const payback = fmtPayback(h.blendedPaybackMonths);
    parts.push(`a customer costs ${usd(h.blendedCac)}${payback ? ` (${payback})` : ""}`);
  }
  const happened = `${parts.join(" — ")}.`;

  if (lowN) {
    return {
      happened,
      action: `Only ${h.blendedCustomers} paid customer${h.blendedCustomers === 1 ? "" : "s"} in this window — too few to reallocate budget on. Hold spend steady and let the sample build.`,
      tone: "neutral",
    };
  }
  if (h.biggestLeak) {
    return {
      happened,
      action: `Cut or fix ${h.biggestLeak.source} (${h.biggestLeak.ltvCac}:1 — returning less than it costs)${h.topOpportunity ? `; shift that budget toward ${h.topOpportunity.source} (${h.topOpportunity.ltvCac}:1)` : ""}.`,
      tone: "bad",
    };
  }
  if (h.topOpportunity) {
    return {
      happened,
      action: `Put the next ad dollar into ${h.topOpportunity.source} (${h.topOpportunity.ltvCac}:1) — it's returning well above the 3:1 floor and can absorb more.`,
      tone: "good",
    };
  }
  if (h.blendedBand === "losing" || h.blendedBand === "below_target") {
    return {
      happened,
      action: "Blend is under the 3:1 floor — improve close rate or targeting before adding spend.",
      tone: h.blendedBand === "losing" ? "bad" : "warn",
    };
  }
  return { happened, action: "Returns are healthy across the board — hold current allocation.", tone: "good" };
}

// Adjusted-EBITDA bridge — /admin/dashboard/ebitda-bridge payload.
export function ebitdaVerdict(bridge) {
  if (!bridge || !Array.isArray(bridge.rows) || bridge.revenue == null) return null;
  // Uncosted revenue understates GP — surface it as a visible caveat once it's
  // a meaningful slice (>5% of revenue), not a tooltip.
  const caveat =
    bridge.uncostedRevenue > 0 && bridge.revenue > 0 && bridge.uncostedRevenue / bridge.revenue > 0.05
      ? `${usd(bridge.uncostedRevenue)} of revenue isn't job-costed yet — gross profit is understated until those visits are costed.`
      : null;

  if (!bridge.overheadEntered) {
    return {
      happened: `${usd(bridge.revenue)} revenue held ${usd(bridge.contribution)} contribution (${bridge.contributionMarginPct ?? "—"}%) after COGS and marketing.`,
      action: "Enter monthly operating costs (vehicle, insurance, software, admin) in company financials to complete the bridge down to adjusted EBITDA.",
      tone: "neutral",
      caveat,
    };
  }
  const happened = `${usd(bridge.revenue)} revenue became ${usd(bridge.ebitda)} adjusted EBITDA (${bridge.ebitdaMarginPct}%) after COGS, marketing, and overhead.`;
  if (bridge.ebitda < 0) {
    // Point at the biggest deduction — that's the lever.
    const costs = [
      { label: "COGS", amount: bridge.cogs },
      { label: "marketing spend", amount: bridge.marketing?.total || 0 },
      { label: "overhead", amount: bridge.overhead?.total || 0 },
    ].sort((a, b) => b.amount - a.amount);
    return {
      happened,
      action: `Running at an operating loss this month — the biggest cost block is ${costs[0].label} at ${usd(costs[0].amount)}. Start there.`,
      tone: "bad",
      caveat,
    };
  }
  if (bridge.ebitdaMarginPct != null && bridge.ebitdaMarginPct < 10) {
    return {
      happened,
      action: "Operating margin is thin (<10%) — protect gross margin on new jobs and keep overhead flat before scaling spend.",
      tone: "warn",
      caveat,
    };
  }
  return {
    happened,
    action: "Solid operating margin — safe to keep investing in the channels the allocation card flags as scalable.",
    tone: "good",
    caveat,
  };
}

// Today's Completion — /admin/dashboard/today-completion payload.
export function completionVerdict(today) {
  if (!today || !today.total) return null;
  const done = today.completed || 0;
  const remaining = today.remaining || 0;
  const problems = (today.cancelled || 0) + (today.noShow || 0);
  const happened = `${done} of ${today.total} jobs completed${problems ? ` · ${problems} cancelled/no-show` : ""}.`;
  if (remaining > 0) {
    return { happened, action: `${remaining} job${remaining === 1 ? "" : "s"} still on the board — clear them before end of day.`, tone: "neutral" };
  }
  if (problems > 0) {
    return { happened, action: "Day is closed out — follow up the cancelled/no-show visits for rebooking.", tone: "warn" };
  }
  return { happened, action: "Day fully completed — nothing to chase.", tone: "good" };
}

// Sales Capture — /admin/dashboard/sales-capture payload.
export function captureVerdict(sc) {
  if (!sc || sc.captureRate == null) return null;
  const n = (sc.wonCount || 0) + (sc.lostCount || 0);
  const { tier } = confidenceTier(n);
  const happened = `Won ${usd(sc.captured)} of ${usd((sc.captured || 0) + (sc.missed || 0))} estimated (${sc.captureRate}%) — ${sc.wonCount || 0} won, ${sc.lostCount || 0} lost.`;
  if (tier !== "ok") {
    return { happened, action: "Too few decided estimates this period to judge the close rate — keep following up the open ones.", tone: "neutral", sampleN: n };
  }
  if (sc.captureRate < 50) {
    return { happened, action: `${usd(sc.missed)} walked away — review lost estimates for price vs. follow-up speed.`, tone: "warn", sampleN: n };
  }
  return { happened, action: "Capture rate is strong — keep the follow-up cadence running.", tone: "good", sampleN: n };
}

// Estimate Funnel — /admin/dashboard/funnel payload ({ funnel, rates }).
export function funnelVerdict(data) {
  const f = data?.funnel;
  if (!f || !f.sent) return null;
  const { tier } = confidenceTier(f.sent);
  const viewRate = data.rates?.view_rate ?? null;
  const closeRate = data.rates?.close_rate ?? null;
  const happened = `${f.sent} sent → ${f.viewed || 0} viewed → ${f.accepted || 0} accepted${closeRate != null ? ` (${closeRate}% close)` : ""}.`;
  if (tier !== "ok") {
    return { happened, action: "Small batch — send more estimates before tuning the funnel.", tone: "neutral", sampleN: f.sent };
  }
  if (viewRate != null && viewRate < 50) {
    return { happened, action: "Most estimates aren't being opened — resend or text the link instead of email.", tone: "warn", sampleN: f.sent };
  }
  if (closeRate != null && closeRate < 30) {
    return { happened, action: "They're viewed but not accepted — the sticking point is the offer, not delivery. Review pricing on recent declines.", tone: "warn", sampleN: f.sent };
  }
  return { happened, action: "Funnel is converting — keep estimates going out same-day.", tone: "good", sampleN: f.sent };
}

// MRR momentum — core-kpis `momentum.mrr` ({ net, new, churned }).
export function mrrVerdict(mrr) {
  if (!mrr || mrr.net == null) return null;
  // A dead-flat period isn't "pure growth" — say so plainly.
  if (!(mrr.new > 0) && !(mrr.churned > 0)) {
    return {
      happened: "No recurring-revenue movement this period — nothing new sold, nothing lost.",
      action: "Flat MRR only compounds if you add to it — check the Growth tab for the channel to feed.",
      tone: "neutral",
    };
  }
  const happened = `${usd(mrr.new || 0)} new recurring revenue vs ${usd(mrr.churned || 0)} lost — net ${mrr.net >= 0 ? "+" : "−"}${usd(Math.abs(mrr.net))}.`;
  if (mrr.net < 0) {
    return { happened, action: "Churn outran new sales this period — check the Action Inbox's at-risk MRR list before selling more.", tone: "bad" };
  }
  if ((mrr.churned || 0) > 0) {
    return { happened, action: "Growing, but churn is nibbling — worth a look at why the lost accounts left.", tone: "good" };
  }
  return { happened, action: "Pure growth, zero churn — keep doing what you're doing.", tone: "good" };
}

// AR aging — /admin/dashboard/aging payload.
export function agingVerdict(data) {
  const a = data?.aging;
  if (!a) return null;
  const total = data.total_outstanding ?? Object.values(a).reduce((s, v) => s + (Number(v) || 0), 0);
  if (!total) return null;
  const severe = (Number(a.days_120) || 0) + (Number(a.days_120_plus) || 0);
  const overdue = Number(data.total_overdue) || 0;
  const happened = `${usd(total)} outstanding${overdue ? `, ${usd(overdue)} of it overdue` : ""}${severe ? ` — ${usd(severe)} is 90+ days old` : ""}.`;
  if (severe > 0) {
    return { happened, action: `Chase the ${usd(severe)} in 90+ buckets first — collectability drops fast from here.`, tone: "bad" };
  }
  if (overdue > 0) {
    return { happened, action: "Overdue but young — a reminder run should clear most of it.", tone: "warn" };
  }
  return { happened, action: "All receivables are current — no collections work needed.", tone: "good" };
}
