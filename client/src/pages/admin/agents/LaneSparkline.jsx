import React from "react";
import { Sparkline } from "../../../components/dashboard/charts";

// The lane card's activity line: calls per ET bucket (hourly for Today,
// daily for 7D / 30D) from the server's zero-filled spark series. Zinc
// stroke — the card's attention state is carried by its stripe and badge,
// never by the chart.

const ZINC_500 = "#71717A";

export default function LaneSparkline({ spark = [], width = 112, height = 22 }) {
  const series = spark.map((b) => ({ value: b?.calls ?? 0 }));
  const total = series.reduce((n, p) => n + p.value, 0);
  if (series.length < 2 || total === 0) {
    return <div className="h-[22px] w-[112px] border-b border-dashed border-zinc-200" aria-label="No activity in this window" />;
  }
  return <Sparkline series={series} width={width} height={height} stroke={ZINC_500} />;
}
