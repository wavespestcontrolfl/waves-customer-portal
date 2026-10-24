import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  BadgeCheck,
  Bell,
  Bug,
  CalendarDays,
  ClipboardCheck,
  Clover,
  Droplets,
  FileText,
  Footprints,
  Leaf,
  ListChecks,
  MapPin,
  Microscope,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  SprayCan,
  Sprout,
  Tag,
  Target,
} from "lucide-react";
import DocumentActionBar from "../components/DocumentActionBar";
import { useGlassSurface } from "../glass/glass-engine";
import { PublicStateCard } from "../components/brand";
import { WAVES_SUPPORT_PHONE_DISPLAY } from "../constants/business";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function LoadingState() {
  return (
    <div data-glass-clear="" className="flex-1 bg-waves-page px-4 py-10">
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
  const gone = kind === "gone";
  return (
    <div data-glass-clear="" className="flex-1 bg-waves-page px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <PublicStateCard
          state={gone ? "expired" : "error"}
          title={gone ? "This outline link has expired" : "We couldn't load your program overview"}
          onRetry={gone ? undefined : onRetry}
          contact="call"
        >
          {message}
        </PublicStateCard>
      </div>
    </div>
  );
}

// The step and tile icon keys a v13 outline section draws with (server/services/lawn-service-outline.js,
// GATE_LAWN_OUTLINE_V13). An unknown key draws no icon; its text still shows.
const VISUAL_ICONS = {
  inspection: Search,
  feeding: Sprout,
  barrier: ShieldCheck,
  micros: Leaf,
  weeds: Clover,
  insects: Bug,
  disease: Microscope,
  dry_spots: Droplets,
  report: FileText,
  whole_lawn: SprayCan,
  spots: Target,
  count: ListChecks,
  rotate: RefreshCw,
  decide: ClipboardCheck,
  treat: SprayCan,
  area: MapPin,
  calendar: CalendarDays,
  label: Tag,
  reentry: Footprints,
  epa: BadgeCheck,
  reminders: Bell,
  portal: Smartphone,
  arrival: MapPin,
};

function VisualIcon({ name, size = 18, className = "" }) {
  const Icon = VISUAL_ICONS[name];
  return Icon ? <Icon size={size} strokeWidth={1.75} aria-hidden="true" className={className} /> : null;
}

function IconBadge({ name, size = 18 }) {
  return (
    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-waves-blue-light text-waves-blue-deeper">
      <VisualIcon name={name} size={size} />
    </span>
  );
}

function TilesVisual({ items = [] }) {
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2">
      {items.map((tile) => (
        <li key={tile.title} data-glass="soft" className="flex gap-3 rounded-md border border-zinc-200 bg-surface-page p-4">
          <IconBadge name={tile.icon} size={20} />
          <span>
            <span className="block text-base font-semibold text-waves-blue-deeper">{tile.title}</span>
            <span className="mt-1 block text-base leading-6 text-slate-600">{tile.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ChipRow({ heading, items, tone }) {
  if (!items.length) return null;
  const chipClass = tone === "main"
    ? "bg-waves-blue-light font-semibold text-waves-blue-deeper"
    : "border border-zinc-300 bg-white font-medium text-slate-700";
  return (
    <div>
      <p className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{heading}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {items.map((chip) => (
          <li key={chip.key} className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm ${chipClass}`}>
            <VisualIcon name={chip.key} size={16} />
            {chip.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChipsVisual({ items = [], note }) {
  return (
    <div className="mt-4 space-y-4">
      <ChipRow heading="This month's step" items={items.filter((chip) => chip.tier === "main")} tone="main" />
      <ChipRow heading="As needed" items={items.filter((chip) => chip.tier !== "main")} tone="as_needed" />
      {note && <p className="text-sm leading-6 text-slate-500">{note}</p>}
    </div>
  );
}

function YearVisual({ months = [], labels = {}, limitLabel }) {
  // The key lists the steps the chart uses, in the treatment cards' order.
  const usedSteps = new Set(months.flatMap((m) => [...m.main, ...m.asNeeded]));
  const used = Object.keys(labels).filter((step) => usedSteps.has(step));
  return (
    <div className="mt-4">
      <ol className="grid list-none grid-cols-2 gap-2 pl-0 sm:grid-cols-3 md:grid-cols-4">
        {months.map((m) => (
          <li
            key={m.month}
            data-limited={m.limited ? "true" : undefined}
            className={`rounded-md border p-3 ${m.limited ? "border-waves-gold/40 bg-waves-gold-light" : "border-zinc-200 bg-white"}`}
          >
            <p className="text-sm font-bold uppercase tracking-wide text-waves-blue-deeper">{m.label}</p>
            <ul className="mt-2 space-y-1">
              {m.main.map((step) => (
                <li key={step} className="flex items-center gap-2 text-sm font-semibold text-waves-blue-deeper">
                  <VisualIcon name={step} size={16} />
                  {labels[step] || step}
                </li>
              ))}
            </ul>
            {m.asNeeded.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
                <span>As needed</span>
                {m.asNeeded.map((step) => (
                  <span key={step} title={labels[step] || step} className="inline-flex">
                    <VisualIcon name={step} size={16} />
                    <span className="sr-only">{labels[step] || step}</span>
                  </span>
                ))}
              </p>
            )}
          </li>
        ))}
      </ol>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-600">
        {used.map((step) => (
          <li key={step} className="inline-flex items-center gap-1.5">
            <VisualIcon name={step} size={16} className="text-waves-blue-deeper" />
            {labels[step] || step}
          </li>
        ))}
        {limitLabel && (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-4 w-4 rounded-sm border border-waves-gold bg-waves-gold-light" />
            {limitLabel}
          </li>
        )}
      </ul>
    </div>
  );
}

function StepsVisual({ items = [] }) {
  return (
    <ol className="mt-4 grid list-none gap-3 pl-0 sm:grid-cols-2">
      {items.map((step, index) => (
        <li key={step.title} data-glass="soft" className="rounded-md border border-zinc-200 bg-surface-page p-4">
          <div className="flex items-center gap-2 text-waves-blue-deeper">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-waves-blue-deeper text-sm font-bold text-white">{index + 1}</span>
            <VisualIcon name={step.icon} size={18} />
            <span className="text-base font-semibold">{step.title}</span>
          </div>
          <p className="mt-2 text-base leading-6 text-slate-600">{step.text}</p>
        </li>
      ))}
    </ol>
  );
}

function CategoriesVisual({ items = [] }) {
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2">
      {items.map((item) => (
        <li key={item.key} className="flex gap-3 rounded-md border border-zinc-200 bg-white p-4">
          <IconBadge name={item.key} />
          <span>
            <span className="block text-base font-semibold text-waves-blue-deeper">{item.label}</span>
            <span className="mt-1 block text-base leading-6 text-slate-600">{item.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function TagsVisual({ items = [], note }) {
  return (
    <div className="mt-4">
      <ul className="flex list-none flex-wrap gap-2 pl-0">
        {items.map((tag) => (
          <li key={tag} className="rounded-full border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
            {tag}
          </li>
        ))}
      </ul>
      {note && <p className="mt-3 text-sm leading-6 text-slate-500">{note}</p>}
    </div>
  );
}

const SECTION_VISUALS = {
  tiles: TilesVisual,
  chips: ChipsVisual,
  year: YearVisual,
  steps: StepsVisual,
  categories: CategoriesVisual,
  tags: TagsVisual,
};

function Section({ section }) {
  // A v13 outline section may carry a drawing; its bullets are the text for readers that draw none.
  const Visual = SECTION_VISUALS[section.visual?.type];
  return (
    <section className="border-b border-zinc-200 py-6 last:border-b-0">
      <h2 className="text-xl font-semibold text-waves-blue-deeper">{section.title}</h2>
      {(section.body || !Visual) && <p className="mt-2 text-base leading-7 text-slate-600">{section.body}</p>}
      {Visual && <Visual {...section.visual} />}
      {!Visual && Array.isArray(section.bullets) && section.bullets.length > 0 && (
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
  useGlassSurface(true);
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
    <div data-glass-clear="" className="flex-1 bg-waves-page text-waves-blue-deeper">
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
                  {/* The v13 outline names its one program, not a grass (GATE_LAWN_OUTLINE_V13). */}
                  {content.property?.programLabel ? (
                    <div>
                      <dt className="text-zinc-500">Program</dt>
                      <dd className="font-medium text-waves-blue-deeper">{content.property.programLabel}</dd>
                    </div>
                  ) : (
                    <div>
                      <dt className="text-zinc-500">Turf type</dt>
                      <dd className="font-medium text-waves-blue-deeper">{content.property?.turfType || "To be confirmed"}</dd>
                    </div>
                  )}
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

      </div>
    </div>
  );
}
