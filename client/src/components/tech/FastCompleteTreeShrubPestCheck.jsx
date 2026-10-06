// client/src/components/tech/FastCompleteTreeShrubPestCheck.jsx
//
// The "Live insects found?" block on the Tree & Shrub Fast Complete sheet
// (GATE_TS_PEST_CHECK, owner 2026-10-05). The block shows only when the fast
// context carries `pestCheck` (gate on). Unanswered is allowed and never
// blocks Complete. The one block: Yes with armored scale and no soft scale or
// whitefly, while Merit is on the visit. Rules live in lib/tree-shrub-pest-check.js.
import React, { useCallback, useMemo, useState } from 'react';
import { Button } from '../ui';
import { Chip, ChoiceSection, toggleInSet } from './FastCompleteParts';
import { INSECT_TYPES, evaluatePestCheck, pestCheckPayload } from '../../lib/tree-shrub-pest-check';

// state: { enabled, found, types, evaluation, payload, setFound, toggleType }.
// `types` is the lib's list of { key, label }; the server's list wins when it sends one.
export function usePestCheck({ context, rows }) {
  const enabled = !!context && typeof context === 'object';
  const [found, setFoundState] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const types = useMemo(() => {
    const sent = Array.isArray(context?.insectTypes) ? context.insectTypes : [];
    const known = new Map(INSECT_TYPES.map((type) => [type.key, type]));
    const fromServer = sent.map((type) => known.get(type?.key)).filter(Boolean);
    return fromServer.length ? fromServer : INSECT_TYPES;
  }, [context]);
  const setFound = useCallback((value) => {
    setFoundState((prev) => (prev === value ? null : value));
  }, []);
  const toggleType = useCallback((key) => setPicked((prev) => toggleInSet(prev, key)), []);
  const answer = useMemo(() => ({ found, types: [...picked] }), [found, picked]);
  const evaluation = useMemo(
    () => (enabled ? evaluatePestCheck(answer, rows) : { blockMessage: '', noteMessages: [], meritRows: [] }),
    [enabled, answer, rows],
  );
  const payload = enabled ? pestCheckPayload(answer) : null;
  return { enabled, found, picked, types, evaluation, payload, setFound, toggleType };
}

export function PestCheckSection({ state, locked, onRemoveMerit }) {
  if (!state.enabled) return null;
  const { found, picked, types, evaluation } = state;
  return (
    <>
      <ChoiceSection title="Live insects found?" columns={2}>
        <Chip disabled={locked} label="Yes" pressed={found === true} onClick={() => state.setFound(true)} />
        <Chip disabled={locked} label="No" pressed={found === false} onClick={() => state.setFound(false)} />
      </ChoiceSection>
      {found === true && (
        <ChoiceSection title="Which insects?" columns={2}>
          {types.map((type) => (
            <Chip disabled={locked} key={type.key} label={type.label} pressed={picked.has(type.key)} onClick={() => state.toggleType(type.key)} />
          ))}
        </ChoiceSection>
      )}
      {evaluation.blockMessage && (
        <>
          <p className="tech-visit-muted tech-visit-status--warn" role="alert">{evaluation.blockMessage}</p>
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" disabled={locked} onClick={() => onRemoveMerit(evaluation.meritRows)}>
            Remove Merit from this visit
          </Button>
        </>
      )}
      {evaluation.noteMessages.map((message) => (
        <p key={message} className="tech-visit-muted" role="status">{message}</p>
      ))}
    </>
  );
}
