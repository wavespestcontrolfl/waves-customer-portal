// Share the directory's existing score-ring treatment across customer rows.
export default function CustomerHealthGrade({ score, label = "Health score" }) {
  const recorded = typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;
  const value = recorded ? Math.round(score) : null;
  const description = recorded ? `${label}: ${value}/100` : `${label} not recorded`;
  const stroke = value >= 70 ? "#10B981" : value >= 40 ? "#F59E0B" : "#C8312F";
  const circumference = 2 * Math.PI * 15;
  return <svg width={36} height={36} viewBox="0 0 36 36" role="img" aria-label={description} className="shrink-0">
    <title>{description}</title>
    <circle cx={18} cy={18} r={15} fill="none" stroke="#E4E4E7" strokeWidth={2} />
    {recorded && <circle cx={18} cy={18} r={15} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} strokeLinecap="round" transform="rotate(-90 18 18)" />}
    <text x={18} y={23} textAnchor="middle" fill="#27272A" fontSize={14} fontWeight={500} fontFamily="ui-monospace, monospace">{value ?? "—"}</text>
  </svg>;
}
