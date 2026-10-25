import { ITEM_BY_KEY, STATUS, STATUS_ORDER, STATUS_LABEL, itemStatus, daysBetween } from "@bid-kit-catalog";
import { REFERENCE_TARGET, kitKeysForLine } from "@bid-checklist-kit-map";

// The Bid kit status beside a Bid Desk checklist line (read only). The status of every kit row is the kit's own rule
// (itemStatus in shared/bid-kit-catalog.cjs); nothing here decides what "ready" means. A line that needs several kit
// papers shows the worst of them.

const WORST_FIRST = (a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b);
// A reference counts when the kit calls it valid on a bid today: ready, or ready and expiring soon.
const COUNTS = new Set([STATUS.READY, STATUS.EXPIRING]);

/** The kit list reply (GET /admin/bid-kit) as { today, rows by item key }. Archived rows never count. null when unusable. */
export function buildKitIndex(body) {
  if (!body || !Array.isArray(body.items)) return null;
  const today = typeof body.today === "string" ? body.today : undefined;
  const byKey = {};
  for (const row of body.items) {
    if (!row || row.archived_at || !row.item_key) continue;
    const entry = ITEM_BY_KEY[row.item_key];
    if (!entry || entry.kind !== row.kind) continue;
    // The list reply carries has_file as `file` (the private file key never leaves the server).
    const status = itemStatus({ ...row, has_file: row.has_file === true || Boolean(row.file) }, { today });
    (byKey[row.item_key] ||= []).push({ id: row.id, status, expiresOn: row.expires_on || null });
  }
  return { today, byKey };
}

const link = (id) => (id ? `/admin/bid-kit?item=${encodeURIComponent(id)}` : "/admin/bid-kit");

// One kit item as the line sees it: its worst row (soonest expiry among equals), or missing when it has no row.
function itemState(key, index) {
  const rows = index.byKey[key] || [];
  const label = (ITEM_BY_KEY[key] || {}).label || key;
  if (!rows.length) return { key, label, status: STATUS.MISSING, id: null, expiresOn: null };
  const [worst] = [...rows].sort((a, b) => WORST_FIRST(a.status, b.status) || String(a.expiresOn || "9999").localeCompare(String(b.expiresOn || "9999")));
  return { key, label, status: worst.status, id: worst.id, expiresOn: worst.expiresOn };
}

function daysLeft(expiresOn, today) {
  if (!expiresOn || !today) return null;
  const days = daysBetween(today, expiresOn);
  return Number.isFinite(days) ? days : null;
}

const WORDS = {
  [STATUS.MISSING]: "Kit: missing",
  [STATUS.EXPIRED]: "Kit: expired",
  [STATUS.NEEDS_EXPIRY]: "Kit: on file, add expiry date",
  [STATUS.NEEDS_PERMISSION]: "Kit: needs permission",
  [STATUS.UNATTESTED]: "Kit: on file, not signed off",
  [STATUS.READY]: "Kit: on file, signed off",
};
const TONE = { [STATUS.READY]: "strong", [STATUS.EXPIRING]: "warn", [STATUS.MISSING]: "alert", [STATUS.EXPIRED]: "alert" };

function referencePill(index) {
  const rows = index.byKey.reference || [];
  const count = rows.filter((row) => COUNTS.has(row.status)).length;
  const title = rows.length
    ? `Customer references: ${count} ready, ${rows.length} in the kit. Agencies ask for three to five.`
    : "Customer references: none in the kit yet. Agencies ask for three to five.";
  const first = rows[0];
  return { text: `Kit: ${count} of ${REFERENCE_TARGET} references`, tone: count >= REFERENCE_TARGET ? "strong" : count === 0 ? "alert" : "warn", title, to: link(rows.length === 1 ? first.id : null) };
}

/**
 * The pill for one checklist line, or null when the line needs no kit paper (or the kit is not loaded).
 * @returns {{ text: string, tone: string, title: string, to: string } | null}
 */
export function pillForLine(templateKey, index) {
  if (!index) return null;
  const keys = kitKeysForLine(templateKey);
  if (!keys.length) return null;
  if (keys.length === 1 && keys[0] === "reference") return referencePill(index);

  const states = keys.map((key) => itemState(key, index));
  const worst = [...states].sort((a, b) => WORST_FIRST(a.status, b.status) || String(a.expiresOn || "9999").localeCompare(String(b.expiresOn || "9999")))[0];
  const title = `Bid kit: ${states.map((s) => `${s.label} (${STATUS_LABEL[s.status] || s.status})`).join("; ")}`;
  const to = link(worst.id);

  // A paper signed fresh for each bid (the notarized full-time statement) is kept in the kit as a template. The kit holding
  // one never means this bid's copy is done.
  const entry = ITEM_BY_KEY[worst.key] || {};
  if (states.length === 1 && entry.notarized && ![STATUS.MISSING, STATUS.EXPIRED].includes(worst.status)) {
    return { text: "Kit: template on file", tone: "neutral", title: `${title}. A new one is signed and notarized for each bid.`, to };
  }
  if (worst.status === STATUS.EXPIRING) {
    const days = daysLeft(worst.expiresOn, index.today);
    const text = days === null ? "Kit: expiring soon" : days === 0 ? "Kit: expires today" : `Kit: expires in ${days} ${days === 1 ? "day" : "days"}`;
    return { text, tone: TONE[STATUS.EXPIRING], title, to };
  }
  return { text: WORDS[worst.status] || `Kit: ${STATUS_LABEL[worst.status] || worst.status}`, tone: TONE[worst.status] || "warn", title, to };
}
