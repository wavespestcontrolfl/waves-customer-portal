import { COLORS as B, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';
import { CHIP_QUESTIONS, NOT_SURE_LABEL, NOT_SURE_VALUE, PLANT_NAME_LIMIT } from './photoIdCopy';

// =========================================================================
// Tap-only subject chips for the lawn / tree-shrub / palm capture step
// (lawn-ts-photo-id-scope-20260927.md §5). Every question is optional —
// none required to submit — and every question offers "Not sure" alongside
// its real options. Selecting the already-selected option clears it (tap to
// toggle off), same as leaving it unanswered.
// =========================================================================

function ChipButton({ selected, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-glass={selected ? 'chip-selected' : 'chip'}
      style={{
        display: 'inline-flex', alignItems: 'center', minHeight: 40, padding: '7px 14px',
        borderRadius: 999, border: `1px solid ${selected ? B.glassNavy : SHELL.border}`,
        background: selected ? B.glassNavy : SHELL.surface,
        color: selected ? '#fff' : SHELL.text,
        fontSize: 15, fontWeight: 700, fontFamily: FONTS.body, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function ChipQuestion({ question, value, onChange }) {
  const pick = (optionValue) => onChange(question.key, value === optionValue ? null : optionValue);
  return (
    <div role="group" aria-label={question.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: SHELL.text }}>{question.label}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {question.options.map((opt) => (
          <ChipButton key={opt.value} selected={value === opt.value} onClick={() => pick(opt.value)}>
            {opt.label}
          </ChipButton>
        ))}
        <ChipButton selected={value === NOT_SURE_VALUE} onClick={() => pick(NOT_SURE_VALUE)}>
          {NOT_SURE_LABEL}
        </ChipButton>
      </div>
    </div>
  );
}

// `subject` is the picker's own value: 'lawn' | 'tree_shrub' | 'palm'.
// `answers` / `onAnswersChange` hold { [chipKey]: optionValue | NOT_SURE_VALUE }.
// `plantName` / `onPlantNameChange` are only used for tree_shrub / palm —
// there is no host-plant search yet (scope §5 / assignment), so a free-text
// field maps to `chips.plant_name`; `chips.plant_slug` always stays null.
export default function PhotoIdSubjectChips({ subject, answers, onAnswersChange, plantName, onPlantNameChange }) {
  const questions = CHIP_QUESTIONS[subject];
  if (!questions) return null;
  const showPlantName = subject === 'tree_shrub' || subject === 'palm';

  return (
    <div data-glass="soft" style={{
      borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 14,
      display: 'flex', flexDirection: 'column', gap: 16,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: SHELL.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        A few quick questions (optional)
      </div>
      {showPlantName && (
        <label style={{ display: 'block' }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: SHELL.text, marginBottom: 6 }}>
            {subject === 'palm' ? 'Palm, if you know it (optional)' : 'Plant, if you know it (optional)'}
          </span>
          <input
            type="text"
            value={plantName || ''}
            onChange={(e) => onPlantNameChange(e.target.value.slice(0, PLANT_NAME_LIMIT))}
            placeholder={subject === 'palm' ? 'e.g. Queen palm' : 'e.g. Hibiscus'}
            style={{
              width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '10px 12px', borderRadius: 8,
              border: `1px solid ${SHELL.borderStrong}`, background: SHELL.surface, color: SHELL.text,
              fontSize: 15, fontFamily: FONTS.body,
            }}
          />
        </label>
      )}
      {questions.map((q) => (
        <ChipQuestion key={q.key} question={q} value={answers[q.key] ?? null} onChange={onAnswersChange} />
      ))}
    </div>
  );
}
