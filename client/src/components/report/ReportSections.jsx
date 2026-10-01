// The four-section AI service report (GATE_REPORT_WRITER_RULES, owner "ok
// go" 2026-10-01): What we found / What we did and why / What to expect /
// What's next, rendered with its own titles wherever the report's text
// would otherwise print as one paragraph. The payload's `reportSections`
// are the server's screened parse; a surface swaps its paragraph for them
// only when the text it was about to print IS that report, so a recap, a
// narrative or a template keeps its paragraph.

const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export function reportSectionsForText(sections, text) {
  if (!Array.isArray(sections) || !sections.length) return null;
  const joined = normalize(sections.map((section) => (section?.paragraphs || []).join(' ')).join(' '));
  return joined && joined === normalize(text) ? sections : null;
}

// `text` renders as before (one paragraph) unless `sections` match it.
// `nextVisitLabel` (live view only: the next booked visit on this report's
// own service line) opens "What's next".
export default function ReportText({
  text, sections = null, nextVisitLabel = null, className, style, titleStyle,
}) {
  const matched = reportSectionsForText(sections, text);
  if (!matched) return text ? <p className={className} style={style}>{text}</p> : null;
  return (
    <div data-report-sections="">
      {matched.map((section) => (
        <div key={section.key}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: '14px 0 4px', ...titleStyle }}>{section.title}</h3>
          {section.key === 'whatsNext' && nextVisitLabel ? (
            <p className={className} style={{ ...style, margin: '0 0 8px', fontWeight: 600 }}>Next visit: {nextVisitLabel}</p>
          ) : null}
          {(section.paragraphs || []).map((paragraph, index) => (
            <p key={index} className={className} style={{ ...style, margin: '0 0 8px' }}>{paragraph}</p>
          ))}
        </div>
      ))}
    </div>
  );
}
