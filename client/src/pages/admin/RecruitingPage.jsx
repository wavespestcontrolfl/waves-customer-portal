/**
 * <RecruitingPage> — /admin/recruiting. The applicant queue for the public
 * careers funnel (GATE_JOB_APPLICATIONS).
 *
 * Read → decide → contact, all owner-driven: the AI screen only ranks and
 * summarizes (best-first ordering, strengths/flags); every status change
 * is a click here, and contacting the applicant happens over tel:/sms:
 * links — the portal never messages applicants.
 *
 * Deep link: ?application=<id> opens that application's detail (the bell
 * notification links here).
 */
import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { UserPlus, Phone, MessageSquare, Mail } from "lucide-react";
import {
  Button, Badge, Card, CardBody,
  Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter,
  Textarea, cn,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function adminFetch(path, options = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try { const d = await r.clone().json(); message = d.error || d.message || message; } catch { /* noop */ }
    const err = new Error(message);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export const STATUS_TABS = [
  { key: "new", label: "New" },
  { key: "reviewed", label: "Reviewed" },
  { key: "interview", label: "Interview" },
  { key: "offer", label: "Offer" },
  { key: "hired", label: "Hired" },
  { key: "rejected", label: "Rejected" },
];

const ROLE_LABELS = { technician: "Technician", sales: "Sales", other: "Other" };

export const ANSWER_LABELS = {
  drivers_license: "FL driver's license / insurable record",
  experience: "Pest control / trade experience",
  outdoor_work: "Florida-summer outdoor work",
  judgment_gate_code: "Gate-code scenario (judgment)",
  phone_apps: "Daily phone-app comfort",
  availability: "Availability & earliest start",
  pay_expectation: "Pay expectation",
  why_waves: "Why Waves / why this trade",
  physical_limitations: "Lifting / ladder limitations",
  referral_source: "How they heard about us",
};

// Admin stays monochrome (the colored-score exception is Customers-only):
// weight and shade carry the ranking, not color.
export function scoreTone(score) {
  if (score == null) return "text-zinc-400";
  if (score >= 70) return "text-zinc-900";
  return "text-zinc-500";
}

function formatETDateTime(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function RecommendationBadge({ recommendation }) {
  if (!recommendation) return <Badge>Unscored</Badge>;
  const label = { strong: "Strong", possible: "Possible", weak: "Weak" }[recommendation] || recommendation;
  return <Badge>{label}</Badge>;
}

export default function RecruitingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState("new");
  const [applications, setApplications] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (status) => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch(`/admin/careers?status=${encodeURIComponent(status)}`);
      setApplications(data.applications || []);
      setCounts(data.counts || {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  const openDetail = useCallback(async (id) => {
    try {
      const data = await adminFetch(`/admin/careers/${id}`);
      setDetail(data.application);
      setNote("");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // Bell deep link: consume ?application=<id> once, then clear it.
  // Mount-only by design (the errors-only lint config has no
  // exhaustive-deps rule — a disable directive would itself error).
  useEffect(() => {
    const id = searchParams.get("application");
    if (!id) return;
    openDetail(id);
    const next = new URLSearchParams(searchParams);
    next.delete("application");
    setSearchParams(next, { replace: true });
  }, []);

  const setStatus = async (id, status) => {
    setBusy(true);
    try {
      const data = await adminFetch(`/admin/careers/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, note: note.trim() || undefined }),
      });
      setDetail(data.application);
      await load(tab);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const contact = detail?.contact_snapshot || {};
  const screen = detail?.ai_screen || null;

  return (
    <div className="max-w-[1000px]">
      <div className="flex items-center gap-2 mb-4">
        <UserPlus className="w-5 h-5 text-zinc-500" />
        <h1 className="text-20 font-medium text-zinc-900">Recruiting</h1>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4" role="tablist" aria-label="Application status">
        {STATUS_TABS.map(({ key, label }) => (
          <Button
            key={key}
            role="tab"
            aria-selected={tab === key}
            variant={tab === key ? "primary" : "secondary"}
            size="sm"
            onClick={() => setTab(key)}
          >
            {label}
            {counts[key] ? <span className="ml-1 tabular-nums">{counts[key]}</span> : null}
          </Button>
        ))}
      </div>

      {error && <div className="text-14 text-alert-fg mb-3">{error}</div>}
      {loading ? (
        <div className="text-14 text-zinc-500 p-8 text-center">Loading applications…</div>
      ) : applications.length === 0 ? (
        <Card><CardBody>
          <div className="text-14 text-zinc-500 text-center py-6">
            No {STATUS_TABS.find((t) => t.key === tab)?.label.toLowerCase()} applications.
          </div>
        </CardBody></Card>
      ) : (
        <div className="flex flex-col gap-2">
          {applications.map((app) => {
            const c = app.contact_snapshot || {};
            return (
              <Card key={app.id}>
                <CardBody>
                  <button
                    type="button"
                    className="w-full text-left appearance-none border-0 bg-transparent p-0 cursor-pointer"
                    onClick={() => openDetail(app.id)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-14 font-medium text-zinc-900 truncate">
                          {c.name || "Unknown"}
                          <span className="text-zinc-400 font-normal"> · {ROLE_LABELS[app.role] || app.role}</span>
                          {app.language === "es" && <span className="text-zinc-400 font-normal"> · ES</span>}
                        </div>
                        {app.ai_summary && (
                          <div className="text-13 text-zinc-500 mt-0.5 truncate">{app.ai_summary}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <RecommendationBadge recommendation={app.ai_recommendation} />
                        <span className={cn("text-16 tabular-nums font-medium", scoreTone(app.ai_score))}>
                          {app.ai_score != null ? app.ai_score : "—"}
                        </span>
                        <span className="text-12 text-zinc-400">{formatETDateTime(app.created_at)}</span>
                      </div>
                    </div>
                  </button>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={Boolean(detail)} onClose={() => setDetail(null)}>
        {detail && (
          <>
            <DialogHeader>
              <DialogTitle>
                {contact.name || "Applicant"} — {ROLE_LABELS[detail.role] || detail.role}
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              <div className="flex flex-wrap items-center gap-3 mb-4">
                {contact.phone && (
                  <>
                    <a className="inline-flex items-center gap-1 text-14 text-zinc-700 underline" href={`tel:${contact.phone}`}>
                      <Phone className="w-4 h-4" />{contact.phone}
                    </a>
                    <a className="inline-flex items-center gap-1 text-14 text-zinc-700 underline" href={`sms:${contact.phone}`}>
                      <MessageSquare className="w-4 h-4" />Text
                    </a>
                  </>
                )}
                {contact.email && (
                  <a className="inline-flex items-center gap-1 text-14 text-zinc-700 underline" href={`mailto:${contact.email}`}>
                    <Mail className="w-4 h-4" />{contact.email}
                  </a>
                )}
                {contact.city && <span className="text-14 text-zinc-500">{contact.city}</span>}
                <Badge>{detail.status}</Badge>
              </div>

              {screen && (
                <div className="mb-4 border-hairline border rounded p-3">
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className={cn("text-20 tabular-nums font-medium", scoreTone(detail.ai_score))}>
                      {detail.ai_score}
                    </span>
                    <RecommendationBadge recommendation={detail.ai_recommendation} />
                    <span className="text-12 text-zinc-400">AI screen — ranking assist only</span>
                  </div>
                  {screen.summary && <div className="text-14 text-zinc-700 mb-1.5">{screen.summary}</div>}
                  {screen.strengths?.length > 0 && (
                    <div className="text-13 text-zinc-600">Strengths: {screen.strengths.join(" · ")}</div>
                  )}
                  {screen.flags?.length > 0 && (
                    <div className="text-13 text-amber-700 mt-0.5">Probe: {screen.flags.join(" · ")}</div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2.5 mb-4">
                {Object.entries(ANSWER_LABELS)
                  .filter(([key]) => detail.answers?.[key])
                  .map(([key, label]) => (
                    <div key={key}>
                      <div className="text-12 uppercase tracking-label text-zinc-500">{label}</div>
                      <div className="text-14 text-zinc-800 whitespace-pre-wrap">{detail.answers[key]}</div>
                    </div>
                  ))}
              </div>

              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note for this status change…"
                rows={2}
              />
            </DialogBody>
            <DialogFooter>
              <div className="flex flex-wrap gap-1.5">
                {STATUS_TABS.filter(({ key }) => key !== detail.status).map(({ key, label }) => (
                  <Button key={key} size="sm" variant="secondary" disabled={busy} onClick={() => setStatus(detail.id, key)}>
                    {label}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>Close</Button>
              </div>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </div>
  );
}
