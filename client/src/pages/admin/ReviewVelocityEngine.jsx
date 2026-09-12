import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Phone, MessageSquare, X } from "lucide-react";
import {
  Badge,
  Button,
  buttonStyles,
  Checkbox,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Sheet,
  SheetBody,
  SheetHeader,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Textarea,
} from "../../components/ui";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}

// ── GBP Locations ──
//
// Source of truth: server/config/locations.js (WAVES_LOCATIONS). The four
// IDs / review URLs below mirror that file exactly so the
// /admin/reviews/outreach-candidates response (which returns
// customers.nearest_location_id) joins cleanly without falling back to
// city-zone routing. Waves operates four GBPs — Lakewood Ranch (HQ),
// Parrish, Sarasota, and Venice. Port Charlotte / Punta Gorda is in the
// service footprint but does NOT have its own GBP — those customers
// route to Venice. Zones / zips below are kept aligned with the
// CITY_TO_LOCATION map in server/config/locations.js.
const GBP_LOCATIONS = [
  {
    id: "bradenton",
    name: "Lakewood Ranch",
    zones: ["lakewood ranch", "bradenton", "university park"],
    zips: [
      "34201",
      "34202",
      "34203",
      "34205",
      "34207",
      "34208",
      "34209",
      "34210",
      "34211",
      "34212",
    ],
    reviewUrl: "https://g.page/r/CVRc_P5butTMEBM/review",
    outboundNumber: "+19413187612",
  },
  {
    id: "parrish",
    name: "Parrish",
    zones: [
      "parrish",
      "palmetto",
      "ellenton",
      "ruskin",
      "apollo beach",
      "terra ceia",
      "memphis",
    ],
    zips: ["34219", "34221", "34222"],
    reviewUrl: "https://g.page/r/Ca-4KKoWwFacEBM/review",
    outboundNumber: "+19412972817",
  },
  {
    id: "sarasota",
    name: "Sarasota",
    zones: [
      "sarasota",
      "siesta key",
      "lido key",
      "osprey",
      "longboat key",
      "bee ridge",
      "fruitville",
    ],
    zips: [
      "34231",
      "34232",
      "34233",
      "34234",
      "34235",
      "34236",
      "34237",
      "34238",
      "34239",
      "34240",
      "34241",
      "34242",
      "34243",
    ],
    reviewUrl: "https://g.page/r/CRkzS6M4EpncEBM/review",
    outboundNumber: "+19412972606",
  },
  {
    id: "venice",
    name: "Venice",
    zones: [
      "venice",
      "north port",
      "englewood",
      "nokomis",
      "port charlotte",
      "punta gorda",
      "warm mineral springs",
      "wellen park",
    ],
    zips: [
      "34275",
      "34285",
      "34286",
      "34287",
      "34288",
      "34289",
      "34291",
      "34292",
      "34293",
      "33947",
      "33948",
      "33949",
      "33950",
      "33952",
      "33953",
      "33954",
      "33955",
      "33980",
      "33981",
      "33982",
      "33983",
    ],
    reviewUrl: "https://g.page/r/CURA5pQ1KatBEBM/review",
    outboundNumber: "+19412973337",
  },
];
const STAGES = {
  not_contacted: {
    label: "Not Contacted",
    tag: "acc",
  },
  sms_sent: {
    label: "SMS Sent",
    tag: "org",
  },
  reminded: {
    label: "Reminded",
    tag: "blu",
  },
  reviewed: {
    label: "Reviewed",
    tag: "grn",
  },
  declined: {
    label: "Declined",
    tag: "pur",
  },
  issue: {
    label: "Issue",
    tag: "red",
  },
};

// Mirror of server/services/review-outreach-templates.js (presentation-only —
// the server registry is what actually sends). One-segment bodies, owner spec
// 2026-08-06: keep in lockstep when either side changes.
const TEMPLATES = [
  {
    id: "day0_ask",
    name: "Day-0 Ask",
    sentiment: "happy",
    body: "Hi {first}! {sender}. If we earned it, a Google review means a lot: {review_url} Reply if anything's off.",
  },
  {
    id: "friendly_ask",
    name: "Friendly Ask",
    sentiment: "happy",
    body: "Hey {first}! Adam with Waves here. If we earned it, a quick Google review would mean the world:\n\n{review_url}",
  },
  {
    id: "soft_reminder",
    name: "Soft Reminder",
    sentiment: "happy",
    body: "Hi {first}! Just a quick nudge from Waves - that review link one more time:\n\n{review_url}",
  },
  {
    id: "final_nudge",
    name: "Final Nudge (email)",
    sentiment: "happy",
    body: "Hey {first} - last one from us, promise! If you have been happy with Waves, a quick review means a lot:\n\n{review_url}",
  },
  {
    id: "post_service_hot",
    name: "Post-Service Hot (2hr)",
    sentiment: "happy",
    body: "Hey {first}! {tech} here, just finished up at your place. A quick Google review would make my day:\n\n{review_url}",
  },
  {
    id: "service_specific_pest",
    name: "Service-Specific: Pest Control",
    sentiment: "happy",
    body: "Hi {first}! Hope the bugs are staying away after your treatment. If we earned it:\n\n{review_url}",
  },
  {
    id: "service_specific_lawn",
    name: "Service-Specific: Lawn Care",
    sentiment: "happy",
    body: "Hey {first}! Hope the yard is looking great. If you love the results, a quick review helps:\n\n{review_url}",
  },
  {
    id: "resolution_check",
    name: "Issue Resolution Check",
    sentiment: "issue",
    body: "Hi {first}, Adam with Waves. Just making sure everything has been taken care of - if there is anything else we can do, reply here anytime.",
  },
  {
    id: "satisfaction_confirm",
    name: "Satisfaction Confirm",
    sentiment: "issue",
    body: "Hey {first} - checking in one more time. Is everything resolved to your satisfaction? Let me know!",
  },
  {
    id: "recovery_review",
    name: "Recovery → Review",
    sentiment: "issue",
    body: "Hi {first}! Glad we got it sorted. Would you mind sharing your experience?\n\n{review_url}\n\nThank you!",
  },
  {
    id: "winback_checkin",
    name: "Win-Back Check-In",
    sentiment: "neutral",
    body: "Hey {first}! It has been a while since your last Waves service - hope all is well. Need anything, just reply!",
  },
  {
    id: "winback_ask",
    name: "Win-Back Review Ask",
    sentiment: "neutral",
    body: "Hi {first}! We never got to ask - if you were happy with your Waves service, a quick review would mean a lot:\n\n{review_url}",
  },
  {
    id: "qr_followup",
    name: "QR Code Follow-Up",
    sentiment: "happy",
    body: "Hey {first}! Great seeing you today. Here is that review link one more time:\n\n{review_url}",
  },
  // first_treatment_ask is deliberately NOT offered here (codex #3235 r12
  // P1, superseding the r3 mirror-parity note): it is a cadence-internal,
  // cap-exempt plan template — a one-off composer send would detach it from
  // its treatment series (no sequence linkage for the final-visit exemption)
  // and hand it to the legacy follow-up machinery.
];

// ── Helpers ──
function routeToGBP(addr) {
  if (!addr) return GBP_LOCATIONS[0];
  const lower = addr.toLowerCase();
  for (const loc of GBP_LOCATIONS) {
    for (const zone of loc.zones) {
      if (lower.includes(zone)) return loc;
    }
    for (const zip of loc.zips) {
      if (lower.includes(zip)) return loc;
    }
  }
  return GBP_LOCATIONS[0];
}
function calcScore(sentiment, daysAgo, revenue, stage, askCount, svcType) {
  let score = 0;
  if (sentiment === "happy") score += 35;
  else if (sentiment === "neutral") score += 15;
  if (daysAgo <= 7) score += 25;
  else if (daysAgo <= 14) score += 22;
  else if (daysAgo <= 30) score += 18;
  else if (daysAgo <= 60) score += 10;
  else score += 3;
  if (revenue >= 200) score += 15;
  else if (revenue >= 100) score += 10;
  else score += 5;
  if (askCount === 0) score += 15;
  else if (askCount === 1) score += 5;
  if (stage === "reviewed") score -= 20;
  if (stage === "issue") score -= 15;
  if (["Termite Protection", "Mosquito Control"].includes(svcType)) score += 5;
  return Math.max(0, Math.min(100, score));
}

// The cadence's stored decision (review_sequences.decision, written by
// enrollment and every step-runner deferral) rendered the same way the
// completion panel explains it: reason, planned/next time, owner action.
const DECISION_LABELS = {
  smart_window: "Day-0 ask at the smart send window",
  operator_timing: "Day-0 ask at the time chosen on the completion panel",
  customer_requested: "Customer asked for the link — next cadence tick",
  immediate: "First touch sending now",
  opener_in_flight: "Series final parked until the opener's send settles",
  follow_up_scheduled: "Follow-up scheduled",
  // The runner's 3-day-rule hold and its fail-closed re-check (owner ruling
  // 2026-09-07); a private check-in that kept its day never carries these.
  spacing: "Held for the 3-day rule — next ask at last ask + 72 h",
  spacing_lookup_unavailable: "Re-checking the last ask (3-day rule)",
  send_window: "Held for the 8 AM–8 PM send window",
  provider_retry: "Provider retry",
  customer_lock_held: "Waiting for another review send to finish",
  send_error_retry: "Send error — retrying",
  plan_reresolution_unavailable: "Re-checking the visit's cadence plan",
  cap_stats_unavailable: "Re-checking the ask cap",
};
const fmtETWhen = (d) =>
  new Date(d).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
function decisionLine(seq, sequencesEnabled) {
  if (!seq) return null;
  // A stranded claim (null schedule the worker never re-selects) needs a hand
  // whether or not the gate is on — say so first (codex #4140 r6 P2).
  if (seq.stranded)
    return "Send claim never settled · Owner action: check this cadence";
  // The worker skips every run while GATE_REVIEW_SEQUENCES is off — the
  // redemption sweep included — so neither an active row's next tick nor a
  // parked row's re-check is a plan: both are frozen (codex #4140 r5, r13 P2).
  // An UNKNOWN gate state is not a plan either (codex #4140 r15 P2): only a
  // confirmed-on worker earns a "Next" time. Both gates are needed — the
  // cadence cron registers only under the master GATE_CRON_JOBS.
  // The only action this page offers is the gates: with them on the worker
  // resumes an active row at its next tick and the sweep redeems (or, after
  // 24h, clears) a parked one — so say that, not a Stop this page does not
  // have (codex #4140 r18 P2).
  if (sequencesEnabled !== true)
    return `Paused — cadences are off (GATE_REVIEW_SEQUENCES / GATE_CRON_JOBS)${sequencesEnabled == null ? " or the gate state is unavailable" : ""} · Owner action: turn the gates on${seq.parked ? " — the parked final is redeemed by the next sweep" : ""}`;
  if (seq.sending) return "Sending now · Owner action: none";
  // Overdue by more than 7 days: the worker retires the row as stale at its
  // next pickup instead of sending (codex #4140 r24 P2) — no send time exists.
  if (seq.staleRetire)
    return "Overdue over 7 days — retired as stale at the next tick, nothing sends · Owner action: re-enroll from a completion if a review ask is still wanted";
  // A parked series final (deferred until the opener's send settles) is a
  // durable enrollment the redemption sweep redeems — not "no cadence"
  // (codex #4140 r12 P2). It needs no branch of its own: its stored
  // decision is opener_in_flight with no plannedAt, so it renders below as
  // "Re-check <tick> · Series final parked… · Owner action: none" — the
  // tick because the sweep runs on the cadence ticks (nextSendTickAt),
  // not at the raw park time (codex #4140 r13 P2).
  const d = seq.decision || {};
  const label =
    DECISION_LABELS[d.reason] ||
    (d.reason ? String(d.reason).replace(/_/g, " ") : "Scheduled");
  // nextRunAt is when the row becomes ELIGIBLE; the worker runs at :14/:44,
  // so the planned send is the next tick the server computes
  // (nextSendTickAt) — a 4:30 PM row cannot text before 4:44 (codex #4140 r4).
  const when =
    seq.nextSendTickAt || seq.nextRunAt || d.plannedAt || d.nextEvalAt;
  // An ask step that swaps channel at send time lands on the other channel's
  // tick — say both when they differ (codex #4140 r14, r16 P2).
  const fallback = seq.fallbackTickAt
    ? ` by ${seq.plannedChannel}, or ${fmtETWhen(seq.fallbackTickAt)} if it falls back to ${seq.fallbackChannel}`
    : "";
  const whenText = when ? `${fmtETWhen(when)}${fallback}` : null;
  const owner =
    d.ownerAction && d.ownerAction !== "none"
      ? `Owner action: ${d.ownerAction}`
      : "Owner action: none";
  // A cadence enrolled before the decision column existed has no decision
  // until its next runner update; its next_run_at is a planned send.
  const planned = !!d.plannedAt || !d.reason;
  return [
    whenText ? `${planned ? "Next" : "Re-check"} ${whenText}` : null,
    label,
    capturedRequestText(seq, d),
    owner,
  ]
    .filter(Boolean)
    .join(" · ");
}
// A "Customer asked for the link" captured against a cadence that was already
// running keeps that cadence's own decision (its schedule is unchanged), so
// the capture is shown beside it — who and when (codex #4140 r8).
function capturedRequestText(seq, decision) {
  const c = seq.customerRequested;
  if (!c || decision.reason === "customer_requested") return null;
  const at = c.at ? fmtETWhen(c.at) : null;
  return [
    "Customer asked for the link",
    c.byName ? `captured by ${c.byName}` : null,
    at,
  ]
    .filter(Boolean)
    .join(" ");
}
function fmtDate(d) {
  if (!d) return "—";
  if (typeof d === "string") return d;
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
function fmtPh(p) {
  if (!p) return "";
  p = p.replace(/\D/g, "");
  if (p.length === 11 && p[0] === "1") p = p.substring(1);
  return p.length === 10
    ? `(${p.substring(0, 3)}) ${p.substring(3, 6)}-${p.substring(6)}`
    : p;
}
function hydrate(body, c) {
  return (
    body
      .replace(/\{first\}/g, c.first)
      .replace(/\{name\}/g, c.name)
      // Tech FIRST name only — the hydrated body submits as custom copy, so the
      // server's own first-name substitution never runs on it, and a full name
      // would tip the one-segment ask templates into a second segment.
      .replace(
        /\{tech\}/g,
        String(c.lastTech || "Adam")
          .trim()
          .split(/\s+/)[0] || "Adam",
      )
      // {sender} is deliberately NOT hydrated here (codex #4139 r1): the
      // candidates feed carries no technician, so the server renders it from
      // the record ("<tech> with Waves", else "Waves Pest Control") — the same
      // way it swaps {review_url} for the tokenized link.
      .replace(/\{service_type\}/g, c.lastSvc || "pest control")
      .replace(/\{review_url\}/g, c.reviewUrl)
      .replace(/\{date\}/g, c.lastDate)
  );
}

// Map a row from /admin/reviews/outreach-candidates to the UI customer shape.
// Stage is derived from askCount (server-backed) — no localStorage override.
function apiToCustomer(row) {
  const gbp =
    GBP_LOCATIONS.find((l) => l.id === row.locationId) ||
    routeToGBP(row.city || "");
  const svcDate = row.lastServiceDate ? new Date(row.lastServiceDate) : null;
  const daysAgo = svcDate
    ? Math.max(0, Math.floor((Date.now() - svcDate.getTime()) / 86400000))
    : 999;
  const askCount = Number(row.askCount) || 0;
  const seq = row.sequence || null;
  // Stage prefers live cadence state, then ask history.
  const stage = seq
    ? "reminded"
    : askCount >= 2
      ? "reminded"
      : askCount === 1
        ? "sms_sent"
        : "not_contacted";
  // Real sentiment now flows from the server (last NPS rating); 'unknown' when
  // the customer has never rated. No longer hardcoded "happy" (audit O4).
  const sentiment = row.sentiment || "unknown";
  const revenue = Number(row.lifetimeRevenue) || 0;
  const svc = row.lastService || "General Pest Control";
  const score = calcScore(sentiment, daysAgo, revenue, stage, askCount, svc);
  const first = row.firstName || (row.name || "").split(" ")[0] || row.name;
  const addr = [row.addressLine1, row.city, row.zip].filter(Boolean).join(", ");
  return {
    id: row.id,
    name:
      row.name ||
      `${row.firstName || ""} ${row.lastName || ""}`.trim() ||
      "Unknown",
    nameKey: (row.name || "").toLowerCase().replace(/[^a-z]/g, ""),
    first,
    addr,
    phone: row.phone || "",
    phoneF: fmtPh(row.phone || ""),
    email: "",
    lastDate: svcDate ? fmtDate(svcDate) : "—",
    lastSvc: svc,
    // No technician in the candidates feed: the server resolves the tech
    // from the latest completed service when the drawer sends none.
    lastTech: null,
    sentiment,
    stage,
    score,
    gbpId: gbp.id,
    gbpName: gbp.name,
    reviewUrl: gbp.reviewUrl,
    revenue,
    daysAgo,
    jobs: [],
    sms: [],
    calls: [],
    askCount,
    hasEmail: !!row.hasEmail,
    lastAsked: row.lastAsked ? fmtDate(new Date(row.lastAsked)) : null,
    seqStep: seq
      ? seq.currentStep
      : stage === "reminded"
        ? 2
        : stage === "sms_sent"
          ? 1
          : 0,
    seqTotal: seq ? seq.totalSteps : 3,
    seqId: seq ? seq.id : null,
    sequence: seq,
    // Real send-eligibility from the server (audit O8). `sendable` gates the
    // SMS-only manual Send; `cadenceable` gates Start-Cadence (can use email).
    sendable: row.sendable !== false,
    cadenceable: row.cadenceable !== false,
    eligibilityReasons: row.eligibilityReasons || [],
    suppressed: Array.isArray(row.eligibilityReasons)
      ? row.eligibilityReasons.includes("suppressed") ||
        row.eligibilityReasons.includes("opted_out")
      : false,
    suppressReason: (row.eligibilityReasons || [])[0] || null,
  };
}

// Human-readable label for an eligibility blocker.
const ELIGIBILITY_LABELS = {
  no_contact: "No phone or email on file",
  no_phone: "No SMS phone (email only — use a cadence)",
  sms_opted_out: "Opted out of review texts (email cadence still OK)",
  sms_suppressed: "Phone on do-not-contact (email cadence still OK)",
  email_preferred: "Customer prefers email — use a cadence",
  opted_out: "Opted out of review texts",
  suppressed: "On the do-not-contact list",
  at_cap: "Already asked 3 times in the last 6 months",
  cooldown: "Asked within the last 30 days",
  in_sequence: "Already in an active cadence",
  already_active: "Already in an active cadence",
  already_reviewed: "Already left a review",
  reviewed: "Already left a review",
  stopped: "Cadence stopped immediately (no reachable contact)",
  send_in_progress: "Another send to this customer is in progress",
};
function eligibilityLabel(reasons = []) {
  if (!reasons.length) return "";
  return reasons.map((r) => ELIGIBILITY_LABELS[r] || r).join(" · ");
}

// ── Shared styles ──
// Main gave each of the 6 stage/sentiment tags (acc/org/blu/grn/pur/red) its
// own color; acc/blu/pur are all folded to the same near-black neutral
// already (the V2 token pass), so only "grn" (Reviewed — done/success),
// "org" (amber — sms_sent, a routine in-progress state) and "red" (Issue —
// the genuine failure) map onto the kit's non-neutral tones.
function Tag({ type, children }) {
  const tone =
    type === "red"
      ? "alert"
      : type === "grn"
        ? "strong"
        : type === "org"
          ? "warn"
          : "neutral";
  return <Badge tone={tone}>{children}</Badge>;
}
function Btn({ variant = "ghost", onClick, disabled, children }) {
  const sharedVariant =
    variant === "success"
      ? "primary"
      : variant === "danger"
        ? "danger"
        : variant === "warn"
          ? "secondary"
          : variant === "primary"
            ? "primary"
            : "secondary";
  return (
    <Button onClick={onClick} disabled={disabled} variant={sharedVariant}>
      {children}
    </Button>
  );
}
function SectionLabel({ children }) {
  return (
    <div className="text-ui-body font-medium text-zinc-900 mb-[6px]">
      {children}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════
export default function ReviewVelocityEngine() {
  const [page, setPage] = useState("dashboard");
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [currentFilter, setCurrentFilter] = useState("all");
  const [pipeSearch, setPipeSearch] = useState("");
  // Server-backed activity feed + funnel analytics (audit O1/O3). The old
  // localStorage "wrev_activity_log" was per-browser and never reflected real
  // sends from other sessions; it's replaced by /outreach-activity.
  const [activityLog, setActivityLog] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  // GATE_REVIEW_SEQUENCES && GATE_CRON_JOBS as the candidates response reports
  // them; null until known.
  const [sequencesEnabled, setSequencesEnabled] = useState(null);
  const [drawerCust, setDrawerCust] = useState(null);
  const [toast, setToast] = useState("");
  const [batchModal, setBatchModal] = useState(false);
  const loadActivity = useCallback(() => {
    adminFetch("/admin/reviews/outreach-activity?limit=100")
      .then((d) => {
        setActivityLog(
          (d.items || []).map((it) => ({
            type: it.type,
            msg: it.message,
            channel: it.channel,
            time: it.at
              ? new Date(it.at).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "",
          })),
        );
      })
      .catch(() => {});
  }, []);
  const loadAnalytics = useCallback(() => {
    adminFetch("/admin/reviews/outreach-analytics?days=90")
      .then((d) => setAnalytics(d))
      .catch(() => {});
  }, []);

  // Load real outreach candidates + analytics + activity from the API.
  const loadCandidates = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    adminFetch("/admin/reviews/outreach-candidates")
      .then((d) => {
        setCustomers((d.customers || []).map(apiToCustomer));
        // The gate rides with the rows (codex #4140 r15 P2); an absent value
        // stays unknown, which decisionLine treats as paused.
        setSequencesEnabled(
          typeof d.reviewSequencesEnabled === "boolean"
            ? d.reviewSequencesEnabled
            : null,
        );
        setLoading(false);
      })
      .catch((err) => {
        // A failed reload must not keep an earlier success's gate verdict —
        // the gate could have flipped while the request failed, and decisionLine
        // /Start Cadence would keep advertising sends (codex #4140 r23 P1).
        // Unknown reads as paused.
        setSequencesEnabled(null);
        setLoadError(err?.message || "Failed to load outreach candidates");
        setLoading(false);
      });
    loadAnalytics();
    loadActivity();
  }, [loadAnalytics, loadActivity]);
  useEffect(() => {
    loadCandidates();
  }, [loadCandidates]);

  // saveState is retained for the Activity tab's "Refresh" action — it now
  // re-pulls the server feed instead of writing localStorage.
  const saveState = useCallback(() => {
    loadActivity();
  }, [loadActivity]);

  // Optimistic local prepend for instant feedback; the authoritative feed is
  // re-pulled from the server after each action.
  const addLog = useCallback((type, msg) => {
    const entry = {
      type,
      msg,
      time: new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    };
    setActivityLog((prev) => [entry, ...prev].slice(0, 200));
  }, []);
  const showToast = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(""), 3500);
  }, []);
  const updateCustomer = useCallback((id, updates) => {
    setCustomers((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              ...updates,
            }
          : c,
      ),
    );
  }, []);

  // Send a real review request via the server, using the chosen template/body
  // (audit O2). Handles the accurate send-status responses (sent / deferred /
  // queued on a transient failure) instead of treating a
  // non-200 as a hard failure (audit O7).
  const sendReviewRequest = useCallback(
    async (customer, opts = {}) => {
      const svcType = customer.lastSvc;
      try {
        // `techName` is sent as-is (null when the candidates feed carries no
        // technician): the route coalesces null to "no tech" and resolves the
        // sender from the record. Keep this request expression byte-identical
        // to main — the IB coverage gate fingerprints it, and its operation
        // has not changed.
        const res = await adminFetch("/admin/reviews/send-request", {
          method: "POST",
          body: JSON.stringify({
            customerId: customer.id,
            serviceType: svcType,
            techName: customer.lastTech,
            ...(opts.templateId ? { templateId: opts.templateId } : {}),
            ...(opts.body ? { body: opts.body } : {}),
          }),
        });
        // Only mark the customer asked on an ACTUAL delivery. Deferred (quiet
        // hours), queued (transient retry), and alreadyQueued responses did NOT
        // deliver a new ask, so don't optimistically inflate askCount/stage —
        // the row reflects reality on the next candidate reload.
        if (res?.success) {
          const newAsk = (customer.askCount || 0) + 1;
          const newStage = newAsk >= 2 ? "reminded" : "sms_sent";
          updateCustomer(customer.id, {
            askCount: newAsk,
            lastAsked: fmtDate(new Date()),
            stage: newStage,
            seqStep: Math.min((customer.seqStep || 0) + 1, 3),
          });
        }
        // Re-pull the authoritative funnel + feed.
        loadAnalytics();
        loadActivity();
        if (res?.success)
          return {
            ok: true,
          };
        if (res?.deferred)
          return {
            ok: true,
            deferred: true,
            message: res.message,
          };
        if (res?.queued)
          return {
            ok: true,
            queued: true,
            message: res.message,
          };
        return {
          ok: true,
        };
      } catch (err) {
        return {
          ok: false,
          error: err?.message || "Send failed",
        };
      }
    },
    [updateCustomer, loadAnalytics, loadActivity],
  );

  // Start a multi-touch cadence (Day 0/3/4) for one customer.
  const startSequence = useCallback(
    async (customer) => {
      try {
        const res = await adminFetch("/admin/reviews/outreach/start-sequence", {
          method: "POST",
          body: JSON.stringify({ customerId: customer.id }),
        });
        const r = (res?.results || [])[0] || {};
        loadCandidates();
        if (res?.started > 0 || r.started)
          return {
            ok: true,
          };
        return {
          ok: false,
          error:
            ELIGIBILITY_LABELS[r.reason] ||
            r.reason ||
            "Could not start cadence",
        };
      } catch (err) {
        return {
          ok: false,
          error: err?.message || "Could not start cadence",
        };
      }
    },
    [loadCandidates],
  );

  // ── KPI calculations ──
  // Sent/reviewed/conversion now come from /outreach-analytics (audit O1), not
  // the candidate pool — converted customers leave the pool, so deriving them
  // here always produced zero. The pool still drives pipeline-shaped counts.
  const eligible = useMemo(
    () => customers.filter((c) => !c.suppressed && c.stage !== "reviewed"),
    [customers],
  );
  const winback = useMemo(
    () =>
      customers.filter(
        (c) =>
          c.daysAgo >= 60 &&
          c.askCount === 0 &&
          !c.suppressed &&
          c.stage !== "issue",
      ),
    [customers],
  );
  const queue = useMemo(
    () => eligible.filter((c) => c.stage === "not_contacted"),
    [eligible],
  );

  // ── Pipeline filtered list ──
  const pipelineList = useMemo(() => {
    let list = customers.filter((c) => !c.suppressed);
    if (currentFilter === "hot")
      list = list.filter((c) => c.score >= 70 && c.stage === "not_contacted");
    else if (currentFilter === "winback")
      list = list.filter((c) => c.daysAgo >= 60 && c.askCount === 0);
    else if (currentFilter !== "all")
      list = list.filter((c) => c.stage === currentFilter);
    if (pipeSearch) {
      const q = pipeSearch.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.addr.toLowerCase().includes(q) ||
          c.lastSvc.toLowerCase().includes(q),
      );
    }
    return list.sort((a, b) => b.score - a.score);
  }, [customers, currentFilter, pipeSearch]);
  const tabs = [
    {
      key: "dashboard",
      label: "Dashboard",
    },
    {
      key: "pipeline",
      label: "Pipeline",
      count: pipelineList.length,
    },
    {
      key: "log",
      label: "Activity Log",
    },
  ];

  // ── Actions ──
  const quickSend = async (id) => {
    const c = customers.find((x) => x.id === id);
    if (!c) return;
    if (!c.sendable) {
      showToast(
        `Can't send to ${c.name}: ${eligibilityLabel(c.eligibilityReasons) || "not eligible"}`,
      );
      return;
    }
    showToast(`Sending to ${c.name}...`);
    const result = await sendReviewRequest(c);
    if (result.ok) {
      if (result.deferred) {
        addLog("stage", `Queued for ${c.name} → ${c.gbpName}`);
        showToast(
          result.message ||
            `Queued for ${c.name} — sends automatically on retry`,
        );
      } else if (result.queued) {
        addLog("stage", `Queued for retry: ${c.name}`);
        showToast(result.message || `Queued for retry: ${c.name}`);
      } else {
        addLog("sms", `Review request sent to ${c.name} → ${c.gbpName}`);
        showToast(`SMS sent to ${c.name}`);
      }
    } else {
      addLog("stage", `Failed to send to ${c.name}: ${result.error}`);
      showToast(`Failed: ${result.error}`);
    }
  };
  const quickStartSequence = async (id) => {
    const c = customers.find((x) => x.id === id);
    if (!c) return;
    showToast(`Starting cadence for ${c.name}...`);
    const result = await startSequence(c);
    if (result.ok) {
      addLog("batch", `Started review cadence for ${c.name}`);
      showToast(`Cadence started for ${c.name}`);
    } else {
      showToast(`Couldn't start: ${result.error}`);
    }
  };
  return (
    <div className="text-zinc-900">
      {/* Nav tabs */}
      <div className="flex justify-center mb-[20px]">
        {" "}
        <Card className="inline-flex flex-wrap items-center gap-[4px] p-[4px]">
          {tabs.map((t) => (
            <Button
              key={t.key}
              onClick={() => setPage(t.key)}
              variant={page === t.key ? "primary" : "secondary"}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-md text-ui-body font-medium ml-[6px]">
                  {t.count}
                </span>
              )}
            </Button>
          ))}
        </Card>{" "}
      </div>
      {/* Load banner */}
      {loading && (
        <Card className="p-[14px] text-ui-body text-zinc-900 mb-[14px]">
          Loading outreach candidates…
        </Card>
      )}
      {loadError && (
        <Card className="p-[14px] text-ui-body text-alert-fg mb-[14px] flex justify-between items-center">
          {" "}
          <span>Couldn't load candidates: {loadError}</span>{" "}
          <Btn onClick={loadCandidates}>Retry</Btn>{" "}
        </Card>
      )}
      {/* Pages */}
      {page === "dashboard" && (
        <Dashboard
          customers={customers}
          eligible={eligible}
          winback={winback}
          queue={queue}
          activityLog={activityLog}
          analytics={analytics}
          setPage={setPage}
        />
      )}
      {page === "pipeline" && (
        <Pipeline
          customers={pipelineList}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          currentFilter={currentFilter}
          setCurrentFilter={setCurrentFilter}
          pipeSearch={pipeSearch}
          setPipeSearch={setPipeSearch}
          quickSend={quickSend}
          quickStartSequence={quickStartSequence}
          sequencesEnabled={sequencesEnabled}
          setDrawerCust={setDrawerCust}
          setBatchModal={setBatchModal}
          addLog={addLog}
          showToast={showToast}
        />
      )}
      {page === "log" && (
        <ActivityLogPage
          activityLog={activityLog}
          setActivityLog={setActivityLog}
          saveState={saveState}
        />
      )}
      {/* Customer Drawer */}
      {drawerCust && (
        <CustomerDrawer
          customer={drawerCust}
          onClose={() => setDrawerCust(null)}
          addLog={addLog}
          showToast={showToast}
          sendReviewRequest={sendReviewRequest}
          startSequence={startSequence}
          sequencesEnabled={sequencesEnabled}
        />
      )}
      {/* Batch Modal */}
      {batchModal && (
        <BatchModal
          selectedIds={selectedIds}
          customers={customers}
          onClose={() => setBatchModal(false)}
          addLog={addLog}
          showToast={showToast}
          setSelectedIds={setSelectedIds}
          sendReviewRequest={sendReviewRequest}
        />
      )}
      {/* Toast */}
      {toast && (
        <Card
          role="status"
          className="fixed bottom-5 right-5 z-[130] flex items-center gap-2 p-3 text-ui-body font-medium shadow-lg pointer-events-none"
        >
          <span className="h-2 w-2 rounded-full bg-positive-fg" />
          <span>{toast}</span>
        </Card>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
function Dashboard({
  customers,
  winback,
  queue,
  activityLog,
  analytics,
  setPage,
}) {
  // Real funnel from /outreach-analytics (audit O1) — no longer derived from the
  // candidate pool (which structurally never contains a reviewed customer, so
  // the old "Reviewed" / "Conversion" tiles were permanently zero).
  const f = analytics?.funnel || {};
  const reviewsLanded = (analytics?.googleByLocation || []).reduce(
    (s, r) => s + (Number(r.reviews) || 0),
    0,
  );
  const kpis = [
    {
      label: "In Pipeline",
      value: customers.length,
      desc: "Active customers without a review",
    },
    {
      label: "Requests Sent",
      value: f.sent ?? "—",
      desc: "review asks sent (90d)",
    },
    {
      label: "Reviews Landed",
      value: reviewsLanded,
      desc: "Google reviews in last 90d",
    },
    {
      label: "Click→Google",
      value: f.conversionRate != null ? `${f.conversionRate}%` : "—",
      desc: `${f.reviewed ?? 0} of ${f.sent ?? 0} asks converted`,
    },
  ];
  // Digital business cards carry a passive review QR (/l kind='card');
  // scans land here so card-driven asks are visible next to the active funnel.
  const cardScans = analytics?.cardScans;
  if (cardScans && cardScans.cards > 0) {
    kpis.push({
      label: "Card QR Scans",
      value: cardScans.windowScans ?? 0,
      desc: `from ${cardScans.cards} digital cards (${cardScans.days ?? 90}d) · ${cardScans.scans} all-time`,
    });
  }

  // Conversion funnel stages + channel split for the reporting strip.
  const funnelStages = [
    {
      label: "Sent",
      value: f.sent ?? 0,
    },
    {
      label: "Opened",
      value: f.opened ?? 0,
      rate: f.openRate,
    },
    {
      label: "Rated",
      value: f.rated ?? 0,
    },
    {
      label: "Click→Google",
      value: f.reviewed ?? 0,
      rate: f.conversionRate,
    },
  ];
  const byChannel = analytics?.byChannel || [];
  const byTemplate = (analytics?.byTemplate || [])
    .slice()
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 5);
  return (
    <div>
      {/* KPIs */}
      <div className="mb-[20px]">
        {" "}
        <div className="flex justify-between items-center mb-[10px]">
          {" "}
          <div className="text-ui-body font-medium">Review Pipeline</div>{" "}
          <SectionLabel>Last 90 Days</SectionLabel>{" "}
        </div>{" "}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
          {kpis.map((k) => (
            <Card
              key={k.label}
              className="relative overflow-hidden px-[10px] py-3 sm:px-[18px] sm:py-4"
            >
              {" "}
              <div className="absolute inset-x-0 top-0 h-[2px] bg-zinc-900" />{" "}
              <div className="text-[28px] font-medium mb-[2px]">{k.value}</div>{" "}
              <div className="text-ui-body font-medium text-zinc-900 mb-[4px]">
                {k.label}
              </div>{" "}
              <div className="text-ui-body text-zinc-900">{k.desc}</div>{" "}
            </Card>
          ))}
        </div>{" "}
      </div>
      {/* Conversion Funnel + channel/template performance */}
      <div className="mb-[20px]">
        <div className="text-ui-body font-medium mb-[10px]">
          Conversion Funnel
        </div>
        <div className="grid grid-cols-1 gap-3 sm:[grid-template-columns:1.4fr_1fr]">
          {/* Funnel bars */}
          <Card className="p-[16px]">
            {funnelStages.map((s, i) => {
              const top = funnelStages[0].value || 0;
              const pct = top > 0 ? Math.round((s.value / top) * 100) : 0;
              return (
                <div
                  key={s.label}
                  className={
                    i < funnelStages.length - 1 ? "mb-[10px]" : undefined
                  }
                >
                  <div className="flex justify-between mb-[4px]">
                    <span className="text-ui-body font-medium text-zinc-900">
                      {s.label}
                    </span>
                    <span className="text-ui-body font-medium">
                      {s.value}
                      {s.rate != null && (
                        <span className="text-zinc-900 font-medium">
                          {" "}
                          · {s.rate}%
                        </span>
                      )}
                    </span>
                  </div>
                  <progress
                    className="h-2 w-full accent-zinc-900"
                    value={pct}
                    max="100"
                    aria-label={`${s.label} conversion`}
                  />
                </div>
              );
            })}
          </Card>
          {/* Channel + top templates */}
          <Card className="p-[16px]">
            <SectionLabel>By Channel</SectionLabel>
            {byChannel.length === 0 ? (
              <div className="text-ui-body text-zinc-900 mb-[10px]">
                No sends yet
              </div>
            ) : (
              <div className="flex gap-[8px] flex-wrap mb-[12px]">
                {byChannel.map((ch) => (
                  <div
                    key={ch.channel}
                    className="flex-[1] min-w-[90px] bg-white rounded-md px-[10px] py-2"
                  >
                    <div className="text-ui-body text-zinc-900">
                      {ch.channel}
                    </div>
                    <div className="text-ui-body font-medium">{ch.sent}</div>
                    <div className="text-ui-body text-zinc-900">
                      {ch.sent > 0
                        ? Math.round((ch.reviewed / ch.sent) * 100)
                        : 0}
                      % converted
                    </div>
                  </div>
                ))}
              </div>
            )}
            <SectionLabel>Top Templates</SectionLabel>
            {byTemplate.length === 0 ? (
              <div className="text-ui-body text-zinc-900">No sends yet</div>
            ) : (
              byTemplate.map((t) => (
                <div
                  key={t.templateKey}
                  className="flex justify-between border-b border-hairline border-zinc-200 py-[3px] text-ui-body"
                >
                  <span className="text-zinc-900">{t.templateKey}</span>
                  <span className="text-zinc-900">
                    {t.sent} sent ·{" "}
                    {t.sent > 0 ? Math.round((t.reviewed / t.sent) * 100) : 0}%
                  </span>
                </div>
              ))
            )}
            <div className="mt-[10px] flex flex-wrap gap-3">
              <div className="text-ui-body text-zinc-900">
                Active cadences:{" "}
                <span className="font-medium text-zinc-900">
                  {analytics?.activeSequences ?? 0}
                </span>
              </div>
              <div className="text-ui-body text-zinc-900">
                Win-back pool:{" "}
                <span className="font-medium text-zinc-900">
                  {winback.length}
                </span>
              </div>
              <div className="text-ui-body text-zinc-900">
                In queue:{" "}
                <span className="font-medium text-zinc-900">
                  {queue.length}
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>
      {/* GBP Cards */}
      <div className="mb-[20px]">
        {" "}
        <div className="flex justify-between items-center mb-[10px]">
          {" "}
          <div className="text-ui-body font-medium">Review Routing</div>{" "}
        </div>{" "}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
          {GBP_LOCATIONS.map((loc) => {
            const locCusts = customers.filter((c) => c.gbpId === loc.id);
            // Reviewed + asked now come from real analytics (audit O1), not the
            // candidate pool. "Reviewed" = actual Google reviews landed for this
            // GBP in 90d; "Asked" = review asks sent; Conv = clicked→Google.
            const gbpRow = (analytics?.googleByLocation || []).find(
              (r) => r.locationId === loc.id,
            );
            const locRow = (analytics?.byLocation || []).find(
              (r) => r.locationId === loc.id,
            );
            const locReviewed = gbpRow?.reviews ?? 0;
            const locSent = locRow?.sent ?? 0;
            const locConverted = locRow?.reviewed ?? 0;
            const locQueue = locCusts.filter(
              (c) => !c.suppressed && c.stage === "not_contacted",
            ).length;
            return (
              <Card
                key={loc.id}
                onClick={() => setPage("pipeline")}
                className="cursor-pointer p-[14px] sm:p-[18px]"
              >
                {" "}
                <div className="mb-[10px] flex items-start justify-between sm:mb-[14px]">
                  {" "}
                  <div className="text-ui-body font-medium">
                    {loc.name}
                  </div>{" "}
                  <Tag type="acc">{locCusts.length} customers</Tag>{" "}
                </div>
                {/* Stat strip — 2×2 on phones, 4-col single row on desktop so each
                    number gets more horizontal space and reads cleanly at a glance. */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    {
                      v: locReviewed,
                      l: "Reviewed",
                    },
                    {
                      v: locSent,
                      l: "Asked",
                    },
                    {
                      v: locQueue,
                      l: "In Queue",
                    },
                    {
                      v: `${locSent > 0 ? Math.round((locConverted / locSent) * 100) : 0}%`,
                      l: "Conv Rate",
                    },
                  ].map((s) => (
                    <div
                      key={s.l}
                      className="rounded-md bg-white px-1 py-2 text-center"
                    >
                      {" "}
                      <div className="text-ui-body font-medium text-zinc-900">
                        {s.v}
                      </div>{" "}
                      <div className="text-ui-body text-zinc-900 mt-[2px]">
                        {s.l}
                      </div>{" "}
                    </div>
                  ))}
                </div>{" "}
                <a
                  href={loc.reviewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={loc.reviewUrl}
                  className="mt-[10px] inline-block border-b border-dotted border-zinc-200 text-ui-body text-zinc-900"
                >
                  Open review link
                </a>{" "}
              </Card>
            );
          })}
        </div>{" "}
      </div>
      {/* Review Velocity — actual Google reviews landed per week (90d) */}
      <div className="mb-[20px]">
        {" "}
        <div className="text-ui-body font-medium mb-[10px]">
          Review Velocity
        </div>{" "}
        <VelocityChart velocity={analytics?.velocity || []} />
      </div>
      {/* Recent Activity */}
      <div>
        {" "}
        <div className="text-ui-body font-medium mb-[10px]">
          Recent Activity
        </div>{" "}
        <ActivityList log={activityLog} max={8} />{" "}
      </div>{" "}
    </div>
  );
}

// Weekly Google-review velocity bars (real data from /outreach-analytics).
function VelocityChart({ velocity }) {
  if (!velocity.length) {
    return (
      <Card className="p-[20px] text-ui-body text-zinc-900 text-center">
        No Google reviews in the last 90 days yet.
      </Card>
    );
  }
  const max = Math.max(...velocity.map((v) => v.reviews), 1);
  return (
    <Card className="p-[16px] h-[150px] overflow-x-auto">
      <div className="flex items-end gap-[6px]">
        {velocity.map((v, i) => {
          // Bars scale against 70% of the column so the value above and the
          // date below (11px each plus margins) fit inside the 150px chart
          // instead of pushing the tallest column into the heading.
          const h = Math.round((v.reviews / max) * 70);
          const wk = v.week ? new Date(v.week) : null;
          return (
            <div
              key={i}
              className="flex-[1] min-w-[32px] flex flex-col items-center justify-end"
            >
              <div className="text-ui-body font-medium text-zinc-900 mb-[2px]">
                {v.reviews}
              </div>
              <svg
                viewBox="0 0 28 72"
                className="h-[72px] w-7"
                role="img"
                aria-label={`${v.reviews} reviews`}
              >
                <rect
                  x="0"
                  y={72 - Math.max(h, 3)}
                  width="28"
                  height={Math.max(h, 3)}
                  rx="3"
                  className="fill-zinc-900"
                />
              </svg>
              <div className="text-ui-body text-zinc-900 mt-[4px]">
                {wk ? `${wk.getMonth() + 1}/${wk.getDate()}` : ""}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════
// PIPELINE
// ══════════════════════════════════════════════════════════════
function Pipeline({
  customers,
  selectedIds,
  setSelectedIds,
  currentFilter,
  setCurrentFilter,
  pipeSearch,
  setPipeSearch,
  quickSend,
  quickStartSequence,
  sequencesEnabled,
  setDrawerCust,
  setBatchModal,
}) {
  const filters = [
    {
      key: "all",
      label: "All",
    },
    {
      key: "hot",
      label: "Hot Leads",
    },
    {
      key: "not_contacted",
      label: "Not Contacted",
    },
    {
      key: "sms_sent",
      label: "SMS Sent",
    },
    {
      key: "reminded",
      label: "Reminded",
    },
    {
      key: "reviewed",
      label: "Reviewed",
    },
    {
      key: "issue",
      label: "Issues",
    },
    {
      key: "winback",
      label: "Win-Back",
    },
  ];
  const toggleSel = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = (checked) => {
    if (checked) {
      setSelectedIds(new Set(customers.map((c) => c.id)));
    } else {
      setSelectedIds(new Set());
    }
  };
  return (
    <div>
      {" "}
      <div className="text-ui-body font-medium mb-[0px]">Review Pipeline</div>
      {/* Filter bar */}
      <div className="mb-[12px] flex flex-wrap items-center gap-2 border-b border-hairline border-zinc-200 py-3">
        {" "}
        <Input
          value={pipeSearch}
          onChange={(e) => setPipeSearch(e.target.value)}
          placeholder="Search customers..."
          className="flex-[1] min-w-[200px]"
        />{" "}
        <div className="flex gap-[4px] flex-wrap">
          {filters.map((f) => (
            <Button
              key={f.key}
              onClick={() => setCurrentFilter(f.key)}
              variant={currentFilter === f.key ? "primary" : "secondary"}
            >
              {f.label}
            </Button>
          ))}
        </div>{" "}
      </div>
      {/* Batch bar */}
      {selectedIds.size > 0 && (
        <Card className="mb-[12px] flex items-center gap-2 px-4 py-[10px]">
          {" "}
          <span className="text-ui-body font-medium text-zinc-900">
            {selectedIds.size} selected
          </span>{" "}
          <div className="w-[1px] h-[20px] bg-zinc-900" />{" "}
          <Btn variant="primary" onClick={() => setBatchModal(true)}>
            Batch Send
          </Btn>{" "}
          <Btn onClick={() => setSelectedIds(new Set())}>Clear</Btn>{" "}
        </Card>
      )}
      {/* Table */}
      <div className="overflow-x-auto">
        {" "}
        <Table className="w-full">
          <THead>
            <TR>
              <TH>
                <Checkbox
                  onChange={(e) => toggleAll(e.target.checked)}
                  className="cursor-pointer"
                />
              </TH>
              <TH>Customer</TH>
              <TH>Location / GBP</TH>
              <TH>Score</TH>
              <TH>Sentiment</TH>
              <TH>Stage</TH>
              <TH>Last Service</TH>
              <TH>Seq Step</TH>
              <TH>Actions</TH>
            </TR>
          </THead>
          <TBody>
            {customers.map((c) => {
              const isSelected = selectedIds.has(c.id);
              return (
                <TR
                  key={c.id}
                  onDoubleClick={() => setDrawerCust(c)}
                  className={`cursor-pointer${isSelected ? " bg-zinc-100" : ""}`}
                >
                  <TD>
                    <Checkbox
                      checked={isSelected}
                      onChange={() => toggleSel(c.id)}
                    />
                  </TD>
                  <TD>
                    <div className="font-medium text-ui-body text-zinc-900">
                      {c.name}
                    </div>
                  </TD>
                  <TD>
                    <Tag type="acc">{c.gbpName}</Tag>
                  </TD>
                  <TD>
                    <div className="flex items-center gap-[6px]">
                      <progress
                        className="h-2 w-20 accent-zinc-900"
                        value={c.score}
                        max="100"
                        aria-label={`${c.score} review score`}
                      />
                      <span className="text-ui-body font-medium">
                        {c.score}
                      </span>
                    </div>
                  </TD>
                  <TD>
                    <Tag
                      type={
                        c.sentiment === "happy"
                          ? "grn"
                          : c.sentiment === "issue"
                            ? "red"
                            : c.sentiment === "neutral"
                              ? "org"
                              : "acc"
                      }
                    >
                      {c.sentiment}
                    </Tag>
                  </TD>
                  <TD>
                    <Tag type={STAGES[c.stage]?.tag || "acc"}>
                      {STAGES[c.stage]?.label || c.stage}
                    </Tag>
                  </TD>
                  <TD>
                    <div className="text-ui-body text-zinc-900">
                      {c.lastSvc}
                    </div>
                    <div className="text-ui-body text-zinc-900">
                      {c.lastDate} · {c.daysAgo}d ago
                    </div>
                  </TD>
                  <TD>
                    {c.sequence ? (
                      <>
                        <Tag type="blu">
                          Cadence {c.seqStep}/{c.seqTotal}
                        </Tag>
                        <div className="text-ui-body text-zinc-900 mt-[4px]">
                          {decisionLine(c.sequence, sequencesEnabled)}
                        </div>
                      </>
                    ) : c.seqStep > 0 ? (
                      <Tag type="acc">Asked {c.askCount}×</Tag>
                    ) : (
                      <span className="text-zinc-900 text-ui-body">—</span>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap">
                    <div className="flex gap-[4px] justify-end">
                      {c.phone && (
                        <Button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (
                              !window.confirm(
                                `Call ${c.name} at ${c.phoneF || c.phone}?\n\nWaves will call your phone first — press 1 to connect.`,
                              )
                            )
                              return;
                            try {
                              // Let the server resolve the From line from its
                              // own TWILIO_NUMBERS source of truth — a stale
                              // client-side GBP number would 400.
                              const r = await adminFetch(
                                "/admin/communications/call",
                                {
                                  method: "POST",
                                  body: JSON.stringify({ to: c.phone }),
                                },
                              );
                              if (!r?.success)
                                alert(
                                  "Call failed: " +
                                    (r?.error || "unknown error"),
                                );
                            } catch (err) {
                              alert("Call failed: " + err.message);
                            }
                          }}
                          aria-label="Call via Waves"
                          title="Call via Waves — rings your phone first, press 1 to connect"
                          variant="primary"
                          className="h-11 w-11 px-0 sm:h-9 sm:w-9"
                        >
                          <Phone size={12} strokeWidth={1.75} />
                        </Button>
                      )}
                      {c.phone && (
                        <a
                          href={`/admin/communications?phone=${encodeURIComponent(c.phone)}`}
                          onClick={(e) => e.stopPropagation()}
                          aria-label="SMS"
                          title={`SMS ${c.phoneF || c.phone}`}
                          className={buttonStyles({
                            variant: "secondary",
                            density: "comfortable",
                            className: "h-11 w-11 px-0 sm:h-9 sm:w-9",
                          })}
                        >
                          <MessageSquare size={12} strokeWidth={1.75} />
                        </a>
                      )}
                      {/* Send review now — disabled with the reason when the
                          customer isn't eligible (opted out, at cap, cooldown,
                          suppressed, already in a cadence). */}
                      <Button
                        type="button"
                        disabled={!c.sendable}
                        title={
                          c.sendable
                            ? "Send a review request now"
                            : eligibilityLabel(c.eligibilityReasons)
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          quickSend(c.id);
                        }}
                        variant="primary"
                        className=" whitespace-nowrap"
                      >
                        Send
                      </Button>
                      {sequencesEnabled && c.cadenceable && !c.sequence && (
                        <Button
                          type="button"
                          title="Start a Day 0/3/4 review cadence"
                          onClick={(e) => {
                            e.stopPropagation();
                            quickStartSequence(c.id);
                          }}
                          variant="secondary"
                          className=" whitespace-nowrap"
                        >
                          Cadence
                        </Button>
                      )}
                      <Button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDrawerCust(c);
                        }}
                        variant="secondary"
                        className=""
                      >
                        Edit
                      </Button>
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
        {customers.length === 0 && (
          <div className="p-[40px] text-center text-zinc-900 text-ui-body">
            No customers match your filters
          </div>
        )}
      </div>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════════════════════════════
function ActivityLogPage({ activityLog, setActivityLog, saveState }) {
  return (
    <div>
      {" "}
      <div className="flex justify-between items-center mb-[16px]">
        {" "}
        <div className="text-ui-body font-medium">Activity Log</div>{" "}
        <Btn onClick={() => saveState()}>Refresh</Btn>{" "}
      </div>{" "}
      <ActivityList log={activityLog} max={100} />{" "}
    </div>
  );
}
function ActivityList({ log, max }) {
  if (!log.length)
    return (
      <p className="text-zinc-900 p-[20px] text-center text-ui-body">
        No activity yet. Send your first review request!
      </p>
    );
  const iconMap = {
    sent: "→",
    sms: "→",
    reviewed: "★",
    rated: "#",
    call: "☎",
    batch: "≡",
    stage: "!",
  };
  return (
    <div className="max-h-[300px] overflow-y-auto">
      {log.slice(0, max).map((l, i) => {
        const glyph = iconMap[l.type] || iconMap.stage;
        return (
          <div
            key={i}
            className="flex gap-[10px] border-b border-hairline border-zinc-200 py-[10px]"
          >
            {" "}
            <div className="grid h-[28px] w-[28px] shrink-0 place-items-center rounded-sm text-ui-body font-medium">
              {glyph}
            </div>{" "}
            <div className="flex-[1] min-w-[0px]">
              {" "}
              <div className="text-ui-body">{l.msg}</div>{" "}
              <div className="text-ui-body text-zinc-900 mt-[2px]">
                {l.time}
              </div>{" "}
            </div>{" "}
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CUSTOMER DRAWER
// ══════════════════════════════════════════════════════════════
function CustomerDrawer({
  customer,
  onClose,
  addLog,
  showToast,
  sendReviewRequest,
  startSequence: startSequenceFn,
  sequencesEnabled,
}) {
  const [msg, setMsg] = useState("");
  const [selectedTpl, setSelectedTpl] = useState("");
  const [sending, setSending] = useState(false);
  const [seqStarting, setSeqStarting] = useState(false);
  const c = customer;
  const applyTpl = (tplId) => {
    setSelectedTpl(tplId);
    const tpl = TEMPLATES.find((t) => t.id === tplId);
    // Hydrate name/tech/etc. for preview, but KEEP the {review_url} token so the
    // server swaps in the tokenized /rate link. Hydrating it client-side to the
    // raw GBP URL would bypass the NPS gate (sends issues straight to Google).
    if (tpl)
      setMsg(
        hydrate(tpl.body, {
          ...c,
          reviewUrl: "{review_url}",
        }),
      );
  };

  // A no-link private check-in (resolution_check / satisfaction_confirm) bypasses
  // the review ask cap/cooldown on the server, so the client must allow it even
  // when c.sendable is false (those are review-ask-only blockers) — it just needs
  // an SMS-reachable phone.
  const selectedTplObj = TEMPLATES.find((t) => t.id === selectedTpl);
  const selectedIsNoLink = !!(
    selectedTplObj && !selectedTplObj.body.includes("{review_url}")
  );
  const canSendSelected = selectedIsNoLink ? !!c.phone : c.sendable;

  // Sends the chosen template / edited body through the server's NPS rate-page
  // flow (audit O2). The server resolves {review_url} to the tokenized /rate
  // link, so the happy→Google / issue→private gate is preserved.
  const sendSms = async () => {
    if (!canSendSelected) {
      showToast(
        selectedIsNoLink
          ? "No phone on file for a check-in"
          : eligibilityLabel(c.eligibilityReasons) || "Not eligible to send",
      );
      return;
    }
    setSending(true);
    const result = await sendReviewRequest(c, {
      templateId: selectedTpl || undefined,
      body: msg.trim() || undefined,
    });
    setSending(false);
    if (result.ok) {
      if (result.deferred || result.queued) {
        showToast(result.message || `Queued for ${c.name}`);
      } else {
        addLog("sms", `Review request sent to ${c.name} → ${c.gbpName}`);
        showToast(`Sent to ${c.name}`);
      }
      setMsg("");
    } else {
      showToast(`Failed: ${result.error}`);
    }
  };
  const startSequence = async () => {
    if (c.sequence) {
      showToast(
        c.sequence.parked
          ? "A cadence is already parked for this customer"
          : "Already in an active cadence",
      );
      return;
    }
    setSeqStarting(true);
    const result = await startSequenceFn(c);
    setSeqStarting(false);
    if (result.ok) {
      addLog("batch", `Started review cadence for ${c.name}`);
      showToast(`Cadence started for ${c.name}`);
    } else {
      showToast(`Couldn't start: ${result.error}`);
    }
  };
  const gbp = GBP_LOCATIONS.find((l) => l.id === c.gbpId);
  // With a known sentiment, surface matching + neutral templates; when it's
  // unknown (no NPS rating yet), show the full set.
  const sentimentKnown = c.sentiment === "happy" || c.sentiment === "issue";
  const filteredTpls = sentimentKnown
    ? TEMPLATES.filter(
        (t) => t.sentiment === c.sentiment || t.sentiment === "neutral",
      )
    : TEMPLATES;
  return (
    <Sheet
      open
      onClose={() => {
        if (!sending && !seqStarting) onClose();
      }}
      width="md"
      ariaLabel={`Review outreach for ${c.name}`}
    >
      {/* Header */}
      <SheetHeader className="items-start">
        {" "}
        <div>
          {" "}
          <h2 className="text-[18px] font-medium mb-[4px] m-0 text-zinc-900">
            {c.name}
          </h2>{" "}
          <div className="text-ui-body text-zinc-900">
            {c.addr} · {c.lastSvc} · {c.daysAgo} days ago
          </div>{" "}
          <div className="text-ui-body text-zinc-900 mt-[2px]">
            {c.phoneF || "No phone"}
          </div>{" "}
        </div>{" "}
        <Button
          onClick={onClose}
          disabled={sending || seqStarting}
          variant="primary"
          className="text-[18px]"
          aria-label="Close outreach details"
        >
          <X size={18} />
        </Button>{" "}
      </SheetHeader>{" "}
      <SheetBody>
        {/* Score */}
        <DrawerSection title="Review score breakdown">
          {" "}
          <div className="flex items-center gap-[10px] mb-[8px]">
            {" "}
            <div className="text-[32px] font-medium">{c.score}</div>{" "}
            <progress
              className="h-2 flex-1 accent-zinc-900"
              value={c.score}
              max="100"
              aria-label="Review readiness score"
            />{" "}
          </div>{" "}
          <div className="grid grid-cols-2 gap-1 text-ui-body">
            {[
              {
                l: "Sentiment",
                v: (
                  <Tag
                    type={
                      c.sentiment === "happy"
                        ? "grn"
                        : c.sentiment === "issue"
                          ? "red"
                          : "org"
                    }
                  >
                    {c.sentiment}
                  </Tag>
                ),
              },
              {
                l: "Recency",
                v: `${c.daysAgo}d ago`,
              },
              {
                l: "Revenue",
                v: `$${c.revenue}`,
              },
              {
                l: "Times Asked",
                v: c.askCount,
              },
              {
                l: "Stage",
                v: STAGES[c.stage]?.label,
              },
              {
                l: "Last Asked",
                v: c.lastAsked || "Never",
              },
            ].map((r) => (
              <div key={r.l} className="flex justify-between py-1">
                {" "}
                <span className="text-zinc-900">{r.l}</span>{" "}
                <span className="font-medium">{r.v}</span>{" "}
              </div>
            ))}
          </div>{" "}
        </DrawerSection>
        {/* GBP */}
        <DrawerSection title="GBP Assignment">
          {" "}
          <Card className="flex items-center gap-[8px] p-[8px]">
            {" "}
            <Tag type="acc">{gbp?.name || c.gbpId}</Tag>{" "}
            <span className="text-ui-body text-zinc-900 flex-[1] overflow-hidden">
              {c.reviewUrl}
            </span>{" "}
          </Card>{" "}
        </DrawerSection>
        {/* Service History */}
        <DrawerSection title="Service history">
          {c.jobs.length > 0 ? (
            c.jobs.map((j, i) => (
              <div
                key={i}
                className="border-b border-hairline border-zinc-200 py-[6px] text-ui-body"
              >
                {" "}
                <div className="flex justify-between">
                  {" "}
                  <span className="font-medium">{j.svcType}</span>{" "}
                  <span className="text-ui-body text-zinc-900">
                    {j.date}
                  </span>{" "}
                </div>
                {j.notes && (
                  <div className="text-zinc-900 mt-[2px]">{j.notes}</div>
                )}
                <div className="text-ui-body text-zinc-900 mt-[2px]">
                  {j.tech} · ${j.revenue}
                </div>{" "}
              </div>
            ))
          ) : (
            <p className="text-zinc-900 text-ui-body">No service records</p>
          )}
        </DrawerSection>
        {/* Recent SMS */}
        <DrawerSection title="Recent SMS">
          {c.sms.length > 0 ? (
            c.sms.slice(-5).map((m, i) => (
              <Card key={i} className="mb-1 px-[10px] py-2 text-ui-body">
                {" "}
                <div className="text-ui-body text-zinc-900 mb-[2px]">
                  {m.date} {m.dir === "out" ? "→ Sent" : "← Received"}
                </div>
                {m.text}
              </Card>
            ))
          ) : (
            <p className="text-zinc-900 text-ui-body">No SMS history</p>
          )}
        </DrawerSection>
        {/* Send Review Request */}
        <DrawerSection title="Send review request">
          {" "}
          <Card className="p-[12px]">
            {" "}
            <SectionLabel>Select Template</SectionLabel>{" "}
            <Select
              value={selectedTpl}
              onChange={(e) => applyTpl(e.target.value)}
              className="w-full mb-[8px]"
            >
              {" "}
              <option value="">Select a template...</option>
              {filteredTpls.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>{" "}
            <Textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder="Compose review request..."
              className="w-full resize-none min-h-[80px] box-border"
            />{" "}
            <div className="text-ui-body text-zinc-900 mt-[6px]">
              The selected template (with your edits) is what sends. The
              {" {review_url}"} resolves to a rating link that routes happy
              customers to Google and issues to a private recovery inbox.
            </div>{" "}
            {!c.sendable && !selectedIsNoLink && (
              <div className="text-ui-body text-zinc-900 mt-[6px] font-medium">
                Not sendable: {eligibilityLabel(c.eligibilityReasons)}
              </div>
            )}
            {!c.sendable && selectedIsNoLink && (
              <div className="text-ui-body text-zinc-900 mt-[6px]">
                Private check-in — bypasses the review ask cap/cooldown.
              </div>
            )}
            <div className="flex gap-[6px] mt-[8px] flex-wrap">
              {" "}
              <Btn
                variant="success"
                onClick={sendSms}
                disabled={sending || !canSendSelected}
              >
                {sending
                  ? "Sending…"
                  : selectedIsNoLink
                    ? "Send Check-In"
                    : "Send Review Request"}
              </Btn>{" "}
              <Btn
                variant="primary"
                disabled={!c.phone}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Call ${c.name} at ${c.phoneF || c.phone}?\n\nWaves will call your phone first — press 1 to connect.`,
                    )
                  )
                    return;
                  try {
                    // Server resolves the From line (TWILIO_NUMBERS) — a stale
                    // client-side GBP number would 400.
                    const r = await adminFetch("/admin/communications/call", {
                      method: "POST",
                      body: JSON.stringify({ to: c.phone }),
                    });
                    if (!r?.success) {
                      showToast(
                        "Call failed: " + (r?.error || "unknown error"),
                      );
                    } else {
                      addLog("call", `Calling ${c.name} at ${c.phoneF}`);
                      showToast(`Calling ${c.name}…`);
                    }
                  } catch (err) {
                    showToast("Call failed: " + err.message);
                  }
                }}
              >
                Call
              </Btn>{" "}
              {c.sequence ? (
                <Btn disabled>
                  In cadence ({c.seqStep}/{c.seqTotal})
                </Btn>
              ) : null}{" "}
              {c.sequence ? (
                <div className="text-ui-body text-zinc-900 mt-[6px]">
                  {decisionLine(c.sequence, sequencesEnabled)}
                </div>
              ) : sequencesEnabled ? (
                <Btn
                  onClick={startSequence}
                  disabled={seqStarting || !c.cadenceable}
                >
                  {seqStarting ? "Starting…" : "Start Cadence"}
                </Btn>
              ) : null}{" "}
            </div>{" "}
          </Card>{" "}
        </DrawerSection>{" "}
      </SheetBody>{" "}
    </Sheet>
  );
}
function DrawerSection({ title, children }) {
  return (
    <div className="mb-[16px]">
      {" "}
      <div className="mb-2 border-b border-hairline border-zinc-200 pb-1 text-ui-body font-medium text-zinc-900">
        {title}
      </div>
      {children}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BATCH MODAL
// ══════════════════════════════════════════════════════════════
function BatchModal({
  selectedIds,
  customers,
  onClose,
  addLog,
  showToast,
  setSelectedIds,
  sendReviewRequest,
}) {
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState({
    done: 0,
    total: 0,
  });
  const confirm = async () => {
    const targets = [...selectedIds]
      .map((id) => customers.find((x) => x.id === id))
      .filter((c) => c && c.phone);
    if (targets.length === 0) {
      showToast("No eligible customers with phone");
      return;
    }
    setSending(true);
    setProgress({
      done: 0,
      total: targets.length,
    });
    let ok = 0,
      fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const result = await sendReviewRequest(targets[i]);
      if (result.ok) ok++;
      else fail++;
      setProgress({
        done: i + 1,
        total: targets.length,
      });
    }
    setSending(false);
    addLog("batch", `Batch review request — ${ok} sent, ${fail} failed`);
    showToast(
      fail === 0 ? `${ok} review requests sent` : `${ok} sent · ${fail} failed`,
    );
    setSelectedIds(new Set());
    onClose();
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!sending) onClose();
      }}
      size="sm"
      className="admin-shell-v2 font-sans"
    >
      <DialogHeader>
        <DialogTitle>Batch send review requests</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-ui-body text-zinc-900 mb-[14px]">
          You're about to send the canonical review-request SMS to{" "}
          <strong>{selectedIds.size}</strong>customers. The server enforces the
          already-reviewed flag, 30-day cooldown, and 3-request cap.
        </p>
        {sending && (
          <div className="mt-2 rounded-md bg-white px-3 py-[10px] text-ui-body text-zinc-900">
            Sending… {progress.done}/{progress.total}
          </div>
        )}
        <DialogFooter>
          {" "}
          <Btn onClick={onClose} disabled={sending}>
            Cancel
          </Btn>{" "}
          <Btn variant="success" onClick={confirm} disabled={sending}>
            {sending ? "Sending…" : "Confirm & Send"}
          </Btn>{" "}
        </DialogFooter>
      </DialogBody>
    </Dialog>
  );
}
