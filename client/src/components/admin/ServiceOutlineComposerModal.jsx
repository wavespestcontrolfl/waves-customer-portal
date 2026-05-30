import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Mail,
  MessageSquare,
  MousePointerClick,
  RefreshCw,
  Send,
  ShieldCheck,
  Sprout,
  X,
} from "lucide-react";
import { Button, Badge } from "../ui";

const TURF_OPTIONS = [
  { value: "", label: "Detect from estimate" },
  { value: "st_augustine", label: "St. Augustine" },
  { value: "bermuda", label: "Bermuda" },
  { value: "zoysia", label: "Zoysia" },
  { value: "bahia", label: "Bahia" },
  { value: "mixed", label: "Mixed turf" },
  { value: "unknown", label: "Unknown" },
];

function statusTone(status) {
  if (status === "blocked") return "alert";
  return status === "passed" ? "strong" : "neutral";
}

function isSendablePacketStatus(status) {
  return ["approved", "sent", "viewed"].includes(String(status || "").toLowerCase());
}

function validationIcon(status) {
  if (status === "passed") return <CheckCircle2 size={16} strokeWidth={1.75} />;
  return <AlertTriangle size={16} strokeWidth={1.75} />;
}

function SectionPreview({ section }) {
  return (
    <section className="border-b border-zinc-200 py-4 last:border-b-0">
      <h4 className="text-sm font-semibold text-zinc-950">{section.title}</h4>
      <p className="mt-1 text-sm leading-6 text-zinc-600">{section.body}</p>
      {Array.isArray(section.bullets) && section.bullets.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm leading-5 text-zinc-700">
          {section.bullets.map((bullet, index) => (
            <li key={`${section.key}-${index}`} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-600" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatEventLabel(type) {
  const labels = {
    created: "Created",
    validation_passed: "Validation passed",
    validation_warning: "Validation warning",
    validation_blocked: "Validation blocked",
    approved: "Approved",
    sent_sms: "SMS sent",
    sent_email: "Email sent",
    failed: "Send failed",
    viewed: "Customer viewed",
    cta_clicked: "Estimate clicked",
    revoked: "Revoked",
    expired: "Expired",
  };
  return labels[type] || String(type || "Event").replaceAll("_", " ");
}

function formatEventTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeAgo(value) {
  if (!value) return "";
  const mins = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function ServiceOutlineComposerModal({ estimate, adminFetch, onClose }) {
  const [turfType, setTurfType] = useState("");
  const [detailLevel, setDetailLevel] = useState("standard");
  const [includeProductCards, setIncludeProductCards] = useState(false);
  const [preview, setPreview] = useState(null);
  const [packet, setPacket] = useState(null);
  const [publicUrl, setPublicUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [revokeOldOnRegenerate, setRevokeOldOnRegenerate] = useState(true);

  const requestBody = useMemo(() => ({
    estimateId: estimate?.id,
    turfType: turfType || undefined,
    detailLevel,
    includeProductCards,
    includeProductCategories: true,
    includePortalReporting: true,
    includeGpsReminders: true,
    includePublicGuideLink: true,
    includeExclusions: true,
  }), [detailLevel, estimate?.id, includeProductCards, turfType]);

  const loadPreview = useCallback(async () => {
    if (!estimate?.id) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const data = await adminFetch("/admin/service-outlines/preview", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });
      setPreview(data);
    } catch (err) {
      setError(err.message || "Preview failed");
    } finally {
      setLoading(false);
    }
  }, [adminFetch, estimate?.id, requestBody]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  const loadEvents = useCallback(async (packetId) => {
    if (!packetId) {
      setEvents([]);
      return;
    }
    setEventsLoading(true);
    try {
      const data = await adminFetch(`/admin/service-outlines/${packetId}/events`);
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch {
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  }, [adminFetch]);

  useEffect(() => {
    if (!estimate?.lawnServiceOutline?.id) return;
    let cancelled = false;
    adminFetch(`/admin/service-outlines/${estimate.lawnServiceOutline.id}`)
      .then((data) => {
        if (cancelled) return;
        setPacket(data.packet || null);
        loadEvents(data.packet?.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [adminFetch, estimate?.lawnServiceOutline?.id, loadEvents]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  async function saveDraft({ approve = false } = {}) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await adminFetch("/admin/service-outlines", {
        method: "POST",
        body: JSON.stringify({ ...requestBody, approve }),
      });
      setPacket(data.packet);
      setPublicUrl(data.packet?.publicUrl || "");
      loadEvents(data.packet?.id);
      setNotice(approve ? "Outline approved and link created." : "Draft saved and secure link created.");
      return data.packet;
    } catch (err) {
      setError(err.message || "Save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function ensurePacket() {
    if (packet?.id) return packet;
    return saveDraft({ approve: true });
  }

  async function send(method) {
    setSending(method);
    setError("");
    setNotice("");
    try {
      let active = await ensurePacket();
      if (!active?.id) return;
      if (!isSendablePacketStatus(active.status)) {
        const approved = await adminFetch(`/admin/service-outlines/${active.id}/approve`, { method: "POST" });
        active = approved.packet || active;
        setPacket(active);
        loadEvents(active.id);
      }
      const tokenForReuse = publicUrl ? publicUrl.split("/service-outlines/")[1] : "";
      const data = await adminFetch(`/admin/service-outlines/${active.id}/send`, {
        method: "POST",
        body: JSON.stringify({ method, token: tokenForReuse ? decodeURIComponent(tokenForReuse) : undefined }),
      });
      setPacket(data.packet);
      setPublicUrl(data.publicUrl || data.packet?.publicUrl || publicUrl);
      loadEvents(data.packet?.id);
      const parts = [];
      if (data.outcomes?.sms) parts.push(data.outcomes.sms.sent ? "SMS sent" : `SMS failed: ${data.outcomes.sms.reason || data.outcomes.sms.error || "unknown"}`);
      if (data.outcomes?.email) parts.push(data.outcomes.email.messageId ? "Email sent" : `Email failed: ${data.outcomes.email.error || "unknown"}`);
      setNotice(parts.join(" / ") || "Outline sent.");
    } catch (err) {
      setError(err.message || "Send failed");
    } finally {
      setSending("");
    }
  }

  async function copyLink() {
    let url = publicUrl;
    if (!url) {
      const saved = await ensurePacket();
      url = saved?.publicUrl || "";
    }
    if (!url) return;
    await navigator.clipboard?.writeText(url);
    setNotice("Secure outline link copied.");
  }

  function openPublicLink() {
    if (!publicUrl) return;
    window.open(publicUrl, "_blank", "noopener,noreferrer");
  }

  async function regenerate() {
    if (!packet?.id) return;
    if (!window.confirm("Regenerate this outline from the latest approved content and product facts?")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await adminFetch(`/admin/service-outlines/${packet.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ ...requestBody, revokeOld: revokeOldOnRegenerate }),
      });
      setPacket(data.packet);
      setPublicUrl(data.publicUrl || data.packet?.publicUrl || "");
      setPreview((current) => current ? { ...current, validation: data.validation || current.validation } : current);
      loadEvents(data.packet?.id);
      setNotice(revokeOldOnRegenerate ? "New outline generated. Previous link revoked." : "New outline generated. Previous link remains active.");
    } catch (err) {
      setError(err.message || "Regenerate failed");
    } finally {
      setSaving(false);
    }
  }

  const validation = preview?.validation || {};
  const outline = preview?.outline || {};
  const blocked = validation.status === "blocked";
  const activeOutline = packet || estimate?.lawnServiceOutline || null;
  const existingProductCardCount = activeOutline?.summary?.productCardCount ?? activeOutline?.productCardCount ?? activeOutline?.content?.productCards?.length ?? 0;
  const headerStats = [
    activeOutline?.sentAt && `Sent ${timeAgo(activeOutline.sentAt)}`,
    activeOutline?.lastViewedAt && `Viewed ${timeAgo(activeOutline.lastViewedAt)}${activeOutline.viewCount > 1 ? ` · ${activeOutline.viewCount}x` : ""}`,
    activeOutline?.lastCtaClickedAt && `Estimate clicked ${timeAgo(activeOutline.lastCtaClickedAt)}`,
    existingProductCardCount > 0 && `${existingProductCardCount} product cards`,
  ].filter(Boolean);
  const hasExistingSnapshot = !!activeOutline?.id;
  const existingMode = !!packet?.id;
  const staleReasons = activeOutline?.staleReasons || estimate?.lawnServiceOutline?.staleReasons || [];

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-zinc-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-t-lg border border-zinc-200 bg-white shadow-xl sm:rounded-lg">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <Sprout size={18} strokeWidth={1.75} className="text-emerald-700" />
              <h2 className="text-base font-semibold text-zinc-950">Lawn Service Outline</h2>
              {validation.status && (
                <Badge tone={statusTone(validation.status)} className="inline-flex items-center gap-1">
                  {validationIcon(validation.status)}
                  {validation.status}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              {estimate?.customerName || "Customer"} · {estimate?.address || "No address on estimate"}
            </p>
            {headerStats.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {headerStats.map((item) => (
                  <Badge key={item} tone="neutral">{item}</Badge>
                ))}
              </div>
            )}
            {hasExistingSnapshot && (
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                Existing packet snapshot · Content {activeOutline.contentLibraryVersion || "v?"} · Protocol {activeOutline.protocolVersion || "v?"} · Product facts {activeOutline.productRegistryVersion || "v?"}
              </p>
            )}
            {staleReasons.length > 0 && (
              <div className="mt-2 rounded-xs border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-800">
                Regenerate recommended: {staleReasons.join(", ")}.
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-xs border border-zinc-300 text-zinc-600 hover:bg-zinc-50" aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)_300px]">
          <aside className="border-b border-zinc-200 bg-zinc-50 p-4 lg:border-b-0 lg:border-r">
            <div className="space-y-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Turf type</span>
                <select value={turfType} onChange={(event) => setTurfType(event.target.value)} className="mt-1 h-10 w-full rounded-xs border border-zinc-300 bg-white px-3 text-sm text-zinc-900">
                  {TURF_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Detail level</span>
                <select value={detailLevel} onChange={(event) => setDetailLevel(event.target.value)} className="mt-1 h-10 w-full rounded-xs border border-zinc-300 bg-white px-3 text-sm text-zinc-900">
                  <option value="concise">Concise</option>
                  <option value="standard">Standard</option>
                  <option value="technical">Technical</option>
                </select>
              </label>

              <label className="flex items-start gap-2 rounded-xs border border-zinc-200 bg-white p-3 text-sm text-zinc-700">
                <input type="checkbox" checked={includeProductCards} onChange={(event) => setIncludeProductCards(event.target.checked)} className="mt-1" />
                <span>
                  Include approved product cards
                  <span className="block text-xs leading-5 text-zinc-500">Only products with approved public facts can show.</span>
                </span>
              </label>

              <Button type="button" variant="secondary" className="w-full justify-center" onClick={loadPreview} disabled={loading}>
                <RefreshCw size={14} strokeWidth={1.75} className="mr-2" />
                {loading ? "Refreshing..." : "Refresh Preview"}
              </Button>

              {packet?.id && (
                <div className="rounded-xs border border-zinc-200 bg-white p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Regeneration</div>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">Creates a new packet from current approved modules, facts, protocol, and local rules.</p>
                  <label className="mt-2 flex items-start gap-2 text-sm text-zinc-700">
                    <input type="checkbox" checked={revokeOldOnRegenerate} onChange={(event) => setRevokeOldOnRegenerate(event.target.checked)} className="mt-1" />
                    <span>Revoke previous link after regenerating</span>
                  </label>
                  <Button type="button" variant="secondary" className="mt-3 w-full justify-center" onClick={regenerate} disabled={saving || loading}>
                    <RefreshCw size={14} strokeWidth={1.75} className="mr-2" />
                    Regenerate
                  </Button>
                </div>
              )}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto px-5 py-4">
            {loading && <div className="text-sm text-zinc-500">Building outline preview...</div>}
            {!loading && outline?.title && (
              <article>
                <div className="border-b border-zinc-200 pb-4">
                  <h3 className="text-xl font-semibold text-zinc-950">{outline.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-600">{outline.intro}</p>
                </div>
                {(outline.sections || []).map((section) => (
                  <SectionPreview key={section.key} section={section} />
                ))}
                {Array.isArray(outline.productCards) && outline.productCards.length > 0 && (
                  <section className="py-4">
                    <h4 className="text-sm font-semibold text-zinc-950">Approved Product Cards</h4>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {outline.productCards.map((product) => (
                        <div key={product.id} className="rounded-md border border-zinc-200 p-3">
                          <div className="text-sm font-semibold text-zinc-950">{product.name}</div>
                          <div className="mt-1 text-xs text-zinc-500">{product.category}</div>
                          <p className="mt-2 text-sm leading-5 text-zinc-600">{product.summary}</p>
                          {product.epaRegistrationNumber && <div className="mt-2 text-xs text-zinc-500">EPA Reg. No. {product.epaRegistrationNumber}</div>}
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </article>
            )}
          </main>

          <aside className="border-t border-zinc-200 bg-zinc-50 p-4 lg:border-l lg:border-t-0">
            <div className="rounded-md border border-zinc-200 bg-white p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
                <ShieldCheck size={16} strokeWidth={1.75} className="text-emerald-700" />
                Fact and Safety Status
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">Turf</dt><dd className="font-medium text-zinc-900">{preview?.summary?.turfLabel || "Pending"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">Season</dt><dd className="font-medium text-zinc-900">{preview?.summary?.seasonBand || "Pending"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">Products</dt><dd className="font-medium text-zinc-900">{preview?.summary?.productCardCount || 0}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">Local rule</dt><dd className="font-medium text-zinc-900">{preview?.summary?.jurisdictionId || "Pending"}</dd></div>
              </dl>
            </div>

            {(validation.errors || []).length > 0 && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <div className="font-semibold">Blocked</div>
                <ul className="mt-2 space-y-1">
                  {validation.errors.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
            )}
            {(validation.warnings || []).length > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="font-semibold">Warnings</div>
                <ul className="mt-2 space-y-1">
                  {validation.warnings.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
            )}
            {error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
            {notice && <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

            {(packet?.id || events.length > 0) && (
              <div className="mt-3 rounded-md border border-zinc-200 bg-white p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
                  <Clock3 size={16} strokeWidth={1.75} className="text-zinc-500" />
                  Outline Timeline
                </div>
                {eventsLoading && <div className="mt-3 text-sm text-zinc-500">Loading events...</div>}
                {!eventsLoading && events.length === 0 && (
                  <div className="mt-3 text-sm leading-5 text-zinc-500">No customer events yet.</div>
                )}
                {!eventsLoading && events.length > 0 && (
                  <ol className="mt-3 space-y-3">
                    {events.slice(0, 8).map((event) => (
                      <li key={event.id} className="flex gap-2 text-sm">
                        <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600">
                          {event.event_type === "cta_clicked" ? <MousePointerClick size={13} strokeWidth={1.75} /> : <Clock3 size={13} strokeWidth={1.75} />}
                        </span>
                        <span>
                          <span className="block font-medium text-zinc-900">{formatEventLabel(event.event_type)}</span>
                          <span className="block text-xs text-zinc-500">{formatEventTime(event.created_at)}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </aside>
        </div>

        <div className="flex flex-col gap-2 border-t border-zinc-200 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
          <Button type="button" variant="secondary" onClick={() => saveDraft()} disabled={saving || loading}>
            {saving ? "Saving..." : "Save Draft"}
          </Button>
          <Button type="button" variant="secondary" onClick={copyLink} disabled={saving || loading || blocked || (existingMode && !publicUrl)}>
            <Copy size={14} strokeWidth={1.75} className="mr-2" />
            {existingMode && !publicUrl ? "Current Link Hidden" : existingMode ? "Copy Current Link" : "Copy Link"}
          </Button>
          <Button type="button" variant="secondary" onClick={openPublicLink} disabled={!publicUrl}>
            Open Link
          </Button>
          <Button type="button" variant="secondary" onClick={() => send("sms")} disabled={!!sending || blocked || !estimate?.customerPhone}>
            <MessageSquare size={14} strokeWidth={1.75} className="mr-2" />
            {sending === "sms" ? "Sending..." : existingMode ? "Send Existing SMS" : "Send SMS"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => send("email")} disabled={!!sending || blocked || !estimate?.customerEmail}>
            <Mail size={14} strokeWidth={1.75} className="mr-2" />
            {sending === "email" ? "Sending..." : existingMode ? "Send Existing Email" : "Send Email"}
          </Button>
          <Button type="button" onClick={() => send("both")} disabled={!!sending || blocked || (!estimate?.customerPhone && !estimate?.customerEmail)}>
            <Send size={14} strokeWidth={1.75} className="mr-2" />
            {sending === "both" ? "Sending..." : existingMode ? "Send Existing" : "Send Both"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
