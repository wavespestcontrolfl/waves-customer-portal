/**
 * <NamedSearchesTable> — the eight-search scoreboard on the SEO page's
 * Geo-Grid view: the four priority cities × pest and lawn, with the map-pack
 * position in the latest scan and the change since last month.
 *
 * Pure presentational over the /admin/seo/geo-grid/named-searches response.
 * It reads stored scans only; nothing here starts a scan.
 */
import { Card as UiCard, Table, TBody, TD, TH, THead, TR } from "../ui";

const UP = "#15803D";
const DOWN = "#991B1B";
const FLAT = "#71717A";

function shortDate(ymd) {
  const [, m, d] = String(ymd || "").split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : "";
}

// What changed between the baseline scan and the latest one, in words the
// table can show without a legend. Positive positionChange = moved up.
export function describeChange(search) {
  const { current, baseline, positionChange } = search;
  if (!current) return { text: "—", color: FLAT };
  if (!baseline) return { text: "No scan a month back yet", color: FLAT };
  const since = `since ${shortDate(baseline.scanDate)}`;
  if (current.position == null && baseline.position == null)
    return { text: `Still not in the pack ${since}`, color: FLAT };
  if (baseline.position == null)
    return { text: `New in the pack ${since}`, color: UP };
  if (current.position == null)
    return { text: `Dropped out of the pack ${since}`, color: DOWN };
  if (!positionChange)
    return { text: `No change ${since} (was ${baseline.position})`, color: FLAT };
  const places = Math.abs(positionChange);
  return positionChange > 0
    ? { text: `Up ${places} ${since} (was ${baseline.position})`, color: UP }
    : { text: `Down ${places} ${since} (was ${baseline.position})`, color: DOWN };
}

function positionText(search) {
  const { current } = search;
  if (!current) return "—";
  if (current.position == null) return "Not in the pack";
  return String(current.position);
}

// Each row carries its own scan date: a manual scan covers one office and
// keyword, so the eight rows can be different ages. A keyword that has left
// the scan list keeps its old numbers but says they will not update.
export function scannedText(search) {
  const { current, tracked, keyword } = search;
  const untracked = `add "${keyword}" under Edit keywords`;
  if (!current) return tracked ? "Not scanned yet" : `Not tracked: ${untracked}`;
  const date = shortDate(current.scanDate);
  return tracked ? date : `${date}, no longer tracked: ${untracked}`;
}

export default function NamedSearchesTable({ data }) {
  const searches = data?.searches || [];
  if (!searches.length) return null;
  const anyScan = searches.some((s) => s.current);
  return (
    <UiCard className="p-6 [margin-bottom:16px]">
      <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
        Eight searches we watch
      </div>
      <div className="text-ui-body text-ink-secondary [margin-bottom:12px]">
        Average map position across the points around each office where we
        show up. Lower is better.{" "}
        {data?.gated
          ? anyScan
            ? "The weekly scan is off (GATE_GEO_GRID), so these numbers will not update."
            : "The weekly scan is off (GATE_GEO_GRID), so there is nothing to show yet."
          : anyScan
            ? ""
            : "No scan has finished yet."}
      </div>
      <div className="overflow-x-auto">
        <Table className="[width:100%] [border-collapse:collapse]">
          <THead>
            <TR>
              <TH>Search</TH>
              <TH className="text-right u-nums">Position</TH>
              <TH className="text-right u-nums">In top 3</TH>
              <TH>Change since last month</TH>
              <TH>Scanned</TH>
            </TR>
          </THead>
          <TBody>
            {searches.map((s) => {
              const change = describeChange(s);
              return (
                <TR key={`${s.officeId}-${s.keyword}`} data-named-search>
                  <TD className="font-medium">{s.label}</TD>
                  <TD
                    className={
                      s.current?.position != null
                        ? "text-right u-nums"
                        : "text-right text-ink-secondary"
                    }
                  >
                    {positionText(s)}
                  </TD>
                  <TD className="text-right u-nums">
                    {s.current
                      ? `${s.current.top3Pct}% of ${s.current.pins} points`
                      : "—"}
                  </TD>
                  <TD style={{ color: change.color }}>{change.text}</TD>
                  <TD className={s.tracked && s.current ? "u-nums" : "text-ink-secondary"}>
                    {scannedText(s)}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </UiCard>
  );
}
