import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  BadgeCheck,
  Bell,
  Bug,
  CalendarDays,
  ChevronDown,
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
import { etDateString } from "../lib/timezone";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// The program a packet describes: a Tree & Shrub (GATE_TS_OUTLINE), Pest Control (GATE_PEST_OUTLINE) or Mosquito
// (GATE_MOSQUITO_OUTLINE) packet says so in content.serviceLine; every other packet is a lawn outline.
const PROGRAMS = {
  lawn_care: { badge: "Lawn Care Program", pageTitle: "Your Lawn Care Program Overview | Waves" },
  tree_shrub: { badge: "Tree & Shrub Program", pageTitle: "Your Tree & Shrub Program Overview | Waves" },
  pest_control: { badge: "Pest Control Program", pageTitle: "Your Pest Control Program Overview | Waves" },
  mosquito: { badge: "Mosquito Program", pageTitle: "Your Mosquito Program Overview | Waves" },
};
const programFor = (content) => PROGRAMS[content?.serviceLine] || PROGRAMS.lawn_care;

function LoadingState() {
  return (
    <div data-glass-clear="" className="flex-1 bg-waves-page px-4 py-10">
      <div data-glass="soft" className="mx-auto max-w-3xl rounded-md border border-zinc-200 bg-white p-6 text-slate-600">
        Loading your program overview...
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

// A tile with an `until` date (the detailed outline's watering-order tile) stops showing after that ET day: the
// packet is stored, and the order it describes ends.
const tileStillShown = (tile) => !tile.until || etDateString() <= tile.until;

// A block holds a day when its MM-DD window does; round 1 runs over the year end (Dec 25 to Feb 2), so its window wraps.
const blockHoldsDay = ({ from, to }, md) => Boolean(from && to) && (from <= to ? from <= md && md <= to : md >= from || md <= to);

// The year-bar block that holds today (ET), found from the stored from/to dates so a packet read weeks after it was built
// still marks the right block. Null when the page has no year bar or a block has no dates.
function findToday(sections) {
  const bar = (sections || []).map((section) => section.visual).find((visual) => visual?.type === "yearBar");
  const md = etDateString().slice(5);
  const block = (bar?.blocks || []).find((candidate) => blockHoldsDay(candidate, md));
  return block ? { key: block.key, block, anchorPrefix: bar.anchorPrefix } : null;
}

function TilesVisual({ items = [] }) {
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2">
      {items.filter(tileStillShown).map((tile) => (
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
      {note && <p className="text-base leading-6 text-slate-500">{note}</p>}
    </div>
  );
}

// The key under the year chart and the month list: the steps the months use, in the treatment cards' order, and
// the summer-limit swatch.
function StepKey({ months, labels, limitLabel }) {
  const usedSteps = new Set(months.flatMap((m) => [...m.main, ...m.asNeeded]));
  const used = Object.keys(labels).filter((step) => usedSteps.has(step));
  return (
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
  );
}

function AsNeededIcons({ steps, labels }) {
  if (!steps.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
      <span>As needed</span>
      {steps.map((step) => (
        <span key={step} title={labels[step] || step} className="inline-flex">
          <VisualIcon name={step} size={16} />
          <span className="sr-only">{labels[step] || step}</span>
        </span>
      ))}
    </span>
  );
}

function YearVisual({ months = [], labels = {}, limitLabel }) {
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
              <p className="mt-2">
                <AsNeededIcons steps={m.asNeeded} labels={labels} />
              </p>
            )}
          </li>
        ))}
      </ol>
      <StepKey months={months} labels={labels} limitLabel={limitLabel} />
    </div>
  );
}

// The detailed outline's month list (GATE_LAWN_OUTLINE_DETAIL): one row per month with its steps; the build month
// and the next two arrive open, and any other row opens on a tap to show what that visit does and one thing to do at
// home.
function MonthsVisual({ months = [], labels = {}, limitLabel }) {
  return (
    <div className="mt-4">
      <ol className="list-none space-y-2 pl-0">
        {months.map((m) => (
          <li key={m.month} id={`month-${m.month}`} className="scroll-mt-24">
            <details
              open={m.open || undefined}
              data-limited={m.limited ? "true" : undefined}
              className={`group rounded-md border ${m.limited ? "border-waves-gold/40 bg-waves-gold-light" : "border-zinc-200 bg-white"}`}
            >
              <summary className="flex cursor-pointer list-none items-start gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
                {/* min-w, not w: a Pest Control row is a season ("Winter"), wider than a month's three letters. */}
                <span className="min-w-10 flex-shrink-0 text-sm font-bold uppercase tracking-wide text-waves-blue-deeper">{m.label}</span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  {m.main.map((step) => (
                    <span key={step} className="inline-flex items-center gap-1.5 text-sm font-semibold text-waves-blue-deeper">
                      <VisualIcon name={step} size={16} />
                      {labels[step] || step}
                    </span>
                  ))}
                  <AsNeededIcons steps={m.asNeeded} labels={labels} />
                </span>
                <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" className="flex-shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-2 px-3 pb-3">
                {m.visit && <p className="text-base leading-6 text-slate-600">{m.visit}</p>}
                {m.atHome && (
                  <p className="rounded-md bg-waves-blue-light px-3 py-2 text-base leading-6 text-waves-blue-deeper">
                    <span className="font-semibold">At home: </span>
                    {m.atHome}
                  </p>
                )}
              </div>
            </details>
          </li>
        ))}
      </ol>
      <StepKey months={months} labels={labels} limitLabel={limitLabel} />
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
        // Two cards may share an icon key (the Tree & Shrub outline's two fertilizer cards), so the label keys the card.
        <li key={`${item.key}-${item.label}`} className="flex gap-3 rounded-md border border-zinc-200 bg-white p-4">
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
      {note && <p className="mt-3 text-base leading-6 text-slate-500">{note}</p>}
    </div>
  );
}

// ---- 9-round outline visuals (GATE_LAWN_OUTLINE_VISUAL): the year bar, round cards, timeline, fact tiles and FAQ.
// Nothing draws them until the server emits these visual types; an unknown type keeps the bullet cards.

// One color per whole-lawn step, used on the year bar, the round cards and their key.
const STEP_TONES = {
  feeding: "text-waves-success",
  barrier: "text-waves-blue-deeper",
  micros: "text-waves-blue",
  insects: "text-waves-blue-deeper",
  inspection: "text-slate-500",
};
const STEP_FILLS = {
  feeding: "bg-waves-success-bg",
  barrier: "bg-waves-blue-light",
  micros: "bg-waves-blue-50",
  insects: "bg-zinc-100",
  inspection: "bg-zinc-100",
};
const toneOf = (step) => STEP_TONES[step] || "text-waves-blue-deeper";

// A link the outline points to (a Waves blog post or a UF/IFAS page), drawn as a small card. It leaves the portal, so
// it opens in a new tab.
function LinkCards({ links = [] }) {
  if (!links.length) return null;
  return (
    <ul className="mt-3 grid list-none gap-2 pl-0 sm:grid-cols-2">
      {links.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-waves-blue-deeper no-underline hover:border-waves-blue"
          >
            <FileText size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-waves-blue" />
            <span className="min-w-0 text-sm leading-5">
              <span className="font-semibold">{link.label}</span>
              {link.source && <span className="text-zinc-500"> · {link.source}</span>}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// The tick row over the bar: month letters on a desktop (positioned by day offset), the start, middle and end labels
// on a phone.
function YearBarTicks({ months, anchors, pct }) {
  return (
    <>
      {months.length > 0 && (
        <div className="relative hidden h-5 text-sm font-semibold text-zinc-500 sm:block print:block" aria-hidden="true">
          {months.map((m) => (
            <span key={m.label + m.offset} className="absolute top-0" style={{ left: pct(m.offset) }}>{m.label}</span>
          ))}
        </div>
      )}
      {anchors.length > 0 && (
        <div className="flex justify-between text-sm font-semibold text-zinc-500 sm:hidden print:hidden" aria-hidden="true">
          {anchors.map((a) => <span key={a}>{a}</span>)}
        </div>
      )}
    </>
  );
}

// One block of the bar: its label, one colored icon per main step, and the job name under it on a desktop and in print.
// A dense bar (twelve months) is too narrow on a phone for a month name, so a phone shows the first letter; on a desktop
// each job name hangs diagonally from its own block, in a slot tall enough that neighbors never overlap.
function YearBarBlock({ block, anchorPrefix, labels, pct, dense, current }) {
  const main = block.main || [];
  const jobs = main.map((step) => labels[step] || step).join(" and ");
  const ring = current ? "border-waves-blue ring-2 ring-waves-blue" : "border-zinc-200";
  return (
    <li style={{ width: pct(block.days) }} className="min-w-0">
      <a
        href={`#${anchorPrefix}-${block.key}`}
        aria-label={`${block.label}${block.window ? `, ${block.window}` : ""}: ${jobs}${current ? " (now)" : ""}`}
        aria-current={current ? "true" : undefined}
        data-current={current ? "true" : undefined}
        className={`flex h-[84px] flex-col overflow-hidden rounded-md border no-underline ${ring}`}
      >
        <span className="bg-white py-1 text-center text-sm font-bold leading-none tracking-tight text-waves-blue-deeper">
          {dense && <span className="sm:hidden print:hidden">{String(block.label).slice(0, 1)}</span>}
          <span className={dense ? "hidden sm:inline print:inline" : ""}>{block.label}</span>
        </span>
        {main.map((step) => (
          <span key={step} className={`flex flex-1 items-center justify-center ${STEP_FILLS[step] || "bg-white"}`}>
            <VisualIcon name={step} size={18} className={toneOf(step)} />
          </span>
        ))}
      </a>
      {block.short && !dense && <span className="mt-1 hidden text-center text-sm leading-tight text-slate-600 sm:block print:block">{block.short}</span>}
      {block.short && dense && (
        <span data-job-slot="" className="relative hidden h-28 sm:block print:block">
          <span className="absolute left-0 top-1 origin-top-left rotate-45 whitespace-nowrap text-sm leading-tight text-slate-600">{block.short}</span>
        </span>
      )}
    </li>
  );
}

// The key under the bar: the steps it uses and the summer limit swatch.
function YearBarKey({ keySteps, labels, limit }) {
  return (
    <ul className="mt-3 flex list-none flex-wrap gap-x-4 gap-y-2 pl-0 text-sm text-slate-600">
      {keySteps.map((step) => (
        <li key={step} className="inline-flex items-center gap-1.5">
          <VisualIcon name={step} size={16} className={toneOf(step)} />
          {labels[step] || step}
        </li>
      ))}
      {limit && (
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-1.5 w-5 rounded-full bg-waves-gold" />
          {limit.label}
        </li>
      )}
    </ul>
  );
}

// The program year as one bar: a block per round (or per month) sized by its days, the step icons in their colors, the
// block that holds today marked, and the summer nitrogen limit as a band flush under the blocks. Each block links to its
// card or row. The bar keeps its colors when the page prints.
function YearBarVisual({ blocks = [], anchorPrefix = "round", months = [], anchors = [], limit = null, labels = {}, keySteps = [], today = null, caption = null }) {
  const total = blocks.reduce((sum, b) => sum + (b.days || 0), 0) || 365;
  const pct = (days) => `${(days / total) * 100}%`;
  return (
    <div className="mt-4" style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
      <div data-glass="soft" className="rounded-md border border-zinc-200 bg-surface-page p-3">
        <YearBarTicks months={months} anchors={anchors} pct={pct} />
        <ol className={`mt-1 flex list-none pl-0 ${blocks.length > 9 ? "gap-0.5" : "gap-1"}`}>
          {blocks.map((block) => (
            <YearBarBlock key={block.key} block={block} anchorPrefix={anchorPrefix} labels={labels} pct={pct} dense={blocks.length > 9} current={block.key === today?.key} />
          ))}
        </ol>
        {limit && (
          <div className="relative mt-1 h-1.5" aria-hidden="true">
            <span className="absolute top-0 h-1.5 rounded-full bg-waves-gold" style={{ left: pct(limit.offset), width: pct(limit.days) }} />
          </div>
        )}
        <YearBarKey keySteps={keySteps} labels={labels} limit={limit} />
        {today?.block.now && (
          <p className="mt-3 flex items-start gap-2 text-sm font-semibold text-waves-blue-deeper">
            <span className="mt-0.5 inline-block h-3.5 w-3.5 flex-shrink-0 rounded-sm ring-2 ring-waves-blue" aria-hidden="true" />
            {today.block.now}
          </p>
        )}
        {caption && <p className="mt-2 text-sm leading-5 text-slate-600">{caption}</p>}
      </div>
    </div>
  );
}

// One round card: the header line carries the dates, the body the whole-lawn steps, spot work, why now, one thing to
// do at home and links. The round that holds today starts open. The glass sits on the <li>, because glass forces its own
// border and shadow on whatever it marks, and that would hide the current card's ring on the <details>.
function RoundCard({ round, labels, current }) {
  const main = round.main || [];
  return (
    <li id={`round-${round.n}`} aria-current={current ? "step" : undefined} data-glass="soft" className="scroll-mt-24 rounded-md">
      <details open={current || undefined} className={`group rounded-md ${current ? "ring-2 ring-inset ring-waves-blue" : ""}`}>
        <summary className="flex cursor-pointer list-none items-start gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-waves-blue-deeper text-lg font-bold text-white" aria-hidden="true">
            {round.n}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold text-zinc-500">Round {round.n} · {round.window}</span>
              {current && <span className="rounded-full bg-waves-blue px-2 py-0.5 text-sm font-semibold text-white">Now</span>}
            </span>
            <span className="mt-0.5 block text-base font-semibold text-waves-blue-deeper">{round.title}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {main.map((step) => (
                <span key={step} className="inline-flex items-center gap-1.5 text-sm font-semibold text-waves-blue-deeper">
                  <VisualIcon name={step} size={16} className={STEP_TONES[step] || ""} />
                  {labels[step] || step}
                </span>
              ))}
            </span>
          </span>
          <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" className="mt-1 flex-shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-2 px-3 pb-3">
          <p className="text-base leading-6 text-slate-600">{round.why}</p>
          {round.extra && <p className="text-sm font-semibold leading-5 text-waves-success">{round.extra}</p>}
          {round.asNeeded?.length > 0 && <p><AsNeededIcons steps={round.asNeeded} labels={labels} /></p>}
          {round.atHome && (
            <p className="rounded-md bg-waves-blue-light px-3 py-2 text-base leading-6 text-waves-blue-deeper">
              <span className="font-semibold">At home: </span>
              {round.atHome}
            </p>
          )}
          <LinkCards links={round.links} />
        </div>
      </details>
    </li>
  );
}

// The nine rounds as cards. The page opens and marks the round that holds today.
function RoundsVisual({ rounds = [], labels = {}, today = null }) {
  return (
    <ol className="mt-4 list-none space-y-2 pl-0">
      {rounds.map((round) => <RoundCard key={round.n} round={round} labels={labels} current={round.n === today?.key} />)}
    </ol>
  );
}

// After a visit, as a timeline: what to hold, when, and when to expect a change.
function TimelineVisual({ items = [], note }) {
  return (
    <div className="mt-4">
      <ol className="relative list-none space-y-3 border-l-2 border-waves-blue/40 pl-0 sm:flex sm:gap-3 sm:space-y-0 sm:border-l-0 sm:border-t-2">
        {items.map((item) => (
          <li key={`${item.when}-${item.title}`} className="relative ml-4 sm:ml-0 sm:flex-1 sm:pt-4">
            <span className="absolute -left-[25px] top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-white bg-waves-blue sm:-top-[9px] sm:left-0" aria-hidden="true" />
            <p className="text-sm font-bold uppercase tracking-wide text-waves-blue">{item.when}</p>
            <p className="mt-1 flex items-start gap-2 text-base font-semibold leading-6 text-waves-blue-deeper">
              <VisualIcon name={item.icon} size={18} className="mt-0.5 flex-shrink-0" />
              {item.title}
            </p>
            <p className="mt-1 text-sm leading-5 text-slate-600">{item.text}</p>
          </li>
        ))}
      </ol>
      {note && <p className="mt-3 text-sm leading-5 text-slate-500">{note}</p>}
    </div>
  );
}

// One picture under a fact tile, linked to its larger version in a new tab.
function FactPicture({ picture, className = "" }) {
  return (
    <a href={picture.href} target="_blank" rel="noopener noreferrer" className={`block overflow-hidden rounded-md border border-zinc-200 bg-white no-underline ${className}`}>
      <img src={picture.image} alt={picture.imageAlt || ""} loading="lazy" className="h-44 w-full object-cover object-top" />
      {picture.linkLabel && <span className="block px-3 py-2 text-sm font-semibold text-waves-blue">{picture.linkLabel}</span>}
    </a>
  );
}

// The pictures under a fact tile (two sit side by side), one picture, or a link alone as a text link.
function FactMedia({ item }) {
  // A packet stored before 2026-11-01 carries the tour videos, and the public route serves packets as stored: such a video
  // still plays, loading nothing until it is played (`preload="none"`, the picture is its poster).
  if (item.video) {
    return (
      <figure className="mt-3 overflow-hidden rounded-md border border-zinc-200 bg-white">
        <video controls preload="none" poster={item.image} className="aspect-video w-full bg-waves-blue-deeper">
          <source src={item.video} type="video/mp4" />
        </video>
        {item.linkLabel && <figcaption className="px-3 py-2 text-sm text-slate-600">{item.linkLabel}</figcaption>}
      </figure>
    );
  }
  if (item.pictures) {
    return (
      <div className={`grid grid-cols-2 gap-3 ${item.wide ? "mt-3 sm:mt-0" : "mt-3"}`}>
        {item.pictures.map((picture) => <FactPicture key={picture.image} picture={picture} />)}
      </div>
    );
  }
  if (item.image) return <FactPicture picture={item} className={item.wide ? "mt-3 sm:mt-0" : "mt-3"} />;
  if (!item.href) return null;
  return <a href={item.href} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm font-semibold text-waves-blue no-underline hover:underline">{item.linkLabel}</a>;
}

// Big-number tiles (watering depth, mowing height), the Monday email tile with its sample pictures and the after-visit pictures.
// A tile with `until` (the one-day watering order) hides after that ET day, as in TilesVisual: a stored packet keeps it.
function FactsVisual({ items = [] }) {
  return (
    <ul className="mt-4 grid list-none gap-3 pl-0 sm:grid-cols-2">
      {items.filter(tileStillShown).map((item) => (
        <li key={item.title} data-glass="soft" className={`rounded-md border border-zinc-200 bg-surface-page p-4 ${item.wide ? "sm:col-span-2 sm:grid sm:grid-cols-2 sm:items-start sm:gap-4" : ""}`}>
          <div>
            {item.big && <p className="text-3xl font-bold tracking-tight text-waves-blue-deeper">{item.big}</p>}
            <p className="mt-1 flex items-center gap-2 text-base font-semibold text-waves-blue-deeper">
              {item.icon && <VisualIcon name={item.icon} size={18} />}
              {item.title}
            </p>
            <p className="mt-1 text-base leading-6 text-slate-600">{item.text}</p>
          </div>
          <FactMedia item={item} />
        </li>
      ))}
    </ul>
  );
}

// One FAQ row: a closed question, its answer one tap away, and links to read more.
function FaqRow({ item }) {
  return (
    <li>
      <details data-glass="soft" className="group rounded-md border border-zinc-200 bg-surface-page">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-3 py-3 text-base font-semibold text-waves-blue-deeper [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1">{item.q}</span>
          <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" className="mt-1 flex-shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-3 pb-3">
          <p className="text-base leading-6 text-slate-600">{item.a}</p>
          <LinkCards links={item.links || []} />
        </div>
      </details>
    </li>
  );
}

// Questions customers ask most, every one closed; the rest sit in one closed "More questions" row.
function FaqVisual({ items = [], more = [] }) {
  return (
    <div className="mt-4 space-y-2">
      <ul className="list-none space-y-2 pl-0">{items.map((item) => <FaqRow key={item.q} item={item} />)}</ul>
      {more.length > 0 && (
        <details className="rounded-md border border-dashed border-zinc-300 bg-surface-page">
          <summary className="cursor-pointer px-3 py-3 text-sm font-semibold text-waves-blue">More questions</summary>
          <ul className="list-none space-y-2 px-3 pb-3 pl-3">{more.map((item) => <FaqRow key={item.q} item={item} />)}</ul>
        </details>
      )}
    </div>
  );
}

const SECTION_VISUALS = {
  tiles: TilesVisual,
  chips: ChipsVisual,
  year: YearVisual,
  months: MonthsVisual,
  steps: StepsVisual,
  categories: CategoriesVisual,
  tags: TagsVisual,
  yearBar: YearBarVisual,
  rounds: RoundsVisual,
  timeline: TimelineVisual,
  facts: FactsVisual,
  faq: FaqVisual,
};

function Section({ section, today }) {
  // A v13 outline section may carry a drawing; its bullets are the text for readers that draw none.
  const Visual = SECTION_VISUALS[section.visual?.type];
  return (
    <section className="border-b border-zinc-200 py-6 last:border-b-0">
      <h2 className="text-xl font-semibold text-waves-blue-deeper">{section.title}</h2>
      {(section.body || !Visual) && <p className="mt-2 text-base leading-7 text-slate-600">{section.body}</p>}
      {Visual && <Visual {...section.visual} today={today} />}
      {!Visual && Array.isArray(section.bullets) && section.bullets.length > 0 && (
        <ul className="mt-4 grid gap-2 text-base leading-6 text-slate-600 md:grid-cols-2">
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

// The side panel: where, which program, the plan, and today's round or month.
function SnapshotAside({ content, today }) {
  const date = today
    ? { label: today.anchorPrefix === "round" ? "Now" : "Season focus", value: today.block.aside }
    : { label: "Season focus", value: content.season?.monthName || "Current visit" };
  return (
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
        {content.property?.planLabel && (
          <div className="flex gap-3">
            <ListChecks size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
            <div>
              <dt className="text-zinc-500">Your plan</dt>
              <dd className="font-medium text-waves-blue-deeper">{content.property.planLabel}</dd>
            </div>
          </div>
        )}
        <div className="flex gap-3">
          <CalendarDays size={16} strokeWidth={1.75} className="mt-0.5 text-zinc-500" />
          <div>
            <dt className="text-zinc-500">{date.label}</dt>
            <dd className="font-medium text-waves-blue-deeper">{date.value}</dd>
          </div>
        </div>
      </dl>
    </aside>
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

  const program = programFor(packet?.content);
  useEffect(() => {
    document.title = program.pageTitle;
  }, [program.pageTitle]);

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
  const today = findToday(content.sections);
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
              data-glass-size="primary"
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
              <div className="inline-flex items-center gap-2 rounded-xs border border-waves-success-border bg-waves-success-bg px-3 py-1 text-sm font-semibold uppercase tracking-wide text-waves-success">
                <Sprout size={14} strokeWidth={1.75} />
                {program.badge}
              </div>
              <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-waves-blue-deeper">{content.title}</h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">{content.intro}</p>
            </div>
            <SnapshotAside content={content} today={today} />
          </div>
        </section>

        <section className="mx-auto max-w-[760px] px-4 py-8">
          <div data-glass="card" className="rounded-md border border-zinc-200 bg-white px-5">
            {(content.sections || []).map((section) => (
              <Section key={section.key} section={section} today={today} />
            ))}
          </div>
        </section>

        {Array.isArray(content.productCards) && content.productCards.length > 0 && (
          <section className="mx-auto max-w-[760px] px-4 pb-8">
            <div data-glass="card" className="rounded-md border border-zinc-200 bg-white p-5">
              <h2 className="text-xl font-semibold text-waves-blue-deeper">Approved Product Details</h2>
              <p className="mt-2 text-base leading-6 text-slate-600">These products may be relevant when turf type, site conditions, label directions, weather, and local rules allow.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {content.productCards.map((product) => (
                  <article key={product.id} className="rounded-md border border-zinc-200 p-4">
                    <h3 className="font-semibold text-waves-blue-deeper">{product.name}</h3>
                    <p className="mt-1 text-sm uppercase tracking-wide text-zinc-500">{product.category}</p>
                    <p className="mt-3 text-base leading-6 text-slate-600">{product.summary}</p>
                    {product.epaRegistrationNumber && <p className="mt-3 text-sm text-zinc-500">EPA Reg. No. {product.epaRegistrationNumber}</p>}
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
              <p className="mt-1 text-base text-zinc-300">The outline explains the program. The estimate shows pricing and approval steps.</p>
            </div>
            {estimatePath && (
              <a
                href={estimatePath}
                onClick={() => trackCtaClick(estimatePath)}
                data-glass-accent=""
                data-glass-size="primary"
                className="inline-flex h-12 items-center justify-center rounded-[10px] bg-white px-5 text-sm font-semibold text-waves-blue-deeper hover:bg-surface-hover"
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
