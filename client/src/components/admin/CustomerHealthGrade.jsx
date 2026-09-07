export default function CustomerHealthGrade({ grade, score }) {
  const recordedGrade = ["A", "B", "C", "D", "F"].includes(grade) ? grade : null;
  const description = recordedGrade
    ? `Health grade ${recordedGrade}${score == null ? "" : ` · score ${score}/100`}`
    : "Health grade not recorded";
  return <span
    className="inline-flex shrink-0 items-center justify-center rounded-sm border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-14 font-medium text-ink-secondary"
    aria-label={description}
    title={description}
  >{recordedGrade || "—"}</span>;
}
