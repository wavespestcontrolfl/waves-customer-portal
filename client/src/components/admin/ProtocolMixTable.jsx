import React from "react";
import { mixTable } from "../../lib/protocol-mix-amounts";

function productMatchForRow(row, products) {
  if (row && Object.prototype.hasOwnProperty.call(row, "productId")) {
    return row.productId ? products.find((p) => String(p?.id) === String(row.productId)) || null : null;
  }
  const target = String(row?.product || "").trim().toLowerCase();
  if (!target) return null;
  const exactMatches = products.filter(
    (p) => String(p?.name || "").trim().toLowerCase() === target,
  );
  return exactMatches.length === 1 ? exactMatches[0] : null;
}

function rowWarningInfo(row, products) {
  const liveCard = Array.isArray(products);
  const match = liveCard ? productMatchForRow(row, products) : null;
  const missingCheck = liveCard && !match && !row?.labelRateMissing && Boolean(row?.perGallon || row?.dose);
  const rawParts = [
    row?.labelWarning,
    ...(Array.isArray(row?.calibrationWarnings) ? row.calibrationWarnings : []),
    match?.amountNote,
    match?.verdict && match.verdict !== "ok" ? match.verdictReason : null,
    match?.verdictAction,
    missingCheck ? "Product check unavailable on this Job Card — verify spray check and label before mixing." : null,
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const parts = rawParts.filter(
    (s, i) => !rawParts.some((other, j) => j !== i && (other === s ? j < i : other.includes(s))),
  );
  if (!parts.length) return null;
  return {
    isHold: match?.verdict === "hold",
    text: parts.join(" · "),
  };
}

// The card's mix amounts: one row per product, one column per sprayer the card uses. `sprayers`: the card's own tanks
// (Tree & Shrub), else the pest cards' three. A row's `condition` is the visit's own "only if" line.
export default function ProtocolMixTable({ mixRates, sprayers, products = null }) {
  const { rows, columns } = mixTable(mixRates, sprayers);
  if (!rows.length) return null;
  return (
    <div className="mb-3 rounded-sm border-hairline border-zinc-200 overflow-hidden">
      <div className="text-11 font-medium u-label text-ink-tertiary px-3 py-1.5 bg-zinc-50 border-b border-hairline border-zinc-200">
        Mix Amounts
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-12 text-ink-primary">
          <thead>
            <tr className="text-left text-11 text-ink-tertiary">
              <th scope="col" className="px-3 py-1.5 font-medium">Product</th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className="px-3 py-1.5 font-medium whitespace-nowrap">{column.label}</th>
              ))}
              <th scope="col" className="px-3 py-1.5 font-medium">Spray volume, placement, limit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.product}-${index}`} className="border-t border-hairline border-zinc-100 align-top">
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  <div className="font-medium">{row.product}</div>
                  {row.condition ? <div>{row.condition}</div> : null}
                  <div className="text-ink-tertiary">{row.where}</div>
                </th>
                {columns.map((column) => (
                  <td key={column.key} className="px-3 py-1.5 font-mono u-nums whitespace-nowrap">
                    {row.amounts[column.key] || "—"}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-ink-secondary">
                  {(() => {
                    const warning = rowWarningInfo(row, products);
                    return warning ? (
                      <div role="alert" className={warning.isHold ? "text-alert-fg font-medium" : "text-warn-fg font-medium"}>
                        Warning: {warning.text}
                      </div>
                    ) : null;
                  })()}
                  {row.labelRateMissing ? <div className="text-alert-fg">Label rate not on file</div> : null}
                  {row.dose ? <div>Dose, not a tank mix: <span className="font-mono u-nums">{row.dose}</span></div> : null}
                  {row.note ? <div>{row.note}</div> : null}
                  {row.sprayVolume ? <div>{row.sprayVolume}</div> : null}
                  {row.limit ? <div className="text-ink-tertiary">{row.limit}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
