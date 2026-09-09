import {
  Button,
  buttonStyles,
  Field,
  Input,
  Badge,
  Card,
  UiSurface,
  ActionFeedback,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "../../components/ui";
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
import {
  etDateString,
  formatETDate,
  formatETDateOnly,
} from "../../lib/timezone";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import useIsMobile from "../../hooks/useIsMobile";
import { reportError } from "../../lib/reportError";
const API = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.

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
  paid: "#18181B",
  pending: "#52525B",
  in_transit: "#52525B",
  failed: "#C8312F",
  // Money clawed back or a payout that never happened is a genuine alert —
  // these previously fell through to a calm neutral gray.
  canceled: "#C8312F",
  reversed: "#C8312F",
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
const BANKING_SECTIONS = [
  {
    key: "payouts",
    label: "Payouts",
    Icon: Wallet,
  },
  {
    key: "cashflow",
    label: "Cash Flow",
    Icon: TrendingUp,
  },
  {
    key: "reconciliation",
    label: "Reconciliation",
    Icon: CheckCircle2,
  },
  {
    key: "exports",
    label: "Exports",
    Icon: Download,
  },
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
  const [txnErrors, setTxnErrors] = useState({});
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
  const loadTransactions = async (payoutId) => {
    setTxnErrors((prev) => ({
      ...prev,
      [payoutId]: null,
    }));
    try {
      const d = await adminFetch(`/admin/banking/payouts/${payoutId}`);
      setTxns((prev) => ({
        ...prev,
        [payoutId]: d.transactions || [],
      }));
    } catch (error) {
      setTxnErrors((prev) => ({
        ...prev,
        [payoutId]: error.message,
      }));
    }
  };
  const toggleExpand = (payoutId) => {
    if (expanded === payoutId) {
      setExpanded(null);
      return;
    }
    setExpanded(payoutId);
    if (!txns[payoutId]) loadTransactions(payoutId);
  };
  return (
    <div className="min-h-60">
      {loading && <ActionFeedback>Loading payouts…</ActionFeedback>}
      {!loading && !loadError && payouts.length === 0 && (
        <ActionFeedback>
          No payouts found. New Stripe payouts will appear here after syncing.
        </ActionFeedback>
      )}
      {!loading && loadError && (
        <div
          style={{
            background: "#C8312F11",
            border: "1px solid #C8312F",
            borderRadius: 8,
            padding: "14px 16px",
            marginBottom: 12,
            color: "#C8312F",
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>Couldn't load payouts ({loadError}).</span>
          <Button
            onClick={() => load(page)}
            type="button"
            variant="secondary"
            className="min-w-11"
          >
            Retry
          </Button>
        </div>
      )}
      <div
        style={{
          overflowX: "auto",
        }}
      >
        <Table>
          <THead>
            <TR>
              <TH>Date</TH>
              <TH
                style={{
                  textAlign: "right",
                }}
              >
                Amount
              </TH>
              <TH>Status</TH>
              <TH
                style={{
                  textAlign: "right",
                }}
              >
                Transactions
              </TH>
              <TH
                style={{
                  textAlign: "right",
                }}
              >
                Fees
              </TH>
              <TH>Arrival</TH>
              <TH>Reconciled</TH>
            </TR>
          </THead>
          <TBody>
            {payouts.map((p) => (
              <Fragment key={p.id}>
                <TR
                  onClick={() => toggleExpand(p.id)}
                  style={{
                    cursor: "pointer",
                    background: expanded === p.id ? "#F4F4F5" : "transparent",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (expanded !== p.id)
                      e.currentTarget.style.background = "#FFFFFF88";
                  }}
                  onMouseLeave={(e) => {
                    if (expanded !== p.id)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  <TD>
                    <Button
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpand(p.id);
                      }}
                      aria-expanded={expanded === p.id}
                      aria-controls={
                        expanded === p.id ? `payout-detail-${p.id}` : undefined
                      }
                      aria-label={`Payout ${p.id}`}
                    >
                      {fmtD(
                        p.created_at_stripe ||
                          p.created_at ||
                          p.date ||
                          p.created,
                      )}
                    </Button>
                  </TD>
                  <TD
                    style={{
                      textAlign: "right",
                    }}
                  >
                    {fmtM(p.amount)}
                  </TD>
                  <TD>
                    <Badge
                      tone={
                        (STATUS_COLORS[p.status] || "#71717A") === "#C8312F"
                          ? "alert"
                          : "neutral"
                      }
                    >
                      {p.status}
                    </Badge>
                  </TD>
                  <TD
                    style={{
                      textAlign: "right",
                    }}
                  >
                    {p.transaction_count ?? "--"}
                  </TD>
                  <TD
                    style={{
                      textAlign: "right",
                      color: "#71717A",
                    }}
                  >
                    {p.fee_total != null
                      ? fmtM(p.fee_total)
                      : p.fees != null
                        ? fmtM(p.fees)
                        : "--"}
                  </TD>
                  <TD>{fmtDay(p.arrival_date)}</TD>
                  <TD
                    style={{
                      textAlign: "center",
                    }}
                  >
                    {p.reconciled ? (
                      <span
                        style={{
                          color: "#18181B",
                          fontSize: 16,
                        }}
                      >
                        &#10003;
                      </span>
                    ) : (
                      <span
                        style={{
                          color: "#71717A",
                        }}
                      >
                        --
                      </span>
                    )}
                  </TD>
                </TR>
                {expanded === p.id && (
                  <TR key={`${p.id}-detail`} id={`payout-detail-${p.id}`}>
                    <TD
                      colSpan={7}
                      style={{
                        background: "#F4F4F5",
                      }}
                    >
                      <div
                        style={{
                          padding: "12px 20px",
                        }}
                      >
                        {txnErrors[p.id] ? (
                          <ActionFeedback
                            error
                            onRetry={() => loadTransactions(p.id)}
                          >
                            Could not load payout transactions:{" "}
                            {txnErrors[p.id]}
                          </ActionFeedback>
                        ) : !txns[p.id] ? (
                          <div
                            style={{
                              color: "#71717A",
                              fontSize: 14,
                            }}
                          >
                            Loading transactions...
                          </div>
                        ) : txns[p.id].length === 0 ? (
                          <div
                            style={{
                              color: "#71717A",
                              fontSize: 14,
                            }}
                          >
                            No transaction details available
                          </div>
                        ) : (
                          <Table>
                            <THead>
                              <TR>
                                <TH>Customer / Type</TH>
                                <TH>Description</TH>
                                <TH
                                  style={{
                                    textAlign: "right",
                                  }}
                                >
                                  Amount
                                </TH>
                                <TH
                                  style={{
                                    textAlign: "right",
                                  }}
                                >
                                  Fee
                                </TH>
                                <TH
                                  style={{
                                    textAlign: "right",
                                  }}
                                >
                                  Net
                                </TH>
                              </TR>
                            </THead>
                            <TBody>
                              {txns[p.id].map((t, i) => {
                                const isFee =
                                  t.type === "stripe_fee" || t.type === "fee";
                                return (
                                  <TR
                                    key={i}
                                    style={{
                                      opacity: isFee ? 0.5 : 1,
                                    }}
                                  >
                                    <TD
                                      style={{
                                        color: isFee ? "#71717A" : "#27272A",
                                      }}
                                    >
                                      {t.customer_name || t.type || "--"}
                                    </TD>
                                    <TD
                                      style={{
                                        color: "#71717A",
                                      }}
                                    >
                                      {t.description || "--"}
                                    </TD>
                                    <TD
                                      style={{
                                        textAlign: "right",
                                      }}
                                    >
                                      {fmtM(t.amount)}
                                    </TD>
                                    <TD
                                      style={{
                                        textAlign: "right",
                                        color: "#71717A",
                                      }}
                                    >
                                      {t.fee != null ? fmtM(t.fee) : "--"}
                                    </TD>
                                    <TD
                                      style={{
                                        textAlign: "right",
                                      }}
                                    >
                                      {t.net != null ? fmtM(t.net) : "--"}
                                    </TD>
                                  </TR>
                                );
                              })}
                            </TBody>
                          </Table>
                        )}
                      </div>{" "}
                    </TD>
                  </TR>
                )}
              </Fragment>
            ))}
          </TBody>
        </Table>
      </div>
      {loading && (
        <div
          style={{
            textAlign: "center",
            color: "#71717A",
            fontSize: 14,
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
        <Button
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
          type="button"
          variant="secondary"
          className="min-w-11"
        >
          Previous
        </Button>{" "}
        <span className="u-nums"
          style={{
            color: "#71717A",
            fontSize: 14,
            alignSelf: "center",
          }}
        >
          Page {page}
        </span>{" "}
        <Button
          disabled={!hasMore}
          onClick={() => setPage((p) => p + 1)}
          type="button"
          variant="secondary"
          className="min-w-11"
        >
          Next
        </Button>{" "}
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
        <div
          style={{
            display: "flex",
            gap: 4,
          }}
        >
          {["weekly", "monthly"].map((p) => (
            <Button
              key={p}
              onClick={() => setPeriod(p)}
              type="button"
              variant={period === p ? "primary" : "secondary"}
              aria-pressed={period === p}
              className="min-w-11"
            >
              {p}
            </Button>
          ))}
        </div>{" "}
        <Field label="Start date" className="min-w-0">
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{
              width: 140,
            }}
          />
        </Field>{" "}
        <span
          style={{
            color: "#71717A",
            fontSize: 14,
          }}
        >
          to
        </span>{" "}
        <Field label="End date" className="min-w-0">
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{
              width: 140,
            }}
          />
        </Field>{" "}
      </div>
      {loading && (
        <div
          style={{
            color: "#71717A",
            fontSize: 14,
            padding: 16,
            textAlign: "center",
          }}
        >
          Loading cash flow data...
        </div>
      )}
      {!loading && chartData.length > 0 && (
        <Card
          style={{
            padding: 20,
            marginBottom: 20,
          }}
        >
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={chartData}
              margin={{
                top: 10,
                right: 10,
                left: 0,
                bottom: 0,
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={"#E4E4E7"} />{" "}
              <XAxis
                dataKey="label"
                tick={{
                  fill: "#71717A",
                  fontSize: 14,
                }}
                axisLine={{
                  stroke: "#E4E4E7",
                }}
              />{" "}
              <YAxis className="u-nums"
                tick={{
                  fill: "#71717A",
                  fontSize: 14,
                }}
                axisLine={{
                  stroke: "#E4E4E7",
                }}
                tickFormatter={(v) => "$" + (v / 1000).toFixed(0) + "k"}
              />{" "}
              <Tooltip content={<CashFlowTooltip />} />{" "}
              <Legend
                wrapperStyle={{
                  fontSize: 14,
                  color: "#71717A",
                }}
              />{" "}
              <Bar
                dataKey="money_in"
                name="Money In"
                fill={"#18181B"}
                radius={[4, 4, 0, 0]}
              />{" "}
              <Bar
                dataKey="money_out"
                name="Money Out"
                fill={"#A1A1AA"}
                radius={[4, 4, 0, 0]}
              />{" "}
            </BarChart>{" "}
          </ResponsiveContainer>{" "}
        </Card>
      )}
      {!loading && loadError && (
        <div
          style={{
            background: "#C8312F11",
            border: "1px solid #C8312F",
            borderRadius: 8,
            padding: "14px 16px",
            color: "#C8312F",
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>
            Couldn't load cash flow ({loadError}). Figures are unavailable — not
            zero.
          </span>
          <Button
            onClick={load}
            type="button"
            variant="secondary"
            className="min-w-11"
          >
            Retry
          </Button>
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
            color={"#18181B"}
          />{" "}
          <SummaryCard
            label="Expenses + Fees"
            value={data ? fmtM(totalOut) : "—"}
            color={"#18181B"}
          />{" "}
          <SummaryCard
            label="Operating Net"
            value={data ? fmtM(net) : "—"}
            color={net >= 0 ? "#18181B" : "#C8312F"}
          />{" "}
          <SummaryCard
            label="Stripe Fees"
            value={data ? fmtM(summary.stripe_fees) : "—"}
            color={"#52525B"}
          />{" "}
        </div>
      )}
    </div>
  );
}
function CashFlowTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <Card
      style={{
        padding: "10px 14px",
        fontSize: 14,
      }}
    >
      <div
        style={{
          color: "#71717A",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {payload.map((p, i) => (
        <div className="u-nums"
          key={i}
          style={{
            color: p.color,
          }}
        >
          {fmtM(p.value)} {p.name}
        </div>
      ))}
    </Card>
  );
}
function SummaryCard({ label, value, color }) {
  const isMobile = useIsMobile(640);
  return (
    <Card
      style={{
        padding: isMobile ? "12px 10px" : "16px 20px",
      }}
    >
      <div
        style={{
          color: "#71717A",
          fontSize: 14,
          marginBottom: 6,
        }}
      >
        {label}
      </div>{" "}
      <div className="u-nums"
        style={{
          fontSize: 22,
          fontWeight: 500,
          color: color || "#09090B",
        }}
      >
        {value}
      </div>{" "}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// RECONCILIATION TAB
// ═══════════════════════════════════════════════════════════════
function ReconciliationTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
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
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleReconcile");
    setActionError("");
    try {
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
        reportError(e, "banking:reconcile");
        setActionError("Reconciliation failed: " + e.message);
      }
      setReconciling(null);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  return (
    <div>
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}
      {loading && (
        <div
          style={{
            color: "#71717A",
            fontSize: 14,
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
            background: "#C8312F11",
            border: "1px solid #C8312F",
            borderRadius: 8,
            padding: "14px 16px",
            color: "#C8312F",
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>
            Couldn't load reconciliation ({loadError}) — outstanding payouts may
            be hidden.
          </span>
          <Button
            onClick={load}
            type="button"
            variant="secondary"
            className="min-w-11"
            disabled={!!pendingAction}
          >
            Retry
          </Button>
        </div>
      )}

      {!loading && !loadError && items.length === 0 && (
        <div
          style={{
            color: "#71717A",
            fontSize: 14,
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
          <Card
            key={item.id}
            style={{
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
              <div
                style={{
                  flex: 1,
                  minWidth: 150,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: "#09090B",
                  }}
                >
                  {fmtD(item.date || item.created)}
                </div>{" "}
                <div
                  style={{
                    fontSize: 14,
                    color: "#71717A",
                    marginTop: 2,
                  }}
                >
                  Expected:{" "}
                  <span className="u-nums"
                    style={{
                      color: "#27272A",
                    }}
                  >
                    {fmtM(item.expected_amount || item.amount)}
                  </span>
                </div>{" "}
              </div>
              {item.reconciled ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      color: "#18181B",
                      fontSize: 16,
                    }}
                  >
                    &#10003;
                  </span>{" "}
                  <div
                    style={{
                      fontSize: 14,
                      color: "#71717A",
                    }}
                  >
                    <div>
                      Actual:{" "}
                      <span className="u-nums"
                        style={{
                          color: "#18181B",
                        }}
                      >
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
                    {" "}
                    <Field label="Actual Amount" className="min-w-0">
                      <Input
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
                        style={{
                          width: 120,
                        }}
                        disabled={!!pendingAction}
                      />
                    </Field>{" "}
                  </div>
                  {discrepancy != null && parseFloat(discrepancy) !== 0 && (
                    <div className="u-nums"
                      style={{
                        fontSize: 14,
                        color:
                          parseFloat(discrepancy) > 0 ? "#18181B" : "#C8312F",
                        alignSelf: "flex-end",
                        padding: "8px 0",
                      }}
                    >
                      {parseFloat(discrepancy) > 0 ? "+" : ""}
                      {fmtM(parseFloat(discrepancy))}
                    </div>
                  )}
                  <div>
                    {" "}
                    <Field label="Notes" className="min-w-0">
                      <Input
                        value={notes[item.id] || ""}
                        onChange={(e) =>
                          setNotes((prev) => ({
                            ...prev,
                            [item.id]: e.target.value,
                          }))
                        }
                        placeholder="Optional notes"
                        style={{
                          width: 160,
                        }}
                        disabled={!!pendingAction}
                      />
                    </Field>{" "}
                  </div>{" "}
                  <Button
                    onClick={() => handleReconcile(item.id)}
                    disabled={
                      !!pendingAction ||
                      reconciling === item.id ||
                      !actuals[item.id]
                    }
                    style={{
                      alignSelf: "flex-end",
                    }}
                    type="button"
                    variant="primary"
                    loading={reconciling === item.id}
                    className="min-w-11"
                  >
                    {"Reconcile"}
                  </Button>{" "}
                </div>
              )}
            </div>{" "}
          </Card>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS TAB
// ═══════════════════════════════════════════════════════════════
function ExportsTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [startDate, setStartDate] = useState(etDateString(startOfMonth));
  const [endDate, setEndDate] = useState(etDateString(today));
  const [format, setFormat] = useState("csv");
  const [preview, setPreview] = useState([]);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewAttempt, setPreviewAttempt] = useState(0);
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
    let active = true;
    setPreviewLoading(true);
    setPreviewError("");
    adminFetch(
      `/admin/banking/payouts?limit=5&page=1&start_date=${startDate}&end_date=${endDate}`,
    )
      .then((d) => {
        if (active) setPreview(d.payouts || []);
      })
      .catch((error) => {
        if (active) {
          setPreview([]);
          setPreviewError(error.message);
        }
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [startDate, endDate, previewAttempt]);
  const handleDownload = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleDownload");
    setActionError("");
    try {
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
        reportError(e, "banking:download");
        setActionError("Download failed: " + e.message);
      }
      setDownloading(false);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  return (
    <div>
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}
      <Card
        style={{
          padding: 20,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: "#09090B",
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
            {" "}
            <Field label="Start Date" className="min-w-0">
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={{
                  width: 150,
                }}
                disabled={!!pendingAction}
              />
            </Field>{" "}
          </div>{" "}
          <div>
            {" "}
            <Field label="End Date" className="min-w-0">
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={{
                  width: 150,
                }}
                disabled={!!pendingAction}
              />
            </Field>{" "}
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
            {
              key: "this_month",
              label: "This Month",
            },
            {
              key: "last_month",
              label: "Last Month",
            },
            {
              key: "this_quarter",
              label: "This Quarter",
            },
            {
              key: "ytd",
              label: "YTD",
            },
          ].map((p) => (
            <Button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              type="button"
              variant="secondary"
              className="min-w-11"
              disabled={!!pendingAction}
            >
              {p.label}
            </Button>
          ))}
        </div>
        {/* Format */}
        <div
          style={{
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginBottom: 6,
            }}
          >
            Format
          </div>{" "}
          <div
            style={{
              display: "flex",
              gap: 4,
            }}
          >
            {["csv", "ofx"].map((f) => (
              <Button
                key={f}
                onClick={() => setFormat(f)}
                type="button"
                variant={format === f ? "primary" : "secondary"}
                aria-pressed={format === f}
                className="min-w-11"
                disabled={!!pendingAction}
              >
                {f}
              </Button>
            ))}
          </div>{" "}
        </div>{" "}
        <Button
          onClick={handleDownload}
          disabled={!!pendingAction || downloading}
          type="button"
          variant="primary"
          loading={downloading}
          className="min-w-11"
        >
          {"Generate & Download"}
        </Button>{" "}
      </Card>
      {previewLoading && (
        <ActionFeedback>Loading export preview…</ActionFeedback>
      )}
      {previewError && (
        <ActionFeedback
          error
          onRetry={() => setPreviewAttempt((value) => value + 1)}
        >
          Could not load export preview: {previewError}
        </ActionFeedback>
      )}
      {!previewLoading && !previewError && preview.length === 0 && (
        <ActionFeedback>
          No payouts in this date range. Choose another range to preview.
        </ActionFeedback>
      )}
      {/* Preview */}
      {preview.length > 0 && (
        <Card
          style={{
            padding: 20,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: "#09090B",
              marginBottom: 10,
            }}
          >
            Preview (first 5 payouts in range)
          </div>{" "}
          <div
            style={{
              overflowX: "auto",
            }}
          >
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH
                    style={{
                      textAlign: "right",
                    }}
                  >
                    Amount
                  </TH>
                  <TH>Status</TH>
                  <TH>Arrival</TH>
                </TR>
              </THead>
              <TBody>
                {preview.map((p, i) => (
                  <TR key={i}>
                    <TD>
                      {fmtD(
                        p.created_at_stripe ||
                          p.created_at ||
                          p.date ||
                          p.created,
                      )}
                    </TD>
                    <TD
                      style={{
                        textAlign: "right",
                      }}
                    >
                      {fmtM(p.amount)}
                    </TD>
                    <TD>
                      <Badge
                        tone={
                          (STATUS_COLORS[p.status] || "#71717A") === "#C8312F"
                            ? "alert"
                            : "neutral"
                        }
                      >
                        {p.status}
                      </Badge>
                    </TD>
                    <TD>{fmtDay(p.arrival_date)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
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
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
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
  const canSubmit =
    !submitting && parsedAmount > 0 && methodLimit > 0 && !isOverLimit;
  const submitLabel =
    isInstant && methodLimit <= 0
      ? "Instant Unavailable"
      : `Confirm ${isInstant ? "Instant" : "Standard"}`;
  const selectMethod = (nextMethod) => {
    const nextLimit = payoutLimitForMethod(
      nextMethod,
      available,
      instantAvailable,
    );
    setMethod(nextMethod);
    setAmount((currentAmount) => {
      const current = parseFloat(currentAmount) || 0;
      if (current <= 0 || current > nextLimit)
        return payoutAmountInput(nextLimit);
      return currentAmount;
    });
    setIdempotencyKey(newPayoutIdempotencyKey(nextMethod));
  };
  const handleSubmit = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleSubmit");
    setActionError("");
    try {
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
        reportError(e, "banking:payout");
        setActionError("Payout failed: " + e.message);
      }
      setSubmitting(false);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  return (
    <Dialog open onClose={submitting ? undefined : onClose} size="md">
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}
      <DialogHeader>
        <DialogTitle>Transfer Stripe Balance</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div
          style={{
            fontSize: 14,
            color: "#71717A",
            marginBottom: 20,
          }}
        >
          Standard payout avoids the Instant Payout fee. Instant is available
          when speed matters.
        </div>
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
            {
              key: "instant",
              label: "Instant",
              note: "~1.5% fee",
              Icon: Zap,
            },
          ].map(({ key, label, note, Icon }) => {
            const selected = method === key;
            const disabled =
              key === "instant" &&
              payoutLimitForMethod(key, available, instantAvailable) <= 0;
            return (
              <Button
                key={key}
                type="button"
                disabled={!!pendingAction || disabled}
                onClick={() => {
                  if (!disabled) selectMethod(key);
                }}
                style={{
                  textAlign: "left",
                }}
                variant={selected ? "primary" : "secondary"}
                aria-pressed={selected}
                className="min-w-11 flex-col !h-auto p-3"
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 14,
                    fontWeight: 500,
                  }}
                >
                  <Icon size={16} strokeWidth={2} />
                  {label}
                </span>
                <span
                  style={{
                    display: "block",
                    marginTop: 4,
                    fontSize: 14,
                    color: selected ? "#FFFFFF" : "#71717A",
                  }}
                >
                  {disabled ? "Unavailable" : note}
                </span>
              </Button>
            );
          })}
        </div>
        <div
          style={{
            marginBottom: 16,
          }}
        >
          {" "}
          <Field label="Payout Amount" className="min-w-0">
            <Input
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
                width: "100%",
              }}
              disabled={!!pendingAction}
            />
          </Field>{" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginTop: 4,
            }}
          >
            {isInstant ? "Instant available" : "Available"}:{" "}
            <span className="u-nums"
              style={{
                color: methodLimit > 0 ? "#18181B" : "#C8312F",
              }}
            >
              {fmtM(methodLimit)}
            </span>
          </div>{" "}
        </div>
        <div
          style={{
            background: "#F4F4F5",
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
            <span
              style={{
                fontSize: 14,
                color: "#71717A",
              }}
            >
              Amount
            </span>{" "}
            <span className="u-nums"
              style={{
                fontSize: 14,
                color: "#27272A",
              }}
            >
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
            <span
              style={{
                fontSize: 14,
                color: "#71717A",
              }}
            >
              {isInstant ? "Instant fee estimate" : "Instant fee"}
            </span>{" "}
            <span className="u-nums"
              style={{
                fontSize: 14,
                color: isInstant ? "#52525B" : "#18181B",
              }}
            >
              {fmtM(fee)}
            </span>{" "}
          </div>{" "}
          <div
            style={{
              borderTop: "1px solid #E4E4E7",
              paddingTop: 6,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: "#09090B",
              }}
            >
              Net Transfer
            </span>{" "}
            <span className="u-nums"
              style={{
                fontSize: 15,
                fontWeight: 500,
                color: "#18181B",
              }}
            >
              {fmtM(net)}
            </span>{" "}
          </div>{" "}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button
          onClick={onClose}
          style={{
            flex: 1,
          }}
          type="button"
          variant="secondary"
          className="min-w-11"
          disabled={!!pendingAction}
        >
          Cancel
        </Button>{" "}
        <Button
          onClick={handleSubmit}
          disabled={!!pendingAction || !canSubmit}
          style={{
            flex: 1,
          }}
          type="button"
          variant="primary"
          className="min-w-11"
          loading={pendingAction === "handleSubmit"}
        >
          {submitLabel}
        </Button>{" "}
      </DialogFooter>
    </Dialog>
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
    <UiSurface
      density="comfortable"
      className="ui-workspace mx-auto max-w-[1300px] text-ui-body text-zinc-900"
    >
      <AdminCommandHeader
        title="Banking"
        icon={Landmark}
        sections={BANKING_SECTIONS}
        activeKey={tab}
        onSectionChange={setTab}
        action={{
          label: "Standard Payout",
          icon: Clock3,
          onClick: (event) => {
            event.currentTarget.focus({ preventScroll: true });
            setPayoutModalMethod("standard");
          },
          disabled: balanceError || !available || available <= 0,
        }}
        navGridClassName="grid-cols-2 md:grid-cols-4"
        variant="workspace"
      />
      {/* Hero balance — Stripe account label, big balance, payout actions */}
      <div
        style={{
          marginBottom: 32,
        }}
      >
        <a
          className={buttonStyles({ density: "comfortable", variant: "ghost" })}
          href="https://dashboard.stripe.com/payouts"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 14,
            color: "#71717A",
            textDecoration: "none",
            marginBottom: 12,
          }}
        >
          Stripe payouts{" "}
          <span
            aria-hidden
            style={{
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ›
          </span>{" "}
        </a>{" "}
        <div
          style={{
            fontSize: 32,
            fontWeight: 500,
            color: "#09090B",
            lineHeight: 1.1,
          }}
        >
          {!balance || balanceError ? "—" : fmtM(available)}
        </div>{" "}
        {balanceError ? (
          <div
            style={{
              fontSize: 14,
              color: "#C8312F" || "#dc2626",
              marginTop: 6,
            }}
          >
            Couldn&apos;t load balance.{" "}
            <Button
              type="button"
              onClick={loadBalance}
              style={{
                textDecoration: "underline",
                font: "inherit",
              }}
              variant="secondary"
              className="min-w-11"
            >
              Retry
            </Button>
          </div>
        ) : (
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginTop: 6,
            }}
          >
            Available balance · Waves Pest Control
          </div>
        )}{" "}
        <div
          style={{
            display: "flex",
            gap: 10,
            marginTop: 20,
            flexWrap: "wrap",
          }}
        >
          <Button
            onClick={(event) => {
              event.currentTarget.focus({
                preventScroll: true,
              });
              setPayoutModalMethod("standard");
            }}
            disabled={balanceError || !available || available <= 0}
            type="button"
            variant="primary"
            className="min-w-11"
          >
            Standard Payout
          </Button>{" "}
          <Button
            onClick={(event) => {
              event.currentTarget.focus({
                preventScroll: true,
              });
              setPayoutModalMethod("instant");
            }}
            disabled={!instantPayoutAvailable}
            title={
              instantPayoutAvailable
                ? "Create an instant payout"
                : "No instant-available Stripe balance"
            }
            type="button"
            variant="secondary"
            className="min-w-11"
          >
            Instant Payout
          </Button>{" "}
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
        <Card
          style={{
            padding: isMobile ? "14px 12px" : "16px 20px",
          }}
        >
          <div
            style={{
              color: "#71717A",
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Pending
          </div>{" "}
          <div className="u-nums"
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: "#52525B",
            }}
          >
            {!balance || balanceError ? "—" : fmtM(pending)}
          </div>{" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginTop: 4,
            }}
          >
            Processing
          </div>{" "}
        </Card>{" "}
        <Card
          style={{
            padding: isMobile ? "14px 12px" : "16px 20px",
          }}
        >
          <div
            style={{
              color: "#71717A",
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Next Payout
          </div>{" "}
          <div className="u-nums"
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: "#09090B",
            }}
          >
            {!balance || balanceError
              ? "—"
              : fmtM(balance?.next_payout?.amount)}
          </div>{" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginTop: 4,
            }}
          >
            {balanceError
              ? "Unavailable"
              : balance?.next_payout?.arrival_date
                ? fmtDay(balance.next_payout.arrival_date)
                : "No payout scheduled"}
          </div>{" "}
        </Card>{" "}
        <Card
          style={{
            padding: isMobile ? "14px 12px" : "16px 20px",
          }}
        >
          <div
            style={{
              color: "#71717A",
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            MTD Deposited
          </div>{" "}
          <div className="u-nums"
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: "#09090B",
            }}
          >
            {!stats || statsError ? "—" : fmtM(stats?.mtd_deposited)}
          </div>{" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginTop: 4,
            }}
          >
            {statsError
              ? "Unavailable"
              : `${stats?.payout_count ?? 0} payout${(stats?.payout_count ?? 0) !== 1 ? "s" : ""} this month`}
          </div>{" "}
        </Card>{" "}
      </div>
      {statsError && (
        <ActionFeedback error onRetry={loadStats} className="mb-4">
          Could not load deposit totals.
        </ActionFeedback>
      )}
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
    </UiSurface>
  );
}
