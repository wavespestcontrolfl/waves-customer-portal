import { useEffect, useState } from "react";
import { Badge, Button, Card, Table, TBody, TD, TH, THead, TR } from "../ui";
import { formatETDateTime } from "../../lib/timezone";

// Ads -> Dashboard: read-only "Ad health" card. Shows whether each Google
// campaign serves (and why not), ad disapprovals, conversion uploads with
// Google's own upload check, and a 30-day "who changed what" timeline. The
// server route ships behind GATE_ADS_HEALTH_CARD; while it is off
// GET /admin/ads/health answers 404 and this card renders nothing. It also
// renders nothing until the server answers, so a switched-off card never
// flashes onto the dashboard.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const TIMELINE_PREVIEW = 10;

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
    "Content-Type": "application/json",
  };
}

// Generic enum formatter: CAMPAIGN_PAUSED -> "Campaign paused".
function humanize(value) {
  const text = String(value || "").replace(/_/g, " ").trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

// Only where the generic formatter reads badly.
const WORDING = {
  DESTINATION_NOT_WORKING: "Landing page not working",
  UNPARSEABLE_GCLID: "Click ID could not be read",
  NO_RECENT_UPLOAD: "No recent upload",
};
const word = (value) => WORDING[value] || humanize(value);

// primaryStatus -> pill text and tone. Alert red only for a campaign that
// cannot serve; a plain pause is the owner's own choice and stays neutral.
const SERVING_PILL = {
  ELIGIBLE: { label: "Serving", tone: "strong" },
  PAUSED: { label: "Paused", tone: "neutral" },
  LIMITED: { label: "Limited", tone: "neutral" },
  LEARNING: { label: "Learning", tone: "neutral" },
  PENDING: { label: "Pending", tone: "neutral" },
  ENDED: { label: "Not serving", tone: "neutral" },
  REMOVED: { label: "Not serving", tone: "neutral" },
  NOT_ELIGIBLE: { label: "Not serving", tone: "alert" },
  MISCONFIGURED: { label: "Not serving", tone: "alert" },
};
const UNKNOWN_PILL = { label: "Unknown", tone: "neutral" };

function servingPill(campaign) {
  const base = SERVING_PILL[campaign.primaryStatus] || UNKNOWN_PILL;
  const reasons = campaign.reasons || [];
  const pausedForOtherReason =
    campaign.primaryStatus === "PAUSED" && reasons.some((r) => r !== "CAMPAIGN_PAUSED");
  return pausedForOtherReason ? { ...base, tone: "alert" } : base;
}

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const WHEN_FORMAT = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const whenET = (iso) => (iso ? formatETDateTime(iso, WHEN_FORMAT) : "");

function Muted({ children, className = "" }) {
  return <div className={`text-ui-body text-ink-secondary ${className}`}>{children}</div>;
}

function SectionTitle({ children }) {
  return <h3 className="text-ui-body font-medium text-zinc-900 [margin:0_0_8px]">{children}</h3>;
}

// A section whose data is missing or {error} shows a muted line instead.
function Section({ title, data, children }) {
  let body = children;
  if (data && data.error) body = <Muted>{data.error}</Muted>;
  else if (!data) body = <Muted>Not available.</Muted>;
  return (
    <section className="[padding:16px_0] border-t border-hairline border-zinc-200">
      <SectionTitle>{title}</SectionTitle>
      {body}
    </section>
  );
}

function ServingRow({ campaign }) {
  const pill = servingPill(campaign);
  const reasons = (campaign.reasons || []).map(word).join(", ");
  const hasBudget = campaign.dailyBudget !== null && campaign.dailyBudget !== undefined;
  return (
    <li className="flex flex-wrap items-center [gap:4px_8px] [padding:4px_0]">
      <span className="text-ui-body font-medium text-zinc-900">{campaign.name}</span>
      <Badge tone={pill.tone}>{pill.label}</Badge>
      {reasons && <span className="text-ui-body text-ink-secondary">{reasons}</span>}
      {hasBudget && (
        <span className="text-ui-body text-ink-secondary">{money(campaign.dailyBudget)}/day</span>
      )}
    </li>
  );
}

function Serving({ data }) {
  const campaigns = data?.campaigns || [];
  return (
    <Section title="Serving" data={data}>
      {campaigns.length === 0 ? (
        <Muted>No campaigns found.</Muted>
      ) : (
        <ul className="list-none [margin:0] [padding:0]">
          {campaigns.map((c) => (
            <ServingRow key={c.id || c.name} campaign={c} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function Approvals({ data }) {
  const ads = data?.ads || [];
  return (
    <Section title="Ad approvals" data={data}>
      {ads.length === 0 ? (
        <div className="text-ui-body text-zinc-900">No ads disapproved.</div>
      ) : (
        <ul className="list-none [margin:0] [padding:0]">
          {ads.map((ad, i) => (
            <li key={ad.adId || i} className="text-ui-body text-alert-fg [padding:4px_0]">
              {ad.campaign}, {ad.adGroup}: {(ad.topics || []).map(word).join(", ") || "Disapproved"}
            </li>
          ))}
          {data.truncated && <Muted>Showing the first {ads.length} of {data.total}.</Muted>}
        </ul>
      )}
    </Section>
  );
}

function PortalCount({ label, counts }) {
  if (!counts) return null;
  const pending = counts.pending > 0 ? `, ${counts.pending} pending` : "";
  const failedClass = counts.failed > 0 ? "text-alert-fg" : "text-zinc-900";
  return (
    <div className="text-ui-body text-zinc-900">
      {label}: {counts.sent} sent{pending},{" "}
      <span className={failedClass}>{counts.failed} failed</span>
      {counts.partial > 0 && (
        <span className="text-alert-fg">, {counts.partial} in batches Google partly refused</span>
      )}{" "}
      (30 days).
    </div>
  );
}

function ActionLine({ action }) {
  const bad = action.status === "NEEDS_ATTENTION" || action.failed > 0;
  const days = action.uploadDays ? ` in the last ${action.uploadDays} upload days` : "";
  const extras = [
    action.failed > 0 ? `${action.failed} failed` : "",
    action.pending > 0 ? `${action.pending} pending` : "",
  ].filter(Boolean);
  return (
    <li className="[padding:4px_0]">
      <div className="text-ui-body text-zinc-900">
        {action.name}:{" "}
        <span className={bad ? "text-alert-fg" : ""}>{word(action.status)}</span>. Google accepted{" "}
        {action.accepted}
        {days}.{extras.length > 0 && ` ${extras.join(", ")}.`}
        {action.lastUploadAt && ` Last upload ${whenET(action.lastUploadAt)}.`}
      </div>
      {(action.alerts || []).map((a) => (
        <Muted key={a.error}>
          {word(a.error)}
          {a.percent !== null && a.percent !== undefined ? ` (${a.percent}%)` : ""}
        </Muted>
      ))}
    </li>
  );
}

function Uploads({ uploads, check }) {
  const actions = check?.actions || [];
  return (
    <Section title="Conversion uploads" data={uploads || {}}>
      <PortalCount label="Google" counts={uploads?.google} />
      <PortalCount label="Meta" counts={uploads?.meta} />
      {check?.error && <Muted className="[margin-top:8px]">{check.error}</Muted>}
      {actions.length > 0 && (
        <ul className="list-none [margin:8px_0_0] [padding:0]">
          {actions.map((a, i) => (
            <ActionLine key={`${a.name}-${i}`} action={a} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function TimelineRow({ row }) {
  const sub = [row.campaign, row.detail].filter(Boolean).join(" · ");
  return (
    <TR>
      <TD className="text-ui-body whitespace-nowrap align-top">{whenET(row.at)}</TD>
      <TD className="text-ui-body align-top">{row.who}</TD>
      <TD className="text-ui-body align-top">{row.via}</TD>
      <TD className="text-ui-body align-top">
        <div>{row.what}</div>
        {sub && <Muted>{sub}</Muted>}
      </TD>
    </TR>
  );
}

function Timeline({ rows }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, TIMELINE_PREVIEW);
  return (
    <Section title="Who changed what" data={{}}>
      {rows.length === 0 ? (
        <Muted>No changes in the last 30 days.</Muted>
      ) : (
        <>
          <Table aria-label="Recent changes">
            <THead>
              <TR>
                <TH className="text-ui-body">When (ET)</TH>
                <TH className="text-ui-body">Who</TH>
                <TH className="text-ui-body">Where</TH>
                <TH className="text-ui-body">What</TH>
              </TR>
            </THead>
            <TBody>
              {shown.map((row, i) => (
                <TimelineRow key={`${row.at}-${i}`} row={row} />
              ))}
            </TBody>
          </Table>
          {rows.length > TIMELINE_PREVIEW && !showAll && (
            <Button variant="ghost" className="[margin-top:8px]" onClick={() => setShowAll(true)}>
              Show all {rows.length}
            </Button>
          )}
        </>
      )}
    </Section>
  );
}

function CardBody({ data }) {
  const google = data.google || {};
  return (
    <>
      {google.configured === false ? (
        <Muted>Google Ads is not connected.</Muted>
      ) : (
        <>
          <Serving data={google.serving} />
          <Approvals data={google.disapprovals} />
        </>
      )}
      <Uploads uploads={data.uploads} check={google.configured === false ? null : google.uploadCheck} />
      <Timeline rows={data.timeline || []} />
      {(data.notes || []).map((n) => (
        <Muted key={n}>{n}</Muted>
      ))}
    </>
  );
}

export default function AdsHealthCard() {
  // state: "loading" | "off" | "error" | "ready"
  const [state, setState] = useState("loading");
  const [data, setData] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/admin/ads/health`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 404) return setState("off");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        // Anything that is not the documented shape counts as off, never a crash.
        if (!body || typeof body !== "object" || !body.google) return setState("off");
        setData(body);
        setState("ready");
      } catch (err) {
        if (cancelled) return;
        setMessage(err.message || "Request failed");
        setState("error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "off" || state === "loading") return null;
  return (
    <Card className="[padding:16px_20px] [margin-bottom:24px]" data-qa="ads-health-card">
      <h2 className="text-18 font-medium text-zinc-900 [margin:0]">Ad health</h2>
      <Muted className="[margin-bottom:8px]">Live from Google Ads. Changes from the last 30 days.</Muted>
      {state === "error" && <Muted>Ad health could not load: {message}</Muted>}
      {state === "ready" && <CardBody data={data} />}
    </Card>
  );
}
