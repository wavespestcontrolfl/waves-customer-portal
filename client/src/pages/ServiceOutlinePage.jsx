import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CalendarDays, ClipboardCheck, FileText, MapPin, ShieldCheck, Sprout } from "lucide-react";
import BrandFooter from "../components/BrandFooter";
import DocumentActionBar from "../components/DocumentActionBar";
import { useGlassSurface } from "../glass/glass-engine";
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from "../constants/business";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function LoadingState() {
  return (
    <div data-glass-clear="" className="min-h-screen bg-waves-page px-4 py-10">
      <div data-glass="soft" className="mx-auto max-w-3xl rounded-md border border-zinc-200 bg-white p-6 text-slate-600">
        Loading your lawn care program overview...
      </div>
    </div>
  );
}

// Every terminal state keeps a forward action (audit S2-2): the phone number
// is rendered as visible digits (desktop readers can't tap tel: links), and
// transient failures get a Try again. `gone` (404/410) skips the retry — a
// dead token can't recover, so the copy points at a resend instead.
function ErrorState({ kind, message, onRetry }) {
  return (
    <div data-glass-clear="" className="min-h-screen bg-waves-page px-4 py-10">
      <div className="mx-auto max-w-3xl rounded-md border border-red-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-waves-blue-deeper">
          {kind === "gone" ? "This outline link has expired" : "We couldn't load your program overview"}
        </h1>
        <p className="mt-2 text-base leading-7 text-slate-600">{message}</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {kind !== "gone" && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{ minHeight: 44 }}
              className="rounded-md bg-waves-blue-deeper px-5 text-base font-semibold text-white"
            >
              Try again
            </button>
          )}
          <a
            href={WAVES_SUPPORT_PHONE_TEL}
            style={{ minHeight: 44 }}
            className="inline-flex items-center rounded-md border border-zinc-200 px-5 text-base font-semibold text-waves-blue-deeper"
          >
            Call {WAVES_SUPPORT_PHONE_DISPLAY}
          </a>
        </div>
      </div>
    </div>
  );
}

function Section({ section }) {
  return (
    <section className="border-b border-zinc-200 py-6 last:border-b-0">
      <h2 className="text-xl font-semibold text-waves-blue-deeper">{section.title}</h2>
      <p className="mt-2 text-base leading-7 text-slate-600">{section.body}</p>
      {Array.isArray(section.bullets) && section.bullets.length > 0 && (
        <ul className="mt-4 grid gap-2 text-sm leading-6 text-slate-600 md:grid-cols-2">
          {section.bullets.map((bullet, index) => (
            <li key={`${section.key}-${index}`} data-glass="soft" className="flex gap-2 rounded-md border border-zinc-200 bg-surface-page p-3">
              <ClipboardCheck size={16} strokeWidth={1.75} className="mt-1 flex-shrink-0 text-waves-success" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ServiceOutlinePage() {
  const { token } = useParams();
  useGlassSurface(true, "full");
  const [packet, setPacket] = useState(null);
  const [loading, setLoading] = useState(true);
  // { kind: 'gone' | 'transient', message } — never a raw HTTP status.
  const [error, setError] = useState(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    document.title = "Your Lawn Care Program Overview | Waves";
    const meta = document.querySelector('meta[name="robots"]') || document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "noindex,nofollow,noarchive");
    if (!meta.parentNode) document.head.appendChild(meta);

    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/service-outlines/${encodeURIComponent(token)}`)
      .then(async (response) => {
        if (!response.ok) {
          // 404/410 = dead token (the server 410s expired links); anything
          // else is treated as transient. A non-JSON error body (proxy 5xx)
          // must never surface as "HTTP 500" — that read as a dead end.
          const gone = response.status === 404 || response.status === 410;
          const err = new Error(gone ? "gone" : "transient");
          err.kind = gone ? "gone" : "transient";
          throw err;
        }
        return response.json();
      })
      .then((data) => {
        if (!cancelled) setPacket(data.packet);
      })
      .catch((err) => {
        if (cancelled) return;
        const kind = err.kind === "gone" ? "gone" : "transient";
        setError({
          kind,
          message: kind === "gone"
            ? `This link may have expired or isn't valid. Call us at ${WAVES_SUPPORT_PHONE_DISPLAY} and we'll resend it — or check your texts for a newer link.`
            : "This is usually a brief connection hiccup. Try again in a moment, or give us a call and we'll walk you through your program.",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, retryNonce]);

  if (loading) return <LoadingState />;
  if (error) {
    return (
      <ErrorState
        kind={error.kind}
        message={error.message}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  const content = packet?.content || {};
  const estimatePath = content.cta?.estimatePath;
  const trackCtaClick = (target) => {
    const url = `${API_BASE}/service-outlines/${encodeURIComponent(token)}/cta-click`;
    const payload = JSON.stringify({ cta: "view_estimate", target });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon(url, blob);
      return;
    }
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  };

  return (
    <div data-glass-clear="" className="min-h-screen bg-waves-page text-waves-blue-deeper">
      {/* Wordmark row removed — the WavesShell top bar (App.jsx route wrap,
          owner 2026-07-06) provides the brand chrome; this strip keeps only
          the View Estimate CTA. */}
      {estimatePath && (
        <header data-glass-clear="" className="border-b border-zinc-200 bg-white">
          <div className="mx-auto flex max-w-[760px] items-center justify-end gap-4 px-4 py-3">
            <a
              href={estimatePath}
              onClick={() => trackCtaClick(estimatePath)}
              data-glass-accent=""
              className="inline-flex h-12 items-center justify-center rounded-[10px] bg-waves-blue-deeper px-4 text-sm font-semibold text-white hover:bg-waves-blue-dark"
            >
              View Estimate
            </a>
          </div>
        </header>
      )}

      {/* div, not <main> — WavesShell supplies the main landmark. */}
      <div>
        <div className="mx-auto max-w-[760px] px-4 pt-6">
          {/* No server-side outline PDF render — Share + Print only. */}
          <DocumentActionBar shareTitle="Waves program outline" style={{ marginBottom: 0 }} />
        </div>
        <section data-glass-clear="" className="bg-white mt-6">
          <div className="mx-auto grid max-w-[760px] gap-8 px-4 py-10 lg:grid-cols-[1fr_320px]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-xs border border-waves-success-border bg-waves-success-bg px-3 py-1 text-xs font-semibold uppercase tracking-wide text-waves-success">
                <Sprout size={14} strokeWidth={1.75} />
                Lawn Care Program
              </div>
              <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-waves-blue-deeper">{content.title}</h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">{content.intro}</p>
            </div>
            <aside data-glass="soft" className="rounded-md border border-zinc-200 bg-surface-page p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Program Snapshot</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex gap-3">
                  <MapPin size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
                  <div>
                    <dt className="text-zinc-500">Service area</dt>
                    <dd className="font-medium text-waves-blue-deeper">{content.property?.addressSummary || "Service property"}</dd>
                  </div>
                </div>
                <div className="flex gap-3">
                  <Sprout size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
                  <div>
                    <dt className="text-zinc-500">Turf type</dt>
                    <dd className="font-medium text-waves-blue-deeper">{content.property?.turfType || "To be confirmed"}</dd>
                  </div>
                </div>
                <div className="flex gap-3">
                  <CalendarDays size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
                  <div>
                    <dt className="text-zinc-500">Season focus</dt>
                    <dd className="font-medium text-waves-blue-deeper">{content.season?.monthName || "Current visit"}</dd>
                  </div>
                </div>
                <div className="flex gap-3">
                  <ShieldCheck size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
                  <div>
                    <dt className="text-zinc-500">Product language</dt>
                    <dd className="font-medium text-waves-blue-deeper">May be used, not guaranteed</dd>
                  </div>
                </div>
              </dl>
            </aside>
          </div>
        </section>

        <section className="mx-auto max-w-[760px] px-4 py-8">
          <div data-glass="card" className="rounded-md border border-zinc-200 bg-white px-5">
            {(content.sections || []).map((section) => (
              <Section key={section.key} section={section} />
            ))}
          </div>
        </section>

        {Array.isArray(content.productCards) && content.productCards.length > 0 && (
          <section className="mx-auto max-w-[760px] px-4 pb-8">
            <div data-glass="card" className="rounded-md border border-zinc-200 bg-white p-5">
              <h2 className="text-xl font-semibold text-waves-blue-deeper">Approved Product Details</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">These products may be relevant when turf type, site conditions, label directions, weather, and local rules allow.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {content.productCards.map((product) => (
                  <article key={product.id} className="rounded-md border border-zinc-200 p-4">
                    <h3 className="font-semibold text-waves-blue-deeper">{product.name}</h3>
                    <p className="mt-1 text-xs uppercase tracking-wide text-zinc-500">{product.category}</p>
                    <p className="mt-3 text-sm leading-6 text-slate-600">{product.summary}</p>
                    {product.epaRegistrationNumber && <p className="mt-3 text-xs text-zinc-500">EPA Reg. No. {product.epaRegistrationNumber}</p>}
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="mx-auto max-w-[760px] px-4 pb-12">
          <div data-glass-ink="light" className="flex flex-col items-start justify-between gap-4 rounded-md bg-waves-blue-deeper p-5 text-white md:flex-row md:items-center">
            <div>
              <h2 className="text-xl font-semibold">Ready to review the estimate?</h2>
              <p className="mt-1 text-sm text-zinc-300">The outline explains the program. The estimate shows pricing and approval steps.</p>
            </div>
            {estimatePath && (
              <a
                href={estimatePath}
                onClick={() => trackCtaClick(estimatePath)}
                className="inline-flex h-11 items-center justify-center rounded-xs bg-white px-5 text-sm font-semibold text-waves-blue-deeper hover:bg-surface-hover"
              >
                <FileText size={16} strokeWidth={1.75} className="mr-2" />
                View Estimate
              </a>
            )}
          </div>
        </section>

        <div className="mx-auto max-w-[760px] px-4 pb-10">
          {/* Newsletter signup lives only on the newsletter pages (owner
              2026-07-09, supersedes same-day card ruling). */}
          <BrandFooter />
        </div>
      </div>
    </div>
  );
}
