import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import {
  CheckCircle2,
  Clock3,
  Download,
  Landmark,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { etDateString, formatETDate, formatETDateOnly } from "../../lib/timezone";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import useIsMobile from "../../hooks/useIsMobile";

const API = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
const D = {
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
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      let detail = "";
      try {
        const body = await r.json();
        if (body?.error) detail = String(body.error);
      } catch {
        /* response body was not JSON — fall through to HTTP status */
      }
      throw new Error(detail || `HTTP ${r.status}`);
    }
    return r.json();
  });
}

function adminFetchRaw(path) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
    },
  });
}

const fmtM = (n) =>
  n != null
    ? "$" +
      Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "$0.00";
// Real instants (created_at_stripe, reconciled_at) render as their ET
// calendar day; bare new Date(d).toLocaleDateString() showed them (and the
// midnight-UTC Stripe arrival dates) one day early for an ET viewer.
const fmtD = (d) => (d ? formatETDate(d) : "--");
// Calendar-day values (Stripe arrival_date is midnight UTC "the day it
// arrives") keep their day via the noon-UTC anchor.
const fmtDay = (d) => (d ? formatETDateOnly(d) : "--");

const STATUS_COLORS = {
  paid: D.green,
  pending: D.amber,
  in_transit: "#0A7EC2",
  failed: D.red,
  // Money clawed back or a payout that never happened is a genuine alert —
  // these previously fell through to a calm neutral gray.
  canceled: D.red,
  reversed: D.red,
};
const INSTANT_PAYOUT_FEE_RATE = 0.015;

function newPayoutIdempotencyKey(method = "standard") {
  const prefix = method === "instant" ? "ipo" : "spo";
  return globalThis.crypto?.randomUUID
    ? `${prefix}_${globalThis.crypto.randomUUID()}`
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function payoutLimitForMethod(method, available, instantAvailable) {
  const standardLimit = Math.max(0, Number(available || 0));
  if (method === "instant") {
    return Math.max(0, Number(instantAvailable || 0));
  }
  return standardLimit;
}

function payoutAmountInput(limit) {
  const normalized = Number(limit || 0);
  return normalized > 0 ? normalized.toFixed(2) : "";
}

function Badge({ children, color }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 600,
        background: `${color || D.muted}22`,
        color: color || D.muted,
        textTransform: "capitalize",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </span>
  );
}

const inputStyle = {
  background: "#FFFFFF",
  border: `1px solid ${D.inputBorder}`,
  borderRadius: 6,
  padding: "8px 12px",
  color: D.text,
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};
const thStyle = {
  fontSize: 10,
  color: D.muted,
  textTransform: "uppercase",
  letterSpacing: 1,
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: `1px solid ${D.border}`,
};
const tdStyle = {
  padding: "10px",
  borderBottom: `1px solid ${D.border}22`,
  fontSize: 13,
  color: D.text,
};
const BANKING_SECTIONS = [
  { key: "payouts", label: "Payouts", Icon: Wallet },
  { key: "cashflow", label: "Cash Flow", Icon: TrendingUp },
  { key: "reconciliation", label: "Reconciliation", Icon: CheckCircle2 },
  { key: "exports", label: "Exports", Icon: Download },
];

// ═══════════════════════════════════════════════════════════════
// PAYOUTS TAB
// ═══════════════════════════════════════════════════════════════
function PayoutsTab() {
  const [payouts, setPayouts] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [txns, setTxns] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  // reqId guard (same pattern as CashFlowTab): rapid Next/Previous clicks
  // must not let a slower OLDER request — success or failure — clobber the
  // newer page's rows or paint its error.
  const reqIdRef = useRef(0);

  const load = useCallback(async (p) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const d = await adminFetch(`/admin/banking/payouts?limit=20&page=${p}`);
      if (reqId !== reqIdRef.current) return;
      setPayouts(d.payouts || []);
      setLoadError(null);
      // Use the authoritative `pages` field from the backend instead of guessing
      // from page length (a short first page would otherwise disable Next).
      setHasMore(
        typeof d.pages === "number"
          ? p < d.pages
          : (d.payouts || []).length === 20,
      );
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      // Distinguish "load failed" from "no payouts" — the old no-op catch
      // rendered a silently empty table.
      setPayouts([]);
      setLoadError(e.message || "Failed to load");
    }
    if (reqId === reqIdRef.current) setLoading(false);
  }, []);

  useEffect(() => {
    load(page);
  }, [page, load]);

  const toggleExpand = async (payoutId) => {
    if (expanded === payoutId) {
      setExpanded(null);
      return;
    }
    setExpanded(payoutId);
    if (!txns[payoutId]) {
      try {
        const d = await adminFetch(`/admin/banking/payouts/${payoutId}`);
        setTxns((prev) => ({ ...prev, [payoutId]: d.transactions || [] }));
      } catch (e) {
        setTxns((prev) => ({ ...prev, [payoutId]: [] }));
      }
    }
  };

  return (
    <div>
      {!loading && loadError && (
        <div
          style={{
            background: `${D.red}11`,
            border: `1px solid ${D.red}`,
            borderRadius: 8,
            padding: "14px 16px",
            marginBottom: 12,
            color: D.red,
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>Couldn't load payouts ({loadError}).</span>
          <button
            onClick={() => load(page)}
            style={{
              background: "transparent",
              border: `1px solid ${D.red}`,
              borderRadius: 6,
              padding: "6px 14px",
              color: D.red,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Date</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
              <th style={thStyle}>Status</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Transactions</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Fees</th>
              <th style={thStyle}>Arrival</th>
              <th style={thStyle}>Reconciled</th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <Fragment key={p.id}>
                <tr
                  onClick={() => toggleExpand(p.id)}
                  style={{
                    cursor: "pointer",
                    background: expanded === p.id ? D.bg : "transparent",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (expanded !== p.id)
                      e.currentTarget.style.background = `${D.card}88`;
                  }}
                  onMouseLeave={(e) => {
                    if (expanded !== p.id)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  <td style={tdStyle}>
                    {fmtD(
                      p.created_at_stripe ||
                        p.created_at ||
                        p.date ||
                        p.created,
                    )}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      fontFamily: MONO,
                      fontWeight: 700,
                    }}
                  >
                    {fmtM(p.amount)}
                  </td>
                  <td style={tdStyle}>
                    <Badge color={STATUS_COLORS[p.status] || D.muted}>
                      {p.status}
                    </Badge>
                  </td>
                  <td
                    style={{ ...tdStyle, textAlign: "right", fontFamily: MONO }}
                  >
                    {p.transaction_count ?? "--"}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      fontFamily: MONO,
                      color: D.muted,
                    }}
                  >
                    {p.fee_total != null
                      ? fmtM(p.fee_total)
                      : p.fees != null
                      ? fmtM(p.fees)
                      : "--"}
                  </td>
                  <td style={tdStyle}>{fmtDay(p.arrival_date)}</td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    {p.reconciled ? (
                      <span style={{ color: D.green, fontSize: 16 }}>
                        &#10003;
                      </span>
                    ) : (
                      <span style={{ color: D.muted }}>--</span>
                    )}
                  </td>
                </tr>
                {expanded === p.id && (
                  <tr key={`${p.id}-detail`}>
                    <td colSpan={7} style={{ padding: 0, background: D.bg }}>
                      <div style={{ padding: "12px 20px" }}>
                        {!txns[p.id] ? (
                          <div style={{ color: D.muted, fontSize: 12 }}>
                            Loading transactions...
                          </div>
                        ) : txns[p.id].length === 0 ? (
                          <div style={{ color: D.muted, fontSize: 12 }}>
                            No transaction details available
                          </div>
                        ) : (
                          <table
                            style={{
                              width: "100%",
                              borderCollapse: "collapse",
                            }}
                          >
                            <thead>
                              <tr>
                                <th style={{ ...thStyle, fontSize: 9 }}>
                                  Customer / Type
                                </th>
                                <th style={{ ...thStyle, fontSize: 9 }}>
                                  Description
                                </th>
                                <th
                                  style={{
                                    ...thStyle,
                                    fontSize: 9,
                                    textAlign: "right",
                                  }}
                                >
                                  Amount
                                </th>
                                <th
                                  style={{
                                    ...thStyle,
                                    fontSize: 9,
                                    textAlign: "right",
                                  }}
                                >
                                  Fee
                                </th>
                                <th
                                  style={{
                                    ...thStyle,
                                    fontSize: 9,
                                    textAlign: "right",
                                  }}
                                >
                                  Net
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {txns[p.id].map((t, i) => {
                                const isFee =
                                  t.type === "stripe_fee" || t.type === "fee";
                                return (
                                  <tr
                                    key={i}
                                    style={{ opacity: isFee ? 0.5 : 1 }}
                                  >
                                    <td
                                      style={{
                                        ...tdStyle,
                                        fontSize: 12,
                                        color: isFee ? D.muted : D.text,
                                      }}
                                    >
                                      {t.customer_name || t.type || "--"}
                                    </td>
                                    <td
                                      style={{
                                        ...tdStyle,
                                        fontSize: 12,
                                        color: D.muted,
                                      }}
                                    >
                                      {t.description || "--"}
                                    </td>
                                    <td
                                      style={{
                                        ...tdStyle,
                                        fontSize: 12,
                                        textAlign: "right",
                                        fontFamily: MONO,
                                      }}
                                    >
                                      {fmtM(t.amount)}
                                    </td>
                                    <td
                                      style={{
                                        ...tdStyle,
                                        fontSize: 12,
                                        textAlign: "right",
                                        fontFamily: MONO,
                                        color: D.muted,
                                      }}
                                    >
                                      {t.fee != null ? fmtM(t.fee) : "--"}
                                    </td>
                                    <td
                                      style={{
                                        ...tdStyle,
                                        fontSize: 12,
                                        textAlign: "right",
                                        fontFamily: MONO,
                                        fontWeight: 600,
                                      }}
                                    >
                                      {t.net != null ? fmtM(t.net) : "--"}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>{" "}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {loading && (
        <div
          style={{
            textAlign: "center",
            color: D.muted,
            fontSize: 12,
            padding: 16,
          }}
        >
          Loading...
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 8,
          marginTop: 16,
        }}
      >
        <button
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
          style={{
            ...inputStyle,
            cursor: page <= 1 ? "not-allowed" : "pointer",
            opacity: page <= 1 ? 0.4 : 1,
          }}
        >
          Previous
        </button>{" "}
        <span
          style={{
            color: D.muted,
            fontSize: 12,
            alignSelf: "center",
            fontFamily: MONO,
          }}
        >
          Page {page}
        </span>{" "}
        <button
          disabled={!hasMore}
          onClick={() => setPage((p) => p + 1)}
          style={{
            ...inputStyle,
            cursor: !hasMore ? "not-allowed" : "pointer",
            opacity: !hasMore ? 0.4 : 1,
          }}
        >
          Next
        </button>{" "}
      </div>{" "}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CASH FLOW TAB
// ═══════════════════════════════════════════════════════════════
function CashFlowTab() {
  const isMobile = useIsMobile(640);
  const [period, setPeriod] = useState("weekly");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const reqIdRef = useRef(0);

  const today = new Date();
  const threeMonthsAgo = new Date(today);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const [startDate, setStartDate] = useState(etDateString(threeMonthsAgo));
  const [endDate, setEndDate] = useState(etDateString(today));

  const load = useCallback(async () => {
    // reqId: a slower earlier range/period response must not overwrite the
    // newer selection (#2913 pattern, previously only on the balance hero).
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const d = await adminFetch(
        `/admin/banking/cash-flow?start_date=${startDate}&end_date=${endDate}&period=${period}`,
      );
      if (reqId !== reqIdRef.current) return;
      setData(d);
      setLoadError(null);
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      // Clear stale data and surface the failure — the old no-op catch left
      // this tab rendering confident "$0.00" cards (or the PREVIOUS range's
      // numbers mislabeled as the new range) on a failed fetch.
      setData(null);
      setLoadError(e.message || "Failed to load cash flow");
    }
    if (reqId === reqIdRef.current) setLoading(false);
  }, [startDate, endDate, period]);

  useEffect(() => {
    load();
  }, [load]);

  const chartData = data?.periods || [];
  const summary = data?.summary || {};
  const totalIn = summary.total_in ?? summary.total_revenue ?? 0;
  const totalOut =
    summary.total_out ??
    (summary.total_expenses || 0) + (summary.stripe_fees || 0);
  const net =
    summary.net ?? summary.operating_cash_flow ?? summary.net_cash_flow ?? 0;

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          {["weekly", "monthly"].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                background: period === p ? D.teal : "transparent",
                border: `1px solid ${period === p ? D.teal : D.border}`,
                borderRadius: 6,
                padding: "6px 14px",
                color: period === p ? D.white : D.muted,
                fontSize: 12,
                cursor: "pointer",
                fontWeight: period === p ? 600 : 400,
                textTransform: "capitalize",
              }}
            >
              {p}
            </button>
          ))}
        </div>{" "}
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          style={{ ...inputStyle, width: 140 }}
        />{" "}
        <span style={{ color: D.muted, fontSize: 12 }}>to</span>{" "}
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          style={{ ...inputStyle, width: 140 }}
        />{" "}
      </div>
      {loading && (
        <div
          style={{
            color: D.muted,
            fontSize: 12,
            padding: 16,
            textAlign: "center",
          }}
        >
          Loading cash flow data...
        </div>
      )}
      {!loading && chartData.length > 0 && (
        <div
          style={{
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 12,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={chartData}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={D.border} />{" "}
              <XAxis
                dataKey="label"
                tick={{ fill: D.muted, fontSize: 11 }}
                axisLine={{ stroke: D.border }}
              />{" "}
              <YAxis
                tick={{ fill: D.muted, fontSize: 11, fontFamily: MONO }}
                axisLine={{ stroke: D.border }}
                tickFormatter={(v) => "$" + (v / 1000).toFixed(0) + "k"}
              />{" "}
              <Tooltip content={<CashFlowTooltip />} />{" "}
              <Legend wrapperStyle={{ fontSize: 11, color: D.muted }} />{" "}
              <Bar
                dataKey="money_in"
                name="Money In"
                fill={D.green}
                radius={[4, 4, 0, 0]}
              />{" "}
              <Bar
                dataKey="money_out"
                name="Money Out"
                fill={D.red}
                radius={[4, 4, 0, 0]}
              />{" "}
            </BarChart>{" "}
          </ResponsiveContainer>{" "}
        </div>
      )}
      {!loading && loadError && (
        <div
          style={{
            background: `${D.red}11`,
            border: `1px solid ${D.red}`,
            borderRadius: 8,
            padding: "14px 16px",
            color: D.red,
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>
            Couldn't load cash flow ({loadError}). Figures are unavailable —
            not zero.
          </span>
          <button
            onClick={load}
            style={{
              background: "transparent",
              border: `1px solid ${D.red}`,
              borderRadius: 6,
              padding: "6px 14px",
              color: D.red,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      )}
      {!loading && !loadError && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)",
            gap: 10,
          }}
        >
          <SummaryCard
            label="Revenue In"
            value={data ? fmtM(totalIn) : "—"}
            color={D.green}
          />{" "}
          <SummaryCard
            label="Expenses + Fees"
            value={data ? fmtM(totalOut) : "—"}
            color={D.red}
          />{" "}
          <SummaryCard
            label="Operating Net"
            value={data ? fmtM(net) : "—"}
            color={net >= 0 ? D.green : D.red}
          />{" "}
          <SummaryCard
            label="Stripe Fees"
            value={data ? fmtM(summary.stripe_fees) : "—"}
            color={D.amber}
          />{" "}
        </div>
      )}
    </div>
  );
}

function CashFlowTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 13,
      }}
    >
      <div style={{ color: D.muted, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontFamily: MONO }}>
          {fmtM(p.value)} {p.name}
        </div>
      ))}
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  const isMobile = useIsMobile(640);
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: isMobile ? "12px 10px" : "16px 20px",
      }}
    >
      <div
        style={{
          color: D.muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 6,
        }}
      >
        {label}
      </div>{" "}
      <div
        style={{
          fontFamily: MONO,
          fontSize: 22,
          fontWeight: 700,
          color: color || D.heading,
        }}
      >
        {value}
      </div>{" "}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// RECONCILIATION TAB
// ═══════════════════════════════════════════════════════════════
function ReconciliationTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [actuals, setActuals] = useState({});
  const [notes, setNotes] = useState({});
  const [reconciling, setReconciling] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await adminFetch("/admin/banking/reconciliation");
      setItems(Array.isArray(d) ? d : d.payouts || []);
      setLoadError(null);
    } catch (e) {
      // A failed load must be distinguishable from "nothing outstanding" —
      // the old no-op catch rendered the reassuring "No payouts to
      // reconcile" empty state, hiding unreconciled payouts.
      setItems([]);
      setLoadError(e.message || "Failed to load");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleReconcile = async (payoutId) => {
    const actual = actuals[payoutId];
    if (actual == null || actual === "") return;
    setReconciling(payoutId);
    try {
      await adminFetch(`/admin/banking/reconciliation/${payoutId}`, {
        method: "POST",
        body: JSON.stringify({
          actual_amount: parseFloat(actual),
          notes: notes[payoutId] || "",
        }),
      });
      await load();
    } catch (e) {
      alert("Reconciliation failed: " + e.message);
    }
    setReconciling(null);
  };

  return (
    <div>
      {loading && (
        <div
          style={{
            color: D.muted,
            fontSize: 12,
            padding: 16,
            textAlign: "center",
          }}
        >
          Loading reconciliation data...
        </div>
      )}

      {!loading && loadError && (
        <div
          style={{
            background: `${D.red}11`,
            border: `1px solid ${D.red}`,
            borderRadius: 8,
            padding: "14px 16px",
            color: D.red,
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>
            Couldn't load reconciliation ({loadError}) — outstanding payouts
            may be hidden.
          </span>
          <button
            onClick={load}
            style={{
              background: "transparent",
              border: `1px solid ${D.red}`,
              borderRadius: 6,
              padding: "6px 14px",
              color: D.red,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !loadError && items.length === 0 && (
        <div
          style={{
            color: D.muted,
            fontSize: 13,
            padding: 20,
            textAlign: "center",
          }}
        >
          No payouts to reconcile
        </div>
      )}

      {items.map((item) => {
        const discrepancy =
          actuals[item.id] != null && actuals[item.id] !== ""
            ? (
                parseFloat(actuals[item.id]) -
                (item.expected_amount || item.amount)
              ).toFixed(2)
            : null;
        return (
          <div
            key={item.id}
            style={{
              background: D.card,
              border: `1px solid ${item.reconciled ? D.green + "44" : D.border}`,
              borderRadius: 10,
              padding: "14px 18px",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 150 }}>
                <div
                  style={{ fontSize: 13, fontWeight: 600, color: D.heading }}
                >
                  {fmtD(item.date || item.created)}
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                  Expected:{" "}
                  <span style={{ fontFamily: MONO, color: D.text }}>
                    {fmtM(item.expected_amount || item.amount)}
                  </span>
                </div>{" "}
              </div>
              {item.reconciled ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: D.green, fontSize: 16 }}>
                    &#10003;
                  </span>{" "}
                  <div style={{ fontSize: 11, color: D.muted }}>
                    <div>
                      Actual:{" "}
                      <span style={{ fontFamily: MONO, color: D.green }}>
                        {fmtM(item.actual_amount)}
                      </span>
                    </div>{" "}
                    <div>
                      {fmtD(item.reconciled_at)} by{" "}
                      {item.reconciled_by || "admin"}
                    </div>{" "}
                  </div>{" "}
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div
                      style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}
                    >
                      Actual Amount
                    </div>{" "}
                    <input
                      type="number"
                      step="0.01"
                      placeholder={String(
                        item.expected_amount || item.amount || "",
                      )}
                      value={actuals[item.id] || ""}
                      onChange={(e) =>
                        setActuals((prev) => ({
                          ...prev,
                          [item.id]: e.target.value,
                        }))
                      }
                      style={{ ...inputStyle, width: 120, fontFamily: MONO }}
                    />{" "}
                  </div>
                  {discrepancy != null && parseFloat(discrepancy) !== 0 && (
                    <div
                      style={{
                        fontSize: 11,
                        fontFamily: MONO,
                        color: parseFloat(discrepancy) > 0 ? D.green : D.red,
                        alignSelf: "flex-end",
                        padding: "8px 0",
                      }}
                    >
                      {parseFloat(discrepancy) > 0 ? "+" : ""}
                      {fmtM(parseFloat(discrepancy))}
                    </div>
                  )}
                  <div>
                    <div
                      style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}
                    >
                      Notes
                    </div>{" "}
                    <input
                      value={notes[item.id] || ""}
                      onChange={(e) =>
                        setNotes((prev) => ({
                          ...prev,
                          [item.id]: e.target.value,
                        }))
                      }
                      placeholder="Optional notes"
                      style={{ ...inputStyle, width: 160 }}
                    />{" "}
                  </div>{" "}
                  <button
                    onClick={() => handleReconcile(item.id)}
                    disabled={reconciling === item.id || !actuals[item.id]}
                    style={{
                      background: D.green,
                      border: "none",
                      borderRadius: 6,
                      padding: "8px 14px",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor:
                        reconciling === item.id || !actuals[item.id]
                          ? "not-allowed"
                          : "pointer",
                      opacity:
                        reconciling === item.id || !actuals[item.id] ? 0.5 : 1,
                      alignSelf: "flex-end",
                    }}
                  >
                    {reconciling === item.id ? "Saving..." : "Reconcile"}
                  </button>{" "}
                </div>
              )}
            </div>{" "}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS TAB
// ═══════════════════════════════════════════════════════════════
function ExportsTab() {
  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const [startDate, setStartDate] = useState(etDateString(startOfMonth));
  const [endDate, setEndDate] = useState(etDateString(today));
  const [format, setFormat] = useState("csv");
  const [preview, setPreview] = useState([]);
  const [downloading, setDownloading] = useState(false);

  const applyPreset = (preset) => {
    const now = new Date();
    let s, e;
    switch (preset) {
      case "this_month":
        s = new Date(now.getFullYear(), now.getMonth(), 1);
        e = now;
        break;
      case "last_month":
        s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        e = new Date(now.getFullYear(), now.getMonth(), 0);
        break;
      case "this_quarter": {
        const q = Math.floor(now.getMonth() / 3) * 3;
        s = new Date(now.getFullYear(), q, 1);
        e = now;
        break;
      }
      case "ytd":
        s = new Date(now.getFullYear(), 0, 1);
        e = now;
        break;
      default:
        return;
    }
    setStartDate(etDateString(s));
    setEndDate(etDateString(e));
  };

  useEffect(() => {
    adminFetch(
      `/admin/banking/payouts?limit=5&page=1&start_date=${startDate}&end_date=${endDate}`,
    )
      .then((d) => setPreview(d.payouts || []))
      .catch(() => setPreview([]));
  }, [startDate, endDate]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const resp = await adminFetchRaw(
        `/admin/banking/export?format=${format}&start_date=${startDate}&end_date=${endDate}`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `waves-banking-${startDate}-to-${endDate}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Download failed: " + e.message);
    }
    setDownloading(false);
  };

  return (
    <div>
      <div
        style={{
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 12,
          padding: 20,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 14,
          }}
        >
          Export Settings
        </div>
        {/* Date range */}
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 14,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>
              Start Date
            </div>{" "}
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{ ...inputStyle, width: 150 }}
            />{" "}
          </div>{" "}
          <div>
            <div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>
              End Date
            </div>{" "}
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{ ...inputStyle, width: 150 }}
            />{" "}
          </div>{" "}
        </div>
        {/* Presets */}
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          {[
            { key: "this_month", label: "This Month" },
            { key: "last_month", label: "Last Month" },
            { key: "this_quarter", label: "This Quarter" },
            { key: "ytd", label: "YTD" },
          ].map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              style={{
                background: "transparent",
                border: `1px solid ${D.border}`,
                borderRadius: 6,
                padding: "6px 12px",
                color: D.muted,
                fontSize: 11,
                cursor: "pointer",
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = D.teal;
                e.currentTarget.style.color = D.text;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = D.border;
                e.currentTarget.style.color = D.muted;
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {/* Format */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 10,
              color: D.muted,
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            Format
          </div>{" "}
          <div style={{ display: "flex", gap: 4 }}>
            {["csv", "ofx"].map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                style={{
                  background: format === f ? D.teal : "transparent",
                  border: `1px solid ${format === f ? D.teal : D.border}`,
                  borderRadius: 6,
                  padding: "6px 16px",
                  color: format === f ? D.white : D.muted,
                  fontSize: 12,
                  fontWeight: format === f ? 600 : 400,
                  cursor: "pointer",
                  textTransform: "uppercase",
                }}
              >
                {f}
              </button>
            ))}
          </div>{" "}
        </div>{" "}
        <button
          onClick={handleDownload}
          disabled={downloading}
          style={{
            background: D.teal,
            border: "none",
            borderRadius: 8,
            padding: "10px 24px",
            color: "#fff",
            fontSize: 14,
            fontWeight: 700,
            cursor: downloading ? "not-allowed" : "pointer",
            opacity: downloading ? 0.6 : 1,
          }}
        >
          {downloading ? "Generating..." : "Generate & Download"}
        </button>{" "}
      </div>
      {/* Preview */}
      {preview.length > 0 && (
        <div
          style={{
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 10,
            }}
          >
            Preview (first 5 payouts in range)
          </div>{" "}
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Date</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Arrival</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((p, i) => (
                <tr key={i}>
                  <td style={tdStyle}>
                    {fmtD(
                      p.created_at_stripe ||
                        p.created_at ||
                        p.date ||
                        p.created,
                    )}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      fontFamily: MONO,
                      fontWeight: 600,
                    }}
                  >
                    {fmtM(p.amount)}
                  </td>
                  <td style={tdStyle}>
                    <Badge color={STATUS_COLORS[p.status] || D.muted}>
                      {p.status}
                    </Badge>
                  </td>
                  <td style={tdStyle}>{fmtDay(p.arrival_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PAYOUT MODAL
// ═══════════════════════════════════════════════════════════════
function PayoutModal({
  available,
  instantAvailable,
  initialMethod = "standard",
  onClose,
  onSuccess,
}) {
  const [method, setMethod] = useState(initialMethod);
  const [amount, setAmount] = useState(() =>
    payoutAmountInput(
      payoutLimitForMethod(initialMethod, available, instantAvailable),
    ),
  );
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    newPayoutIdempotencyKey(initialMethod),
  );
  const [submitting, setSubmitting] = useState(false);

  const parsedAmount = parseFloat(amount) || 0;
  const isInstant = method === "instant";
  const fee = isInstant ? parsedAmount * INSTANT_PAYOUT_FEE_RATE : 0;
  const net = parsedAmount - fee;
  const methodLimit = payoutLimitForMethod(method, available, instantAvailable);
  const isOverLimit = parsedAmount > methodLimit;
  const canSubmit = !submitting && parsedAmount > 0 && methodLimit > 0 && !isOverLimit;
  const submitLabel = submitting
    ? "Processing..."
    : isInstant && methodLimit <= 0
      ? "Instant Unavailable"
      : `Confirm ${isInstant ? "Instant" : "Standard"}`;

  const selectMethod = (nextMethod) => {
    const nextLimit = payoutLimitForMethod(nextMethod, available, instantAvailable);
    setMethod(nextMethod);
    setAmount((currentAmount) => {
      const current = parseFloat(currentAmount) || 0;
      if (current <= 0 || current > nextLimit) return payoutAmountInput(nextLimit);
      return currentAmount;
    });
    setIdempotencyKey(newPayoutIdempotencyKey(nextMethod));
  };

  const handleSubmit = async () => {
    if (!amount || parsedAmount <= 0) return;
    if (parsedAmount > methodLimit) {
      alert(
        isInstant
          ? `Payout amount exceeds instant-available balance ($${methodLimit.toFixed(2)}). Instant payouts draw from a smaller Stripe balance than standard payouts.`
          : "Payout amount exceeds available balance.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const endpoint =
        method === "instant"
          ? "/admin/banking/payouts/instant"
          : "/admin/banking/payouts/standard";
      await adminFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({
          amount: parsedAmount,
          idempotency_key: idempotencyKey,
        }),
      });
      setSubmitting(false);
      onSuccess();
      return;
    } catch (e) {
      alert("Payout failed: " + e.message);
    }
    setSubmitting(false);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 16,
          padding: 28,
          width: "100%",
          maxWidth: 400,
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 4,
          }}
        >
          Transfer Stripe Balance
        </div>{" "}
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 20 }}>
          Standard payout avoids the Instant Payout fee. Instant is available
          when speed matters.
        </div>{" "}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginBottom: 18,
          }}
        >
          {[
            {
              key: "standard",
              label: "Standard",
              note: "No instant fee",
              Icon: Clock3,
            },
            { key: "instant", label: "Instant", note: "~1.5% fee", Icon: Zap },
          ].map(({ key, label, note, Icon }) => {
            const selected = method === key;
            const disabled =
              key === "instant" &&
              payoutLimitForMethod(key, available, instantAvailable) <= 0;
            return (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (!disabled) selectMethod(key);
                }}
                style={{
                  border: `1px solid ${selected ? D.heading : D.border}`,
                  background: selected ? D.heading : D.bg,
                  color: selected ? D.white : D.text,
                  borderRadius: 8,
                  padding: "10px 12px",
                  textAlign: "left",
                  cursor: disabled ? "not-allowed" : "pointer",
                  minHeight: 58,
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  <Icon size={16} strokeWidth={2} />
                  {label}
                </span>
                <span
                  style={{
                    display: "block",
                    marginTop: 4,
                    fontSize: 11,
                    color: selected ? "#D4D4D8" : D.muted,
                  }}
                >
                  {disabled ? "Unavailable" : note}
                </span>
              </button>
            );
          })}
        </div>{" "}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 10,
              color: D.muted,
              marginBottom: 4,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            Payout Amount
          </div>{" "}
          <input
            type="number"
            step="0.01"
            min="0"
            max={methodLimit}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setIdempotencyKey(newPayoutIdempotencyKey(method));
            }}
            style={{
              ...inputStyle,
              width: "100%",
              fontSize: 20,
              fontFamily: MONO,
              fontWeight: 700,
              padding: "12px 16px",
            }}
          />{" "}
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>
            {isInstant ? "Instant available" : "Available"}:{" "}
            <span
              style={{
                fontFamily: MONO,
                color: methodLimit > 0 ? D.green : D.red,
              }}
            >
              {fmtM(methodLimit)}
            </span>
          </div>{" "}
        </div>{" "}
        <div
          style={{
            background: D.bg,
            borderRadius: 10,
            padding: 14,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 12, color: D.muted }}>Amount</span>{" "}
            <span style={{ fontFamily: MONO, fontSize: 13, color: D.text }}>
              {fmtM(parsedAmount)}
            </span>{" "}
          </div>{" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 12, color: D.muted }}>
              {isInstant ? "Instant fee estimate" : "Instant fee"}
            </span>{" "}
            <span
              style={{
                fontFamily: MONO,
                fontSize: 13,
                color: isInstant ? D.amber : D.green,
              }}
            >
              {fmtM(fee)}
            </span>{" "}
          </div>{" "}
          <div
            style={{
              borderTop: `1px solid ${D.border}`,
              paddingTop: 6,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>
              Net Transfer
            </span>{" "}
            <span
              style={{
                fontFamily: MONO,
                fontSize: 15,
                fontWeight: 700,
                color: D.green,
              }}
            >
              {fmtM(net)}
            </span>{" "}
          </div>{" "}
        </div>{" "}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              background: "transparent",
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              padding: "10px 16px",
              color: D.muted,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>{" "}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              flex: 1,
              background: D.green,
              border: "none",
              borderRadius: 8,
              padding: "10px 16px",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: canSubmit ? "pointer" : "not-allowed",
              opacity: canSubmit ? 1 : 0.6,
            }}
          >
            {submitLabel}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════
export default function BankingPage() {
  const [tab, setTab] = useState("payouts");
  const isMobile = useIsMobile(640);
  const [balance, setBalance] = useState(null);
  const [stats, setStats] = useState(null);
  const [balanceError, setBalanceError] = useState(false);
  const [statsError, setStatsError] = useState(false);
  const balanceReqIdRef = useRef(0);
  const statsReqIdRef = useRef(0);
  const [payoutModalMethod, setPayoutModalMethod] = useState(null);

  const loadBalance = useCallback(async () => {
    // Sequence guard: only the latest request's outcome applies, so a slow
    // older request that fails after a newer one succeeded can't clobber the
    // fresh balance or flip balanceError back on.
    const reqId = ++balanceReqIdRef.current;
    try {
      const d = await adminFetch("/admin/banking/balance");
      if (reqId !== balanceReqIdRef.current) return;
      setBalance(d);
      setBalanceError(false);
    } catch {
      if (reqId !== balanceReqIdRef.current) return;
      // Drop any stale balance AND flag the error: a failed refresh must not
      // leave old numbers (or a coalesced $0.00) driving any balance-derived
      // field or payout action. Every such field also checks balanceError.
      setBalance(null);
      setBalanceError(true);
    }
  }, []);

  const loadStats = useCallback(async () => {
    const reqId = ++statsReqIdRef.current;
    try {
      const d = await adminFetch("/admin/banking/stats");
      if (reqId !== statsReqIdRef.current) return;
      setStats(d);
      setStatsError(false);
    } catch {
      if (reqId !== statsReqIdRef.current) return;
      setStatsError(true);
    }
  }, []);

  useEffect(() => {
    loadBalance();
    loadStats();
  }, [loadBalance, loadStats]);

  // Server-side cron syncs Stripe at 8 AM and 8 PM ET (see scheduler.js).
  // Webhooks handle real-time payout updates. No manual sync button needed.

  const available = balance?.total_available ?? 0;
  const pending = balance?.total_pending ?? 0;
  const instantAvailable = balance?.total_instant_available ?? null;
  const instantPayoutAvailable = instantAvailable > 0;

  const handlePayoutSuccess = () => {
    setPayoutModalMethod(null);
    loadBalance();
    loadStats();
  };

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      <AdminCommandHeader
        title="Banking"
        icon={Landmark}
        sections={BANKING_SECTIONS}
        activeKey={tab}
        onSectionChange={setTab}
        action={{
          label: "Standard Payout",
          icon: Clock3,
          onClick: () => setPayoutModalMethod("standard"),
          disabled: balanceError || !available || available <= 0,
        }}
        navGridClassName="grid-cols-2 md:grid-cols-4"
      />
      {/* Hero balance — Stripe account label, big balance, payout actions */}
      <div style={{ marginBottom: 32 }}>
        <a
          href="https://dashboard.stripe.com/payouts"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 13,
            color: D.muted,
            textDecoration: "none",
            marginBottom: 12,
          }}
        >
          Stripe payouts{" "}
          <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
            ›
          </span>{" "}
        </a>{" "}
        <div
          style={{
            fontSize: isMobile ? 40 : 48,
            fontWeight: 700,
            color: D.heading,
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
          }}
        >
          {balanceError ? "—" : fmtM(available)}
        </div>{" "}
        {balanceError ? (
          <div style={{ fontSize: 14, color: D.danger || "#dc2626", marginTop: 6 }}>
            Couldn&apos;t load balance.{" "}
            <button
              type="button"
              onClick={loadBalance}
              style={{ background: "none", border: "none", color: D.heading, textDecoration: "underline", cursor: "pointer", padding: 0, font: "inherit" }}
            >
              Retry
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 14, color: D.muted, marginTop: 6 }}>
            Available balance · Waves Pest Control
          </div>
        )}{" "}
        <div
          style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}
        >
          <button
            onClick={() => setPayoutModalMethod("standard")}
            disabled={balanceError || !available || available <= 0}
            style={{
              background: D.heading,
              border: "none",
              borderRadius: 9999,
              padding: "12px 28px",
              color: D.white,
              fontSize: 14,
              fontWeight: 600,
              cursor: balanceError || !available || available <= 0 ? "not-allowed" : "pointer",
              opacity: balanceError || !available || available <= 0 ? 0.4 : 1,
              minHeight: 44,
            }}
          >
            Standard Payout
          </button>{" "}
          <button
            onClick={() => setPayoutModalMethod("instant")}
            disabled={!instantPayoutAvailable}
            title={
              instantPayoutAvailable
                ? "Create an instant payout"
                : "No instant-available Stripe balance"
            }
            style={{
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 9999,
              padding: "12px 24px",
              color: D.text,
              fontSize: 14,
              fontWeight: 600,
              cursor: !instantPayoutAvailable ? "not-allowed" : "pointer",
              opacity: !instantPayoutAvailable ? 0.4 : 1,
              minHeight: 44,
            }}
          >
            Instant Payout
          </button>{" "}
        </div>{" "}
      </div>
      {/* Secondary metrics */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3, 1fr)",
          gap: 10,
          marginBottom: 28,
        }}
      >
        <div
          style={{
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 12,
            padding: isMobile ? "14px 12px" : "16px 20px",
          }}
        >
          <div
            style={{
              color: D.muted,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            Pending
          </div>{" "}
          <div
            style={{
              fontFamily: MONO,
              fontSize: 22,
              fontWeight: 700,
              color: D.amber,
            }}
          >
            {balanceError ? "—" : fmtM(pending)}
          </div>{" "}
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>
            Processing
          </div>{" "}
        </div>{" "}
        <div
          style={{
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 12,
            padding: isMobile ? "14px 12px" : "16px 20px",
          }}
        >
          <div
            style={{
              color: D.muted,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            Next Payout
          </div>{" "}
          <div
            style={{
              fontFamily: MONO,
              fontSize: 22,
              fontWeight: 700,
              color: D.heading,
            }}
          >
            {balanceError ? "—" : fmtM(balance?.next_payout?.amount)}
          </div>{" "}
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>
            {balanceError
              ? "Unavailable"
              : balance?.next_payout?.arrival_date
                ? fmtDay(balance.next_payout.arrival_date)
                : "No payout scheduled"}
          </div>{" "}
        </div>{" "}
        <div
          style={{
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 12,
            padding: isMobile ? "14px 12px" : "16px 20px",
          }}
        >
          <div
            style={{
              color: D.muted,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            MTD Deposited
          </div>{" "}
          <div
            style={{
              fontFamily: MONO,
              fontSize: 22,
              fontWeight: 700,
              color: D.heading,
            }}
          >
            {statsError ? "—" : fmtM(stats?.mtd_deposited)}
          </div>{" "}
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>
            {statsError
              ? "Unavailable"
              : `${stats?.payout_count ?? 0} payout${(stats?.payout_count ?? 0) !== 1 ? "s" : ""} this month`}
          </div>{" "}
        </div>{" "}
      </div>
      {tab === "payouts" && <PayoutsTab />}
      {tab === "cashflow" && <CashFlowTab />}
      {tab === "reconciliation" && <ReconciliationTab />}
      {tab === "exports" && <ExportsTab />}
      {/* Payout Modal */}
      {payoutModalMethod && (
        <PayoutModal
          available={available}
          instantAvailable={instantAvailable}
          initialMethod={payoutModalMethod}
          onClose={() => setPayoutModalMethod(null)}
          onSuccess={handlePayoutSuccess}
        />
      )}
    </div>
  );
}
