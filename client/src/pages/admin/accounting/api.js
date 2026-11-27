/**
 * Shared client API and formatting helpers for the General Ledger / Accounting suite.
 */

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const BASE = "/admin/accounting";

export async function accountingFetch(path, options = {}) {
  const { headers: extraHeaders, ...rest } = options;
  const response = await fetch(`${API_BASE}${BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error || "";
    } catch {
      /* non-JSON response */
    }
    const err = new Error(detail || `HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export const getJson = (path) => accountingFetch(path);
export const postJson = (path, body) => accountingFetch(path, { method: "POST", body: JSON.stringify(body) });
export const patchJson = (path, body) => accountingFetch(path, { method: "PATCH", body: JSON.stringify(body) });

export function formatCents(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const abs = (Math.abs(n) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

export function parseDollarsToCents(input) {
  const cleaned = String(input ?? "").replace(/[$,\s]/g, "");
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export const ACCOUNT_TYPE_LABELS = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  cogs: "Cost of Goods Sold",
  expense: "Operating Expenses",
};

export const ACCOUNT_TYPE_ORDER = ["asset", "liability", "equity", "revenue", "cogs", "expense"];
