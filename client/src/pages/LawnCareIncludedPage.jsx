import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ClipboardCheck, FileText, MapPinned, ShieldCheck, Sprout } from "lucide-react";

const TURF_SECTIONS = [
  {
    title: "St. Augustine",
    summary: "Managed for density, color, stress, weeds, insects, and disease risk.",
    details: [
      "One core St. Augustine program adjusted by site observations",
      "Chinch bug scouting, weed and sedge checks, and disease monitoring",
      "Soil-test-gated fertility decisions and seasonal pre-emergent planning",
      "Irrigation, heat, shade, and thatch observations",
    ],
  },
  {
    title: "Bermuda",
    summary: "Dense, durable turf that needs active management.",
    details: [
      "Growth response, weed pressure, armyworm, and mole cricket scouting",
      "Seasonal nitrogen planning and growth-regulator documentation where used",
      "Disease risk review and winter dormancy expectations",
    ],
  },
  {
    title: "Zoysia",
    summary: "Dense turf that should be managed conservatively.",
    details: [
      "Lower fertility pressure to reduce thatch and disease risk",
      "Large patch monitoring and careful growth stimulation",
      "Irrigation control and stress-aware weed management",
    ],
  },
  {
    title: "Bahia",
    summary: "Realistic improvement for a low-input survival turf.",
    details: [
      "Weed reduction, mole cricket monitoring, and realistic expectations",
      "Irrigated versus non-irrigated classification",
      "Seed head and dormancy communication",
    ],
  },
];

const SEASONS = [
  ["January-March", "Prevention and baseline", "Pre-emergent planning, early weed pressure control, soil samples where appropriate, disease scouting, irrigation observations, and baseline turf notes."],
  ["April-May", "Spring nutrition and pest preparation", "Final spring nutrition where allowed, soil-test-gated phosphorus, iron and color support, sedge checks, pest-pressure preparation, and summer heat planning."],
  ["June-September", "Summer stress strategy", "Restricted-season awareness, heat-safe weed control, pest scouting, micronutrient support, moisture observations, and avoiding unnecessary growth pushing."],
  ["October-December", "Recovery and winter prep", "Fall recovery, disease prevention where risk supports it, thatch comparison, winter hardening, dormancy expectations, and annual reporting."],
];

const FAQS = [
  ["Do you use the same products every month?", "No. A lawn program changes with turf type, season, weather, lawn condition, label directions, and local fertilizer rules."],
  ["Are products EPA registered?", "Pesticide products include EPA registration numbers where applicable. Fertilizers, soil amendments, wetting agents, and biostimulants may not have EPA registration numbers because they are not pesticide products."],
  ["Why was fertilizer not applied?", "Fertilizer may be skipped because of season, weather, turf stress, local restrictions, soil-test results, or because the lawn needs another type of support more than growth stimulation."],
  ["What should pets and children do after treatment?", "Follow the technician service report and product-specific instructions. As a general precaution, people and pets should stay off treated areas until the application has dried unless the label or technician instructions require longer."],
];

function CheckItem({ children }) {
  return (
    <li className="flex gap-2">
      <ClipboardCheck size={16} strokeWidth={1.75} className="mt-1 flex-shrink-0 text-emerald-700" />
      <span>{children}</span>
    </li>
  );
}

export default function LawnCareIncludedPage() {
  useEffect(() => {
    document.title = "What's Included in Lawn Care Service? | Waves Lawn Care";
    const desc = document.querySelector('meta[name="description"]') || document.createElement("meta");
    desc.setAttribute("name", "description");
    desc.setAttribute("content", "Learn how Waves lawn care visits are planned around grass type, season, lawn condition, product accountability, local fertilizer rules, and post-service reporting.");
    if (!desc.parentNode) document.head.appendChild(desc);
  }, []);

  return (
    <div className="min-h-screen bg-[#f7f4ee] text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/" className="text-lg font-semibold tracking-tight">Waves</Link>
          <Link to="/estimate/lawn" className="inline-flex h-10 items-center justify-center rounded-xs bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800">
            Request Lawn Care Estimate
          </Link>
        </div>
      </header>

      <main>
        <section className="bg-white">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 lg:grid-cols-[1fr_360px]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-xs border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                <Sprout size={14} strokeWidth={1.75} />
                Turf Health Program
              </div>
              <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-tight md:text-5xl">What's Included in a Waves Lawn Care Visit?</h1>
              <p className="mt-5 max-w-3xl text-lg leading-8 text-zinc-700">
                Waves lawn care is a documented turf health program, not a one-size-fits-all spray. Each visit is guided by grass type, season, lawn condition, weather, product labels, local fertilizer rules, and technician observations.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link to="/estimate/lawn" className="inline-flex h-11 items-center justify-center rounded-xs bg-zinc-950 px-5 text-sm font-semibold text-white hover:bg-zinc-800">Request Estimate</Link>
                <a href="#reports" className="inline-flex h-11 items-center justify-center rounded-xs border border-zinc-300 bg-white px-5 text-sm font-semibold text-zinc-950 hover:bg-zinc-50">See Reporting</a>
              </div>
            </div>
            <aside className="rounded-md border border-zinc-200 bg-zinc-50 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Built Around</h2>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-zinc-700">
                <CheckItem>Turf-specific program logic</CheckItem>
                <CheckItem>Season-aware treatments</CheckItem>
                <CheckItem>Product transparency</CheckItem>
                <CheckItem>Local fertilizer-rule awareness</CheckItem>
                <CheckItem>Photos and service notes</CheckItem>
                <CheckItem>Customer portal history</CheckItem>
              </ul>
            </aside>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-10">
          <div className="rounded-md border border-zinc-200 bg-white p-6">
            <h2 className="text-2xl font-semibold">More Than a Standard Spray Visit</h2>
            <p className="mt-3 max-w-4xl text-base leading-7 text-zinc-700">
              Your lawn does not need the same treatment every visit. A Waves visit starts with assessment, then treatment decisions are adjusted based on turf type, season, weather, weed pressure, insect pressure, disease risk, irrigation, local fertilizer rules, and previous service history.
            </p>
            <p className="mt-4 text-sm font-semibold uppercase tracking-wide text-emerald-800">Assessment comes before application.</p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-10">
          <h2 className="text-2xl font-semibold">What We Assess Each Visit</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {[
              "Turf color and density",
              "Thinning or bare areas",
              "Weed and sedge pressure",
              "Insect pressure",
              "Disease indicators",
              "Irrigation coverage",
              "Drought or heat stress",
              "Mowing or scalping stress",
              "Thatch indicators",
              "Shade stress",
              "Progress since last visit",
              "Customer action items",
            ].map((item) => (
              <div key={item} className="rounded-md border border-zinc-200 bg-white p-3 text-sm text-zinc-700">{item}</div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-10">
          <h2 className="text-2xl font-semibold">Turf Type Expectations</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {TURF_SECTIONS.map((section) => (
              <article key={section.title} className="rounded-md border border-zinc-200 bg-white p-5">
                <h3 className="text-lg font-semibold">{section.title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-700">{section.summary}</p>
                <ul className="mt-4 space-y-2 text-sm leading-6 text-zinc-700">
                  {section.details.map((detail) => <CheckItem key={detail}>{detail}</CheckItem>)}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-10">
          <div className="flex items-center gap-2">
            <CalendarDays size={20} strokeWidth={1.75} className="text-emerald-700" />
            <h2 className="text-2xl font-semibold">Seasonal Treatment Calendar</h2>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {SEASONS.map(([months, title, body]) => (
              <article key={months} className="rounded-md border border-zinc-200 bg-white p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{months}</p>
                <h3 className="mt-2 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-700">{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-10">
          <div className="grid gap-4 lg:grid-cols-3">
            <article className="rounded-md border border-zinc-200 bg-white p-5">
              <ShieldCheck size={22} strokeWidth={1.75} className="text-emerald-700" />
              <h2 className="mt-3 text-xl font-semibold">Product Transparency</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-700">Some visits focus on weed control, some on pest monitoring, some on micronutrient or stress support, and some on observation. Product choices depend on turf type, season, weather, label directions, local rules, and what the lawn is showing.</p>
            </article>
            <article className="rounded-md border border-zinc-200 bg-white p-5">
              <MapPinned size={22} strokeWidth={1.75} className="text-emerald-700" />
              <h2 className="mt-3 text-xl font-semibold">Local Rule Awareness</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-700">Local fertilizer rules may affect whether nitrogen or phosphorus can be applied during certain months. When fertilizer is restricted, the visit may focus on inspection, pest monitoring, micronutrients, iron, soil support, and stress management.</p>
            </article>
            <article id="reports" className="rounded-md border border-zinc-200 bg-white p-5">
              <FileText size={22} strokeWidth={1.75} className="text-emerald-700" />
              <h2 className="mt-3 text-xl font-semibold">Post-Service Reports</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-700">The estimate outline explains what may be used. The post-service report shows what was actually done, including products applied, EPA registration numbers where applicable, photos, technician notes, what to expect, and follow-up items.</p>
            </article>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-10">
          <div className="rounded-md border border-zinc-200 bg-white p-6">
            <h2 className="text-2xl font-semibold">What This Does Not Include</h2>
            <p className="mt-3 text-base leading-7 text-zinc-700">Lawn care treatments support turf health, weed control, pest monitoring, and seasonal improvement, but some issues require separate work or customer action.</p>
            <ul className="mt-4 grid gap-2 text-sm leading-6 text-zinc-700 md:grid-cols-2">
              <CheckItem>Irrigation repairs unless separately quoted</CheckItem>
              <CheckItem>Mowing unless separately quoted</CheckItem>
              <CheckItem>Sod, seed, topdressing, or bare-area renovation unless quoted</CheckItem>
              <CheckItem>Correction of heavy shade, poor watering, or cultural issues by treatment alone</CheckItem>
            </ul>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-12">
          <h2 className="text-2xl font-semibold">Common Questions</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {FAQS.map(([question, answer]) => (
              <article key={question} className="rounded-md border border-zinc-200 bg-white p-5">
                <h3 className="font-semibold">{question}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-700">{answer}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
