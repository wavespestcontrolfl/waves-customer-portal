import React, { useCallback, useEffect, useRef, useState } from "react";
import { DollarSign, RefreshCw, Send } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  UiSurface,
  cn,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

const formatMoney = (value) => value != null
  ? `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  : "—";

const STRATEGY_TABS = [
  { key: "money-model", label: "Money model" },
  { key: "value-calc", label: "Value equation" },
  { key: "offers", label: "Offer builder" },
  { key: "upsells", label: "Upsell engine" },
  { key: "ltv", label: "LTV analysis" },
];

export default function PricingStrategyPage({ embedded = false, onSecondaryNav } = {}) {
  const [tab, setTab] = useState("money-model");
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  useEffect(() => {
    adminFetch("/admin/pricing/dashboard")
      .then(setDashboard)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 3500);
  };

  const hubOwnsHeader = embedded && Boolean(onSecondaryNav);
  const setTabRef = useRef(setTab);
  setTabRef.current = setTab;
  useEffect(() => {
    if (!hubOwnsHeader) return undefined;
    onSecondaryNav({
      sections: STRATEGY_TABS,
      activeKey: tab,
      onChange: (key) => setTabRef.current(key),
      ariaLabel: "Strategy section",
      navGridClassName: "grid-cols-2 md:grid-cols-5",
    });
    return () => onSecondaryNav(null);
  }, [hubOwnsHeader, onSecondaryNav, tab]);

  const content = (
    <div className="space-y-5">
      <p className="max-w-3xl text-ui-body text-ink-secondary">
        Hormozi-style value engineering, offer architecture, and money model
      </p>
      {!hubOwnsHeader && (
        <div className="flex flex-wrap gap-2" aria-label="Strategy section">
          {STRATEGY_TABS.map((item) => (
            <Button key={item.key} variant={tab === item.key ? "primary" : "secondary"} aria-pressed={tab === item.key} onClick={() => setTab(item.key)}>
              {item.label}
            </Button>
          ))}
        </div>
      )}
      {tab === "money-model" && <MoneyModelTab dashboard={dashboard} loading={loading} />}
      {tab === "value-calc" && <ValueEquationTab />}
      {tab === "offers" && <OfferBuilderTab />}
      {tab === "upsells" && <UpsellEngineTab showToast={showToast} />}
      {tab === "ltv" && <LTVAnalysisTab />}
      {toast && (
        <Card
          role={toast.startsWith("Failed:") ? "alert" : "status"}
          className={cn(
            // md:, not sm: — AdminLayoutV2 keeps its 56px bottom tab bar below
            // useIsMobile()'s 768px default, while Tailwind's sm: starts at 640px,
            // which put the toast over the nav between 640 and 767px.
            "pointer-events-none fixed z-[300] right-4 bottom-[calc(80px+env(safe-area-inset-bottom))] md:bottom-5 max-w-[calc(100vw-32px)] px-4 py-3 shadow-lg",
            toast.startsWith("Failed:") ? "text-alert-fg" : "text-ink-primary",
          )}
        >
          {toast}
        </Card>
      )}
    </div>
  );

  // The routed path is always embedded, so the width cap has to live here too —
  // the hub caps only its header, and main capped Strategy content at 1200px.
  if (embedded) return <UiSurface density="comfortable" className="mx-auto max-w-[1200px]">{content}</UiSurface>;
  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
      <AdminCommandHeader variant="workspace" title="Pricing strategy" icon={DollarSign} />
      {content}
    </UiSurface>
  );
}

// Main coloured these KPI values by health: green healthy, amber watch, red bad.
// The shared kit has no success tone (see the batch's deferred kit gap), so a
// healthy value keeps the default ink and only the warning and alert bands —
// which the kit does have — are restored. ratioTone() is main's threshold.
const METRIC_TONES = { warn: "text-warn-fg", alert: "text-alert-fg" };
function ratioTone(ratio) {
  if (ratio == null) return undefined;
  if (ratio >= 3) return undefined;
  return ratio >= 2 ? "warn" : "alert";
}

function MetricCard({ label, value, tone }) {
  return (
    <Card>
      <CardBody className="text-center">
        <div className={`text-22 leading-tight font-medium u-nums ${METRIC_TONES[tone] || "text-zinc-900"}`}>{value}</div>
        <div className="mt-1 text-ui-caption text-ink-secondary">{label}</div>
      </CardBody>
    </Card>
  );
}

function MoneyModelTab({ dashboard, loading }) {
  if (loading) return <ActionFeedback className="min-h-20">Loading money model...</ActionFeedback>;
  // GET /admin/pricing/dashboard returns overview / stages / funnel
  // (server/services/pricing-intelligence.js:397-435). The flat totalCustomers,
  // mrr and revenueByStage fields this tab used to read are not in that
  // response, so every KPI rendered as 0 and every stage as $0.00.
  const data = dashboard || {};
  const overview = data.overview || {};
  const funnel = data.funnel || {};
  const stages = data.stages || {};
  const metrics = [
    { label: "Total customers", value: overview.totalCustomers || 0 },
    { label: "Avg LTV", value: formatMoney(overview.avgLTV) },
    { label: "Avg CAC", value: formatMoney(overview.avgCAC) },
    { label: "LTV:CAC ratio", value: overview.ltvToCacRatio != null ? `${overview.ltvToCacRatio.toFixed(1)}x` : "—", tone: ratioTone(overview.ltvToCacRatio) },
    { label: "Monthly recurring", value: formatMoney(overview.monthlyRecurringRevenue) },
  ];
  // Only Core carries a money figure in the contract; the other three stages
  // report counts. Each card names the unit it is actually showing so a count
  // like "14 completed services" cannot read as revenue beside Core's dollars.
  const stageRows = [
    { stage: "Stage I: Attraction", desc: "First service / one-time", value: stages.attraction?.acceptedEstimates ?? 0, unit: "accepted estimates" },
    { stage: "Stage II: Core", desc: "WaveGuard recurring", value: formatMoney(stages.core?.monthlyRecurring), unit: "monthly recurring" },
    { stage: "Stage III: Upsell", desc: "Add-ons & upgrades", value: stages.upsell?.totalCompletedServices ?? 0, unit: "completed services" },
    { stage: "Stage IV: Continuity", desc: "Retention & renewals", value: stages.continuity?.totalRetained ?? 0, unit: "retained customers" },
  ];
  const funnelRows = [
    { label: "Leads", value: funnel.leads },
    { label: "Estimates", value: funnel.estimates },
    { label: "Accepted", value: funnel.accepted },
    { label: "Active", value: funnel.active },
    // totalRetained is every active member with a member_since
    // (pricing-intelligence.js:371-386), including sub-6-month ones, so it
    // cannot stand in for "6mo+". Sum the buckets that actually qualify.
    { label: "Retained 6mo+", value: retainedSixMonthsPlus(stages.continuity?.retentionBuckets) },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
      </div>
      <Card>
        <CardHeader><CardTitle className="text-16">$100M money model — by stage</CardTitle></CardHeader>
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stageRows.map((stage) => (
            <div key={stage.stage} className="rounded-md border-hairline border-zinc-200 bg-zinc-50 p-4 text-center">
              <div className="font-medium text-zinc-900">{stage.stage}</div>
              <div className="mt-1 text-ui-caption text-ink-secondary">{stage.desc}</div>
              <div className="mt-3 text-22 font-medium text-zinc-900 u-nums">{stage.value}</div>
              <div className="mt-1 text-ui-caption text-ink-secondary">{stage.unit}</div>
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-16">Conversion funnel</CardTitle></CardHeader>
        <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {funnelRows.map((stage, index) => (
            <div key={stage.label} className="rounded-md bg-zinc-50 p-3 text-center">
              <div className="text-18 font-medium text-zinc-900 u-nums">{stage.value || 0}</div>
              <div className="mt-1 text-ui-caption text-ink-secondary">{stage.label}</div>
              {index < 4 && <div className="mt-1 text-ui-caption text-ink-secondary u-nums">{stage.value && funnel.leads ? `${Math.round((stage.value / funnel.leads) * 100)}%` : ""}</div>}
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function ValueSlider({ label, desc, value, onChange, increaseLabel, decreaseLabel }) {
  return (
    <div>
      <label className="text-ui-body font-medium text-zinc-900">{label}</label>
      <p className="mt-1 text-ui-caption text-ink-secondary">{desc}</p>
      <div className="mt-2 rounded-md border-hairline border-zinc-200 p-3">
        <div className="mb-2 flex items-center justify-between gap-3"><span className="text-ui-caption text-ink-secondary">{decreaseLabel || "Low"}</span><Badge tone={value >= 7 ? "strong" : value >= 4 ? "warn" : "alert"}>{value}</Badge><span className="text-ui-caption text-ink-secondary">{increaseLabel || "High"}</span></div>
        <Input aria-label={label} type="range" min={1} max={10} value={value} onChange={(event) => onChange(parseInt(event.target.value, 10))} className="h-11 border-0 bg-transparent p-0 accent-zinc-900" />
      </div>
    </div>
  );
}

function retainedSixMonthsPlus(buckets) {
  if (!buckets) return undefined;
  return ["6-12mo", "12-24mo", "24mo+"].reduce((total, key) => total + (buckets[key] || 0), 0);
}

function valueScoreTone(score) {
  if (score == null) return undefined;
  if (score < 1) return "text-alert-fg";
  return score < 2 ? "text-warn-fg" : undefined;
}

function valueScoreBadgeTone(score) {
  if (score == null) return "neutral";
  if (score < 1) return "alert";
  return score < 2 ? "warn" : "strong";
}

function ValueEquationTab() {
  const [inputs, setInputs] = useState({ dreamOutcome: 7, perceivedLikelihood: 7, timeDelay: 3, effortSacrifice: 3 });
  const [result, setResult] = useState(null);
  useEffect(() => {
    let active = true;
    adminFetch("/admin/pricing/calculate-value", { method: "POST", body: JSON.stringify(inputs) })
      .then((next) => { if (active) setResult(next); })
      .catch(() => {
        if (!active) return;
        const score = Math.round(((inputs.dreamOutcome * inputs.perceivedLikelihood) / (inputs.timeDelay * inputs.effortSacrifice)) * 10);
        setResult({ valueScore: score, priceRecommendation: score > 70 ? "Premium" : score > 40 ? "Market Rate" : "Needs Work",
          positioning: score > 70 ? "You can charge 2-3x market rate" : score > 40 ? "Competitive pricing is appropriate" : "Improve the offer before raising prices" });
      });
    return () => { active = false; };
  }, [inputs]);

  const update = (key) => (value) => setInputs((previous) => ({ ...previous, [key]: value }));
  const levers = [
    { lever: "Dream outcome", current: "Pest-free, healthy lawn, protected home", improve: 'Frame as "protecting your family\'s health and your biggest investment"' },
    { lever: "Likelihood", current: "Licensed, insured, local reputation", improve: "Add guarantee language, show review count, before/after photos" },
    { lever: "Time delay", current: "Results within first treatment", improve: 'Emphasize "same-week service" and "immediate protection"' },
    { lever: "Effort", current: "Fully done-for-you", improve: 'Highlight: "We handle everything — you just unlock the gate"' },
  ];
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-16">Value equation</CardTitle><p className="mt-1 text-ui-body text-ink-secondary">Value = (Dream outcome × likelihood) ÷ (time delay × effort)</p></CardHeader>
        <CardBody className="space-y-4">
          <div className="font-medium text-zinc-900">↑ Increase these</div>
          <ValueSlider label="Dream outcome" desc="How life-changing is the result?" value={inputs.dreamOutcome} onChange={update("dreamOutcome")} decreaseLabel="Minor improvement" increaseLabel="Life-changing" />
          <ValueSlider label="Perceived likelihood" desc="Do they believe it'll work?" value={inputs.perceivedLikelihood} onChange={update("perceivedLikelihood")} decreaseLabel="Skeptical" increaseLabel="Guaranteed" />
          <div className="font-medium text-zinc-900">↓ Decrease these</div>
          <ValueSlider label="Time delay" desc="How long until they see results?" value={inputs.timeDelay} onChange={update("timeDelay")} decreaseLabel="Instant" increaseLabel="Months/years" />
          <ValueSlider label="Effort & sacrifice" desc="How much work for the customer?" value={inputs.effortSacrifice} onChange={update("effortSacrifice")} decreaseLabel="Done-for-you" increaseLabel="DIY" />
        </CardBody>
      </Card>
      <div className="space-y-5">
        <Card>
          <CardHeader><CardTitle className="text-16">Value score</CardTitle></CardHeader>
          <CardBody className="text-center">
            {/* pricing-intelligence.js:84-96 bands the score: >=5 premium,
                >=2 competitive, >=1 commodity, below that the red zone. Main
                painted a low score red; a single strong badge made a failing
                offer look like a premium one. */}
            <div className={`text-28 font-medium u-nums ${valueScoreTone(result?.valueScore) || "text-zinc-900"}`}>{result?.valueScore ?? "—"}</div>
            <Badge tone={valueScoreBadgeTone(result?.valueScore)} className="mt-3">{result?.priceRecommendation || "Calculating"}</Badge>
            {result?.positioning && <p className="mt-3 text-ui-body text-ink-secondary">{result.positioning}</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-16">Waves Pest Control value levers</CardTitle></CardHeader>
          <CardBody className="divide-y divide-zinc-200">
            {levers.map((lever) => <div key={lever.lever} className="py-3"><div className="font-medium text-zinc-900">{lever.lever}</div><div className="mt-1 text-ui-body text-zinc-700">Now: {lever.current}</div><div className="mt-1 text-ui-body text-ink-secondary">Improve: {lever.improve}</div></div>)}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

const BASE_OFFERS = [
  { name: "WaveGuard Bronze", services: 1, discount: "0%", price: "$49-89/mo", anchor: "$120+/mo", guarantee: "Satisfaction Guarantee", bonuses: ["Digital Service Reports"] },
  { name: "WaveGuard Silver", services: 2, discount: "10%", price: "$85-140/mo", anchor: "$190+/mo", guarantee: "100% Satisfaction + Free Re-treat", bonuses: ["Digital Reports", "Priority Scheduling", "Free Termite Inspection"] },
  { name: "WaveGuard Gold", services: 3, discount: "15%", price: "$130-200/mo", anchor: "$280+/mo", guarantee: "100% Satisfaction + Free Re-treat + Money Back", bonuses: ["All Silver perks", "15% Off One-Time Treatments", "24hr Response"] },
  { name: "WaveGuard Platinum", services: "4+", discount: "20%", price: "$180-280/mo", anchor: "$400+/mo", guarantee: "Unconditional Money Back", bonuses: ["All Gold perks", "Dedicated Tech", "Quarterly Property Reviews", "Loyalty Rewards"] },
];

function OfferBuilderTab() {
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch("/admin/pricing/offers").then((data) => setOffers(data.offers || [])).catch(() => {}).finally(() => setLoading(false)); }, []);
  if (loading) return <ActionFeedback className="min-h-20">Loading offers...</ActionFeedback>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-18 font-medium text-zinc-900">Grand Slam offers</h2><Button>+ New offer</Button></div>
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        {BASE_OFFERS.map((offer) => (
          <Card key={offer.name}><CardHeader><CardTitle className="text-16">{offer.name}</CardTitle></CardHeader><CardBody className="space-y-3">
            <div className="flex flex-wrap gap-2"><Badge>{offer.services} service{offer.services !== 1 ? "s" : ""}</Badge><Badge tone="strong">{offer.discount} off</Badge></div>
            <dl className="space-y-2"><div className="flex justify-between gap-3"><dt className="text-ink-secondary">Price</dt><dd className="font-medium u-nums">{offer.price}</dd></div><div className="flex justify-between gap-3"><dt className="text-ink-secondary">Anchor (without us)</dt><dd className="line-through u-nums">{offer.anchor}</dd></div></dl>
            <p className="font-medium text-zinc-900">{offer.guarantee}</p>
            <ul className="space-y-1 text-ui-body text-ink-secondary">{offer.bonuses.map((bonus) => <li key={bonus}>{bonus}</li>)}</ul>
          </CardBody></Card>
        ))}
      </div>
      {offers.length > 0 && <Card><CardHeader><CardTitle className="text-16">Custom offer packages</CardTitle></CardHeader><CardBody className="divide-y divide-zinc-200">{offers.map((offer) => <div key={offer.id} className="py-3"><div className="font-medium text-zinc-900">{offer.name}</div><div className="mt-1 text-ui-body text-ink-secondary">{offer.description}</div>{offer.conversion_rate > 0 && <div className="mt-1 text-ui-caption text-ink-secondary u-nums">Conversion: {offer.conversion_rate}%</div>}</div>)}</CardBody></Card>}
    </div>
  );
}

// GET /admin/pricing/upsell-opportunities returns { customer, upsell } pairs
// (server/routes/admin-pricing-strategy.js:243-253). The page had been reading a
// flat row, so every opportunity rendered as undefined; project the real shape.
function normalizeOpportunity({ customer = {}, upsell = {} }) {
  return {
    customerId: customer.id,
    customerName: customer.name,
    currentTier: customer.tier,
    monthlyRate: customer.monthlyRate,
    potentialAdd: upsell.estimatedMonthlyAdd,
    suggestedService: upsell.service,
  };
}

function UpsellEngineTab({ showToast }) {
  const [rules, setRules] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    Promise.all([
      adminFetch("/admin/pricing/upsell-rules").catch(() => ({ rules: [] })),
      adminFetch("/admin/pricing/upsell-opportunities").catch(() => ({ opportunities: [] })),
    ]).then(([ruleData, opportunityData]) => { setRules(ruleData.rules || []); setOpportunities((opportunityData.opportunities || []).map(normalizeOpportunity)); setLoading(false); });
  }, []);
  const triggerUpsell = async (customerId) => {
    // The route returns { success, upsell, messageSent } and never a `message`
    // (admin-pricing-strategy.js:367), and messageSent is the outbound SMS body
    // rather than operator-facing copy, so the generic confirmation is the only
    // branch that was ever reachable.
    try { await adminFetch(
        `/admin/pricing/trigger-upsell/${customerId}`,
        { method: "POST" },
      );
      showToast("Upsell SMS sent!"); }
    catch (error) { showToast(`Failed: ${error.message}`); }
  };
  if (loading) return <ActionFeedback className="min-h-20">Loading upsell data...</ActionFeedback>;
  return (
    <div className="space-y-5">
      <Card><CardHeader><CardTitle className="text-16">Upsell opportunities ({opportunities.length})</CardTitle></CardHeader><CardBody className="divide-y divide-zinc-200">
        {opportunities.length === 0 ? <p className="py-6 text-center text-ink-secondary">No upsell opportunities found</p> : opportunities.slice(0, 10).map((opportunity) => (
          <div key={opportunity.customerId} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3"><div><div className="font-medium text-zinc-900">{opportunity.customerName}</div>{/* No service count: neither findBestUpsell branch
                (pricing-intelligence.js:268-312) returns one, so main's
                "{serviceCount} services" always rendered undefined. */}
              <div className="text-ui-caption text-ink-secondary">Currently: {opportunity.currentTier} · {formatMoney(opportunity.monthlyRate)}/mo</div></div><div className="flex flex-wrap items-center gap-3"><div><div className="font-medium u-nums">+{formatMoney(opportunity.potentialAdd)}/mo</div><div className="text-ui-caption text-ink-secondary">{opportunity.suggestedService}</div></div><Button onClick={() => triggerUpsell(opportunity.customerId)}><Send size={16} aria-hidden /> Send offer</Button></div></div>
        ))}
      </CardBody></Card>
      <Card><CardHeader><CardTitle className="text-16">Upsell rules</CardTitle></CardHeader><CardBody className="divide-y divide-zinc-200">
        {rules.length === 0 ? <p className="py-6 text-center text-ink-secondary">No upsell rules configured</p> : rules.map((rule) => <div key={rule.id} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3"><div><div className="font-medium text-zinc-900">{rule.name}</div><div className="text-ui-caption text-ink-secondary">Trigger: {rule.trigger_event} · Offer: {rule.offer_service}</div></div><div className="flex flex-wrap items-center gap-2"><span className="text-ui-caption text-ink-secondary u-nums">{rule.times_triggered || 0} triggered · {rule.times_converted || 0} converted</span><Badge tone={rule.enabled ? "strong" : "neutral"}>{rule.enabled ? "Active" : "Disabled"}</Badge></div></div>)}
      </CardBody></Card>
    </div>
  );
}

function LTVAnalysisTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  // A mounted ref, not an effect-scoped flag: recalculate() outlives the effect,
  // so both async paths need the same guard before they setState.
  const mounted = useRef(true);
  // Re-armed in setup, not just cleared in cleanup: StrictMode runs
  // setup → cleanup → setup in development, and a cleanup-only ref would stay
  // false for the second setup and strand the tab on "Loading LTV analysis...".
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    adminFetch("/admin/pricing/ltv-analysis")
      .then((next) => { if (mounted.current) setData(next); })
      .catch(() => {})
      .finally(() => { if (mounted.current) setLoading(false); });
  }, []);
  const recalculate = useCallback(async () => {
    setRecalculating(true);
    try {
      await adminFetch("/admin/pricing/recalculate-ltv", { method: "POST" });
      const next = await adminFetch("/admin/pricing/ltv-analysis");
      if (mounted.current) setData(next);
    }
    catch { /* Existing behavior leaves the last snapshot visible. */ }
    if (mounted.current) setRecalculating(false);
  }, []);
  if (loading) return <ActionFeedback className="min-h-20">Loading LTV analysis...</ActionFeedback>;
  if (!data) return <ActionFeedback className="min-h-20">No LTV data yet. Click "Recalculate" to generate.</ActionFeedback>;
  // GET /admin/pricing/ltv-analysis returns summary / channelPerformance /
  // retentionCurve (server/routes/admin-pricing-strategy.js:451-478); the flat
  // fields this tab used to read are not part of that response.
  const summary = data.summary || {};
  const channels = data.channelPerformance || [];
  // A measured 0 is data (positive CAC, zero LTV) — only an unmeasurable ratio
  // is null, so the checks below test for null rather than truthiness.
  const ltvCacRatio = summary.avgCAC > 0 ? summary.avgLTV / summary.avgCAC : null;
  // The route happens to sort channelPerformance by roi desc, but the tile should
  // not depend on response ordering to name the top performer.
  // Only channels with a measured ROI are ranked: the server emits null for a
  // zero-cost channel and 0 for a measured-but-unprofitable one, and its own sort
  // maps both to zero, so encounter order could otherwise crown an unmeasurable
  // organic channel over a measured one. A genuine numeric 0 still seeds.
  const bestChannel = channels
    .filter((channel) => channel.roi != null)
    .reduce((best, channel) => (best === null || channel.roi > best.roi ? channel : best), null)?.source;
  const retention12mo = data.retentionCurve?.["12mo"]?.pct;
  const metrics = [
    { label: "Avg LTV", value: formatMoney(summary.avgLTV) }, { label: "Avg CAC", value: formatMoney(summary.avgCAC) },
    { label: "LTV:CAC", value: ltvCacRatio != null ? `${ltvCacRatio.toFixed(1)}x` : "—", tone: ratioTone(ltvCacRatio) },
    { label: "Best channel", value: bestChannel || "—" }, { label: "12mo retention", value: retention12mo != null ? `${retention12mo}%` : "—" },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-18 font-medium text-zinc-900">Customer lifetime value</h2><Button onClick={recalculate} loading={recalculating}><RefreshCw size={16} aria-hidden /> {recalculating ? "Recalculating..." : "Recalculate all"}</Button></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}</div>
      {channels.length > 0 && <Card><CardHeader><CardTitle className="text-16">LTV by acquisition channel</CardTitle></CardHeader><CardBody className="divide-y divide-zinc-200">{channels.map((stats) => <div key={stats.source} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3"><span className="font-medium text-zinc-900">{stats.source}</span><div className="flex flex-wrap gap-4 text-ui-body text-ink-secondary u-nums"><span>{stats.customerCount} customers</span><span>LTV: {formatMoney(stats.avgLTV)}</span><span>CAC: {formatMoney(stats.avgCAC)}</span><span>{stats.avgCAC > 0 ? `${(stats.avgLTV / stats.avgCAC).toFixed(1)}x` : "—"}</span></div></div>)}</CardBody></Card>}
    </div>
  );
}
