export const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
// STATUS_COLORS / TYPE_COLORS / DOC_CAT_COLORS pulled out of palette into
// explicit hex maps so completed/exported, shift/drive, and sop/offer_letter
// stay visually distinct (would all collapse to zinc-900 under naive fold).
export const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  purple: "#18181B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  input: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
export const MONO = "'JetBrains Mono', monospace";
export const LABOR_RATE = 35;

// Paid minutes are shift minutes less the day's stored unpaid meal. Waves takes
// no unpaid lunch (owner 2026-11-22), so the stored meal is 0 and every figure
// equals the shift figure; a row without the field (restricted viewer
// projection) has none either.
export const unpaidMinutesOf = (d) =>
  Math.min(
    parseFloat(d.total_shift_minutes || 0),
    parseFloat(d.unpaid_meal_minutes || 0),
  );
export const paidMinutesOf = (d) =>
  Math.max(0, parseFloat(d.total_shift_minutes || 0) - unpaidMinutesOf(d));

export function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
    body: opts.body
      ? typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body)
      : undefined,
  }).then(async (r) => {
    if (!r.ok) {
      // The message stays "HTTP <status>"; the status and the server's JSON
      // body ride along for callers that show the server's own reason.
      const error = new Error(`HTTP ${r.status}`);
      error.status = r.status;
      try {
        error.data = typeof r.json === "function" ? await r.json() : null;
      } catch {
        error.data = null;
      }
      throw error;
    }
    return r.json();
  });
}

export const sCard = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 6,
  padding: 16,
  marginBottom: 12,
  boxShadow: "none",
};
export const sBtn = (bg, color) => ({
  minHeight: 44,
  padding: "0 16px",
  background: bg,
  color,
  border: `1px solid ${bg === "transparent" ? D.border : bg}`,
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1.3,
});
export const sBadge = (bg, color) => ({
  fontSize: 14,
  lineHeight: 1.35,
  padding: "3px 8px",
  borderRadius: 4,
  background: bg,
  color,
  fontWeight: 500,
  display: "inline-block",
});
export const sInput = {
  width: "100%",
  minHeight: 44,
  padding: "0 12px",
  background: D.input,
  border: `1px solid ${D.border}`,
  borderRadius: 4,
  color: D.text,
  fontSize: 16,
  outline: "none",
  boxSizing: "border-box",
};
export const fmt = (n) =>
  n != null
    ? "$" +
      Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "--";
export const fmtHrs = (min) =>
  min != null ? (parseFloat(min) / 60).toFixed(1) + "h" : "--";
export const fmtPct = (p) => (p != null ? parseFloat(p).toFixed(1) + "%" : "--");
export const errMessage = (e, fallback = "Request failed") =>
  (e && e.data && e.data.error) || (e && e.message) || fallback;
export const isErrorToastText = (msg) =>
  /^(failed|error|could not|upload failed|download failed|restore failed|approve failed|bulk approve failed|unlock failed|dispute failed|confirm failed|export failed|load failed|detail load failed|earnings failed|photo upload failed|saved, but not|approved payroll export failed)/i.test(
    String(msg || "").trim(),
  );
export const effectivePayRate = (tech) =>
  tech && tech.pay_rate != null && tech.pay_rate !== "" && Number.isFinite(Number(tech.pay_rate))
    ? Number(tech.pay_rate)
    : LABOR_RATE;
export const ymdOnly = (v) => (v == null ? "" : String(v).slice(0, 10));

export const STATUS_COLORS = {
  active: "#15803D", // green-700
  completed: "#3F3F46", // zinc-700 — distinct from exported
  edited: "#A16207", // amber-700
  voided: "#991B1B", // alert-fg red
  pending: "#A16207", // amber (mirrors edited = needs attention)
  approved: "#15803D", // green (mirrors active = good state)
  disputed: "#991B1B", // red (mirrors voided = bad state)
  rejected: "#991B1B", // red
  exported: "#52525B", // zinc-600 — distinct from completed
};
export const TYPE_COLORS = {
  shift: "#3F3F46", // zinc-700
  job: "#15803D", // green
  break: "#A16207", // amber
  drive: "#18181B", // zinc-900 — distinct from shift
  admin_time: "#71717A", // zinc-500
};

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const thStyle = {
  padding: "8px 6px",
  textAlign: "left",
  color: D.muted,
  fontSize: 14,
  fontWeight: 500,
  borderBottom: `1px solid ${D.border}`,
};
export const tdStyle = { padding: "8px 6px", color: D.text, fontSize: 14 };
// A timesheet day cell's button: fills the cell and looks like the cell text.
export const dayCellButton = {
  width: "100%",
  padding: 0,
  background: "transparent",
  border: "none",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

// The signed-in staff profile AdminLayoutV2 stores at login; role decides
// which roster actions render (the server enforces it regardless).
export function readStaffProfile() {
  try {
    return JSON.parse(localStorage.getItem("waves_admin_user") || "{}") || {};
  } catch {
    return {};
  }
}

export function readStaffRole() {
  return readStaffProfile().role || null;
}

export function MiniStat({ label, value }) {
  return (
    <div style={{ textAlign: "center" }}>
      {" "}
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: D.heading,
          fontFamily: MONO,
        }}
      >
        {value}
      </div>{" "}
      <div style={{ fontSize: 14, color: D.muted }}>{label}</div>{" "}
    </div>
  );
}

export function StatCard({ label, value, color }) {
  return (
    <div
      style={{
        ...sCard,
        textAlign: "center",
        borderLeft: `3px solid ${color}`,
      }}
    >
      {" "}
      <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: MONO }}>
        {value}
      </div>{" "}
      <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
        {label}
      </div>{" "}
    </div>
  );
}

// A read that failed, said plainly with a Retry that reads it again, so a
// failure never looks like an empty list.
export function LoadFailedNotice({ children, onRetry }) {
  return (
    <div
      role="alert"
      style={{
        ...sCard,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        color: D.red,
        fontSize: 14,
      }}
    >
      <span style={{ flex: 1, minWidth: 200 }}>{children}</span>
      <button type="button" onClick={onRetry} style={sBtn(D.card, D.text)}>
        Retry
      </button>
    </div>
  );
}

export function UtilRing({ pct, size = 32 }) {
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  const filled = circ * (pct / 100);
  const color = pct >= 70 ? D.green : pct >= 50 ? D.amber : D.red;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {" "}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={D.border}
        strokeWidth={3}
      />{" "}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeDasharray={`${filled} ${circ - filled}`}
        strokeDashoffset={circ / 4}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.5s" }}
      />{" "}
    </svg>
  );
}
