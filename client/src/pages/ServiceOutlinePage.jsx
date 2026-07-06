import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CalendarDays, ClipboardCheck, FileText, MapPin, ShieldCheck, Sprout } from "lucide-react";
import BrandFooter from "../components/BrandFooter";
import { useGlassSurface, portalGlassInitial, watchPortalGlassDefault } from "../glass/glass-engine";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function LoadingState() {
  return (
    <div data-glass-clear="" className="min-h-screen bg-[#f7f4ee] px-4 py-10">
      <div data-glass="soft" className="mx-auto max-w-3xl rounded-md border border-zinc-200 bg-white p-6 text-zinc-600">
        Loading your lawn care program overview...
      </div>
    </div>
  );
}

function ErrorState({ message }) {
  return (
    <div data-glass-clear="" className="min-h-screen bg-[#f7f4ee] px-4 py-10">
      <div className="mx-auto max-w-3xl rounded-md border border-red-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-zinc-950">Service Outline Unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">{message}</p>
      </div>
    </div>
  );
}

function Section({ section }) {
  return (
    <section className="border-b border-zinc-200 py-6 last:border-b-0">
      <h2 className="text-xl font-semibold text-zinc-950">{section.title}</h2>
      <p className="mt-2 text-base leading-7 text-zinc-700">{section.body}</p>
      {Array.isArray(section.bullets) && section.bullets.length > 0 && (
        <ul className="mt-4 grid gap-2 text-sm leading-6 text-zinc-700 md:grid-cols-2">
          {section.bullets.map((bullet, index) => (
            <li key={`${section.key}-${index}`} data-glass="soft" className="flex gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <ClipboardCheck size={16} strokeWidth={1.75} className="mt-1 flex-shrink-0 text-emerald-700" />
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
  // Glass release (GATE_PORTAL_GLASS): cached server default resolves
  // synchronously (no legacy flash on repeat visits), the ui-flags fetch
  // keeps it fresh, ?glass=1 / ?glass=0 keep param precedence.
  const [glassActive, setGlassActive] = useState(portalGlassInitial);
  useEffect(() => watchPortalGlassDefault(setGlassActive), []);
  useGlassSurface(glassActive, "full");
  const [packet, setPacket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    document.title = "Your Lawn Care Program Overview | Waves";
    const meta = document.querySelector('meta[name="robots"]') || document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "noindex,nofollow,noarchive");
    if (!meta.parentNode) document.head.appendChild(meta);

    fetch(`${API_BASE}/service-outlines/${encodeURIComponent(token)}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        if (!cancelled) setPacket(data.packet);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "This link is unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

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
    <div data-glass-clear="" className="min-h-screen bg-[#f7f4ee] text-zinc-950">
      <header data-glass-clear="" className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link to="/" className="text-lg font-semibold tracking-tight text-zinc-950">Waves</Link>
          {estimatePath && (
            <a
              href={estimatePath}
              onClick={() => trackCtaClick(estimatePath)}
              data-glass-accent=""
              className="inline-flex h-10 items-center justify-center rounded-xs bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
            >
              View Estimate
            </a>
          )}
        </div>
      </header>

      <main>
        <section data-glass-clear="" className="bg-white">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[1fr_320px]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-xs border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                <Sprout size={14} strokeWidth={1.75} />
                Lawn Care Program
              </div>
              <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-zinc-950">{content.title}</h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-zinc-700">{content.intro}</p>
            </div>
            <aside data-glass="soft" className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Program Snapshot</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex gap-3">
                  <MapPin size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
                  <div>
                    <dt className="text-zinc-500">Service area</dt>
                    <dd className="font-medium text-zinc-950">{content.property?.addressSummary || "Service property"}</dd>
                  </div>
                </div>
                <div className="flex gap-3">
                  <Sprout size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
                  <div>
                    <dt className="text-zinc-500">Turf type</dt>
                    <dd className="font-medium text-zinc-950">{content.property?.turfType || "To be confirmed"}</dd>
                  </div>
                </div>
                <div className="flex gap-3">
                  <CalendarDays size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
                  <div>
                    <dt className="text-zinc-500">Season focus</dt>
                    <dd className="font-medium text-zinc-950">{content.season?.monthName || "Current visit"}</dd>
                  </div>
                </div>
                <div className="flex gap-3">
                  <ShieldCheck size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
                  <div>
                    <dt className="text-zinc-500">Product language</dt>
                    <dd className="font-medium text-zinc-950">May be used, not guaranteed</dd>
                  </div>
                </div>
              </dl>
            </aside>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-8">
          <div data-glass="card" className="rounded-md border border-zinc-200 bg-white px-5">
            {(content.sections || []).map((section) => (
              <Section key={section.key} section={section} />
            ))}
          </div>
        </section>

        {Array.isArray(content.productCards) && content.productCards.length > 0 && (
          <section className="mx-auto max-w-6xl px-4 pb-8">
            <div data-glass="card" className="rounded-md border border-zinc-200 bg-white p-5">
              <h2 className="text-xl font-semibold text-zinc-950">Approved Product Details</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-600">These products may be relevant when turf type, site conditions, label directions, weather, and local rules allow.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {content.productCards.map((product) => (
                  <article key={product.id} className="rounded-md border border-zinc-200 p-4">
                    <h3 className="font-semibold text-zinc-950">{product.name}</h3>
                    <p className="mt-1 text-xs uppercase tracking-wide text-zinc-500">{product.category}</p>
                    <p className="mt-3 text-sm leading-6 text-zinc-700">{product.summary}</p>
                    {product.epaRegistrationNumber && <p className="mt-3 text-xs text-zinc-500">EPA Reg. No. {product.epaRegistrationNumber}</p>}
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="mx-auto max-w-6xl px-4 pb-12">
          <div data-glass-ink="light" className="flex flex-col items-start justify-between gap-4 rounded-md bg-zinc-950 p-5 text-white md:flex-row md:items-center">
            <div>
              <h2 className="text-xl font-semibold">Ready to review the estimate?</h2>
              <p className="mt-1 text-sm text-zinc-300">The outline explains the program. The estimate shows pricing and approval steps.</p>
            </div>
            {estimatePath && (
              <a
                href={estimatePath}
                onClick={() => trackCtaClick(estimatePath)}
                className="inline-flex h-11 items-center justify-center rounded-xs bg-white px-5 text-sm font-semibold text-zinc-950 hover:bg-zinc-100"
              >
                <FileText size={16} strokeWidth={1.75} className="mr-2" />
                View Estimate
              </a>
            )}
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-4 pb-10">
          <BrandFooter />
        </div>
      </main>
    </div>
  );
}
