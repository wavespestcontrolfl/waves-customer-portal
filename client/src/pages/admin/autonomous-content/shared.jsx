import { cn } from "../../../components/ui";
import { ArrowLeft, ExternalLink } from "lucide-react";

export const ACTIVITY_STATUSES = {
  pending: "Queued",
  claimed: "Running",
  pending_review: "Processing / held",
  done: "Completed",
  skipped: "Skipped",
  expired: "Expired",
};

export function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function gateTag(summary, qualityGate) {
  if (!summary) return { tone: "neutral", label: "—" };
  // comparison_ok === false means the comparison-table gate failed (named
  // competitors); it previously wasn't checked here, so a failing draft
  // could show "Gate passed".
  if (
    (summary.hard_failures || []).length > 0 ||
    qualityGate?.ok === false ||
    (summary.quality_ok === false && summary.quality_score != null) ||
    summary.uniqueness_ok === false ||
    summary.seo_completion_ok === false ||
    summary.comparison_ok === false ||
    summary.topic_ok === false
  ) {
    return { tone: "alert", label: "Needs fix" };
  }
  if ((summary.soft_failures || []).length > 0) return { tone: "neutral", label: "Soft flags" };
  if (summary.quality_ok === true && summary.uniqueness_ok !== false) return { tone: "green", label: "Gate passed" };
  return { tone: "neutral", label: "In review" };
}

export function linkTagTone(status) {
  if (status === "failed" || status === "dismissed") return "alert";
  if (["patch_candidate", "pr_open", "merged", "deployed"].includes(status)) return "forest";
  if (status === "verified" || status === "applied") return "green";
  return "neutral";
}

export function isNamedCompetitor(item) {
  return item?.skip_reason === "named_competitor_review";
}

export function PhoneFrame({ src }) {
  // The App Store capture already includes the app's own top bar, so no hardware
  // notch is drawn over it — just a rounded bezel + screen for a clean mockup.
  return (
    <div className="relative rounded-[2rem] border-[5px] border-zinc-900 bg-zinc-900 shadow-2xl ring-1 ring-white/10">
      <img src={src} alt="Waves customer app" className="block w-full rounded-[1.6rem]" loading="lazy" />
    </div>
  );
}

export function PillTab({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-9 shrink-0 rounded-full px-4 text-13 font-medium transition-colors u-focus-ring",
        active ? "bg-[#43B02A] text-white" : "bg-white/10 text-white/80 hover:bg-white/20",
      )}
    >
      {children}
    </button>
  );
}

export function KpiRow({ children, cols = 4 }) {
  return (
    <div className={cn("mb-4 grid grid-cols-2 gap-2.5 sm:gap-3", cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4")}>
      {children}
    </div>
  );
}

export function Kpi({ label, value, emphasize }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3 sm:p-4">
      <div className="text-11 uppercase tracking-label text-zinc-400 sm:text-12">{label}</div>
      <div
        className={cn(
          "mt-1 text-22 leading-none tabular-nums sm:text-28",
          emphasize ? "font-medium text-[#43B02A]" : "text-zinc-900",
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function ListHeader({ icon: Icon, title, count }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <Icon size={15} strokeWidth={2} className="text-[#2E7D20]" />
      <span className="text-12 uppercase tracking-label text-zinc-500">{title}</span>
      {typeof count === "number" && (
        <span className="rounded-full bg-zinc-100 px-2 text-11 tabular-nums text-zinc-500">{count}</span>
      )}
    </div>
  );
}

export function RowCard({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-2xl border p-3 text-left transition-colors sm:p-4 u-focus-ring",
        active ? "border-[#43B02A] bg-[#F1F9EE]" : "border-zinc-200 bg-white hover:border-[#43B02A] hover:bg-[#F8FCF6]",
      )}
    >
      {children}
    </button>
  );
}

export function Panel({ children }) {
  return <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">{children}</div>;
}

export function PanelHeader({ icon: Icon, title, onBack }) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex h-7 items-center gap-1 rounded-full px-1.5 text-12 text-zinc-600 hover:bg-zinc-100 lg:hidden u-focus-ring"
      >
        <ArrowLeft size={15} strokeWidth={2} /> Back
      </button>
      <Icon size={15} strokeWidth={2} className="text-[#2E7D20]" />
      <span className="text-12 uppercase tracking-label text-zinc-500">{title}</span>
    </div>
  );
}

export function Empty({ children }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-14 text-zinc-400">{children}</div>
  );
}

export function Tag({ tone = "neutral", lifecycle = false, className, children }) {
  const cls = {
    neutral: "bg-zinc-100 text-zinc-600",
    green: "bg-[#EAF5E4] text-[#2E7D20]",
    forest: "bg-[#143D2A] text-white",
    alert: "bg-[#FEECEB] text-[#B42318]",
  }[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-medium",
        lifecycle ? "text-14" : "text-11",
        cls,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ActionBtn({ variant = "green", size = "md", disabled, onClick, children }) {
  const tone = {
    green: "bg-[#43B02A] text-white hover:bg-[#3A9A24] border-transparent",
    secondary: "bg-white text-zinc-800 border-zinc-300 hover:bg-zinc-50",
    danger: "bg-white text-[#B42318] border-[#F1C7C2] hover:bg-[#FEF3F2]",
  }[variant];
  const sizing = size === "sm" ? "h-9 px-3.5 text-12" : "h-11 px-4 text-13 sm:h-10";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 u-focus-ring",
        sizing,
        tone,
      )}
    >
      {children}
    </button>
  );
}

export function Field({ label, value }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-2 text-14">
      <span className="text-zinc-400">{label}</span>
      <span className="break-words text-zinc-900">{value}</span>
    </div>
  );
}

export function Section({ icon: Icon, ok, title, children }) {
  return (
    <div className="border-t border-zinc-200 pt-4">
      <div className="mb-2 flex items-center gap-2">
        {Icon && (
          <Icon
            size={15}
            strokeWidth={2}
            className={ok === undefined ? "text-zinc-500" : ok ? "text-[#2E7D20]" : "text-[#B42318]"}
          />
        )}
        <span className="text-12 uppercase tracking-label text-zinc-500">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function ExternalAnchor({ href, label }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex w-fit items-center gap-1.5 text-13 font-medium text-[#2E7D20] hover:underline"
    >
      <ExternalLink size={14} strokeWidth={2} />
      {label}
    </a>
  );
}

export function LinkContext({ title, value }) {
  if (!value) return null;
  return (
    <Section title={title}>
      <div className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-md bg-[#FAF7EF] p-3 text-13 leading-relaxed text-zinc-600">
        {value}
      </div>
    </Section>
  );
}

export function scorePercent(value) {
  if (value == null) return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${Math.round(n * 100)}% relevance`;
}

export function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "—";
}

export function DecisionButtons({ actions, allowed, pending, disabled = false, onDecision }) {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map(({ decision, label, icon: Icon, variant }) => (
        <ActionBtn
          key={decision}
          variant={variant}
          disabled={disabled || !!pending || !allowed[`can_${decision}`]}
          onClick={() => onDecision(decision)}
        >
          <Icon size={15} strokeWidth={2} />
          {pending === decision ? "Working…" : label}
        </ActionBtn>
      ))}
    </div>
  );
}
