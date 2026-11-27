// Shared one-tap churn taxonomy picker for admin stage→churned flows
// (Customer 360 edit modal + Customers directory inline editor).
// Keeps every manual churn out of the "unclassified" bucket on the dashboard
// Churn Reasons Pareto card. Codes mirror customers_churn_reason_code_check
// minus 'unclassified'.
import { Select, cn } from "../ui";

export const CHURN_REASON_OPTIONS = [
  { code: "price", label: "Price" },
  { code: "results", label: "Results" },
  { code: "service_quality", label: "Service quality" },
  { code: "moving", label: "Moving" },
  { code: "seasonal_pause", label: "Seasonal / away" },
  { code: "competitor", label: "Competitor" },
  { code: "financial", label: "Financial" },
  { code: "no_longer_needed", label: "No longer needed" },
  { code: "other", label: "Other" },
];

const QUICK_CODES = ["price", "results", "moving", "service_quality", "seasonal_pause", "competitor"];

export function isChurnReasonMissing(stage, initialStage, value) {
  return stage === "churned" && initialStage !== "churned" && !value;
}

export function EditChurnReasonField({
  id = "churn-reason-code",
  stage,
  initialStage,
  value = "",
  onChange,
  disabled = false,
}) {
  if (stage !== "churned") return null;
  return (
    <ChurnReasonPicker
      id={id}
      value={value}
      onChange={onChange}
      required={initialStage !== "churned"}
      disabled={disabled}
    />
  );
}

export default function ChurnReasonPicker({
  id = "churn-reason-code",
  value = "",
  onChange,
  required = false,
  disabled = false,
}) {
  const missing = required && !value;
  return (
    <div className="col-span-full flex flex-col gap-2 pt-1">
      <label htmlFor={id} className="ui-label text-ink-secondary block">
        Churn reason {required ? "(required)" : "(optional)"}
      </label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common churn reasons">
        {QUICK_CODES.map((code) => {
          const opt = CHURN_REASON_OPTIONS.find((o) => o.code === code);
          const selected = value === code;
          return (
            <button
              key={code}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChange(code)}
              className={cn(
                "min-h-8 px-2.5 py-1 rounded-sm border-hairline text-14 transition-colors u-focus-ring disabled:opacity-50",
                selected
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-800 border-zinc-300 hover:bg-zinc-50",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <Select
        id={id}
        aria-label="Churn reason"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full h-9 px-2 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
      >
        <option value="">Select a churn reason…</option>
        {CHURN_REASON_OPTIONS.map((o) => (
          <option key={o.code} value={o.code}>{o.label}</option>
        ))}
      </Select>
      {missing && (
        <div className="text-14 text-alert-fg">
          Pick a churn reason before saving as Churned.
        </div>
      )}
    </div>
  );
}
