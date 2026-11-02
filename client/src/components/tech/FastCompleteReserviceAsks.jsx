// client/src/components/tech/FastCompleteReserviceAsks.jsx
//
// The "They told us" block on the re-service Fast Complete sheets (step S2b of the consolidated re-service
// report, owner 2026-11-02, GATE_RESERVICE_ASKS): everything the customer said about the problem, one card per
// item, one tap each to say what the tech did about it. The schedule row's `reserviceAsksEnabled` turns it on;
// off, `useReserviceAsks` reads nothing, draws nothing and adds nothing to the /complete body.
//
// useReserviceAsks reads GET /admin/dispatch/:id/reservice-asks and holds the answers. The sheet spreads
// `asks.field()` into its /complete body, shows `asks.hold` as the reason Complete waits, and draws the block
// with <FastCompleteReserviceAsks asks={asks} />. The rules (labels, wording, what is a complete answer, the body
// field) are lib/fast-complete-reservice-asks.js, mirroring server/services/reservice-answers.js.
//
// A read that fails for any reason but "gate off" (404) or "not a re-service" (409) shows a notice with Retry and
// never holds Complete: the server gathers the asks again at Complete and the answers are optional there. A read
// still out after ASKS_READ_TIMEOUT_MS (a stalled phone connection; the sheets' request helper has no timeout of its
// own) counts as failed the same way, and its late answer is ignored.
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  ASKS_LOADING_HOLD, ASKS_LOAD_FAILED, NEEDS_PRODUCT_HINT, MAX_ANSWER_TEXT, MAX_REASON_TEXT, NOT_ABOUT_ANSWER, PROBLEM_ANSWERS,
  answerTextProblem, asksEyebrow, asksHold, asksItemsFrom, itemLabel, itemWords, orderedChoices, productChoicesFrom, prunedAnswer,
  reasonProblem, reserviceAnswersField,
} from '../../lib/fast-complete-reservice-asks';
import { Button, Input } from '../ui';
import { Chip } from './FastCompleteParts';
import '../../styles/tech-workflow.css';

const NO_ITEMS = [];
export const ASKS_READ_TIMEOUT_MS = 12000;
const NO_ANSWER = Object.freeze({ answer: null, productIds: [], reason: '', text: '' });

// `service`: the schedule row; its `reserviceAsksEnabled` is the flag. `rows`: the sheet's product rows (the active
// ones are what "Treated" offers).
export function useReserviceAsks({ service, request, rows, readTimeoutMs = ASKS_READ_TIMEOUT_MS }) {
  const on = service?.reserviceAsksEnabled === true;
  const base = `/admin/dispatch/${service?.id}`;
  const [load, setLoad] = useState({ status: on ? 'loading' : 'off', items: NO_ITEMS });
  const [attempt, setAttempt] = useState(0);
  const [answers, setAnswers] = useState({});

  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    setLoad({ status: 'loading', items: NO_ITEMS });
    const timer = setTimeout(() => {
      if (!alive) return;
      alive = false;
      setLoad({ status: 'error', items: NO_ITEMS });
    }, readTimeoutMs);
    Promise.resolve()
      .then(() => request(`${base}/reservice-asks`))
      .then((data) => {
        if (!alive) return;
        const items = asksItemsFrom(data);
        setLoad(items.length ? { status: 'loaded', items } : { status: 'none', items: NO_ITEMS });
      })
      .catch((err) => {
        if (!alive) return;
        // 404 {enabled:false}: the gate is off. 409: no longer a re-service. Either way, no block.
        setLoad({ status: err?.status === 404 || err?.status === 409 ? 'none' : 'error', items: NO_ITEMS });
      })
      .finally(() => clearTimeout(timer));
    return () => { alive = false; clearTimeout(timer); };
  }, [on, base, request, attempt, readTimeoutMs]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const choices = useMemo(() => productChoicesFrom(rows), [rows]);
  const availableIds = useMemo(() => new Set(choices.map((choice) => choice.id)), [choices]);
  // A product row taken off the sheet leaves every pick for good: putting it back does not revive the pick.
  useEffect(() => {
    setAnswers((prev) => {
      let changed = false;
      const next = {};
      for (const [id, answer] of Object.entries(prev)) {
        next[id] = prunedAnswer(answer, availableIds);
        if (next[id] !== answer) changed = true;
      }
      return changed ? next : prev;
    });
  }, [availableIds]);
  const setAnswer = useCallback((id, patch) => {
    setAnswers((prev) => ({ ...prev, [id]: { ...NO_ANSWER, ...prev[id], ...patch } }));
  }, []);

  const items = load.status === 'loaded' ? load.items : NO_ITEMS;
  let hold = '';
  if (load.status === 'loading') hold = ASKS_LOADING_HOLD;
  else if (load.status === 'loaded') hold = asksHold({ items, answers, availableIds });
  return {
    enabled: on,
    status: load.status,
    items,
    answers,
    choices,
    availableIds,
    setAnswer,
    retry,
    hold,
    // The /complete body's part: nothing unless the block loaded at least one item.
    field: () => (load.status === 'loaded' ? reserviceAnswersField({ items, answers, availableIds }) : {}),
  };
}

// Folds the block's hold into a sheet's own missing-requirement reason: the sheet's reasons come first.
export const withAsksHold = (reason, asks) => reason || asks?.hold || '';
// The same for a { reason, ...} hold object (the report flow's): the object is returned as it is unless the block is what holds.
export const heldByAsks = (missing, asks) => (missing.reason || !asks.hold ? missing : { ...missing, reason: asks.hold });

export default function FastCompleteReserviceAsks({ asks, locked = false }) {
  if (!asks?.enabled) return null;
  if (asks.status === 'loading') {
    return <p className="tech-visit-muted" role="status">{ASKS_LOADING_HOLD}</p>;
  }
  if (asks.status === 'error') {
    return (
      <section className="tech-visit-choice-section" aria-label="They told us">
        <p className="tech-visit-feedback" role="status">{ASKS_LOAD_FAILED}</p>
        <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" disabled={locked} onClick={asks.retry}>Retry</Button>
      </section>
    );
  }
  if (asks.status !== 'loaded' || !asks.items.length) return null;
  return (
    <section className="tech-visit-choice-section" aria-label="They told us">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">{asksEyebrow(asks.items.length)}</h3>
      </div>
      {asks.items.map((item) => (
        <AskItem
          key={item.id}
          item={item}
          answer={prunedAnswer(asks.answers[item.id], asks.availableIds) || NO_ANSWER}
          choices={asks.choices}
          locked={locked}
          onChange={(patch) => asks.setAnswer(item.id, patch)}
        />
      ))}
    </section>
  );
}

function AskItem({ item, answer, choices, locked, onChange }) {
  const labelId = useId();
  const wordsId = useId();
  const question = item.kind === 'question';
  const pick = (kind) => onChange({ answer: answer.answer === kind ? null : kind });
  return (
    <div className="tech-wrapup-block" role="group" aria-labelledby={labelId} aria-describedby={wordsId}>
      <span id={labelId} className="tech-product-editor-label">{itemLabel(item)}</span>
      <p id={wordsId}>{itemWords(item)}</p>
      {question ? (
        <QuestionAnswer answer={answer} locked={locked} onChange={onChange} onNotAbout={() => pick(NOT_ABOUT_ANSWER.answer)} />
      ) : (
        <>
          <div className="tech-visit-tile-grid">
            {PROBLEM_ANSWERS.map(({ answer: kind, label }) => (
              <Chip
                key={kind}
                label={label}
                pressed={answer.answer === kind}
                disabled={locked || (kind === 'treated' && !choices.length)}
                onClick={() => pick(kind)}
              />
            ))}
          </div>
          {!choices.length && <p className="tech-visit-muted">{NEEDS_PRODUCT_HINT}</p>}
          {answer.answer === 'treated' && <TreatedProducts item={item} answer={answer} choices={choices} locked={locked} onChange={onChange} />}
          {answer.answer === 'not_today' && <NotTodayReason answer={answer} locked={locked} onChange={onChange} />}
        </>
      )}
    </div>
  );
}

function TreatedProducts({ item, answer, choices, locked, onChange }) {
  const ordered = useMemo(() => orderedChoices(choices, item.pests), [choices, item.pests]);
  const picked = new Set(answer.productIds.map(String));
  const toggle = (id) => {
    const next = picked.has(id) ? answer.productIds.filter((value) => String(value) !== id) : [...answer.productIds, id];
    onChange({ productIds: next });
  };
  return (
    <div role="group" aria-label="Products used for this item">
      <span className="tech-product-editor-label">Which product?</span>
      <div className="tech-visit-tile-grid">
        {ordered.map((choice) => (
          <Chip key={choice.id} label={choice.name} pressed={picked.has(choice.id)} disabled={locked} onClick={() => toggle(choice.id)} />
        ))}
      </div>
    </div>
  );
}

function NotTodayReason({ answer, locked, onChange }) {
  const id = useId();
  const problem = reasonProblem(answer.reason);
  return (
    <div>
      <label htmlFor={id} className="tech-product-editor-label">Why not today? (office only)</label>
      <Input id={id} className="tech-visit-control" type="text" maxLength={MAX_REASON_TEXT} value={answer.reason} disabled={locked} onChange={(e) => onChange({ reason: e.target.value })} />
      {problem && <p className="tech-visit-feedback" role="alert">{problem}</p>}
    </div>
  );
}

function QuestionAnswer({ answer, locked, onChange, onNotAbout }) {
  const id = useId();
  const problem = answerTextProblem(answer.text);
  const typed = (value) => onChange({ text: value, answer: value.trim() ? 'answered' : (answer.answer === 'answered' ? null : answer.answer) });
  return (
    <>
      <div>
        <label htmlFor={id} className="tech-product-editor-label">Your answer</label>
        <Input id={id} className="tech-visit-control" type="text" maxLength={MAX_ANSWER_TEXT} value={answer.text} disabled={locked} onChange={(e) => typed(e.target.value)} />
        {problem && <p className="tech-visit-feedback" role="alert">{problem}</p>}
      </div>
      <div className="tech-visit-tile-grid">
        <Chip label={NOT_ABOUT_ANSWER.label} pressed={answer.answer === NOT_ABOUT_ANSWER.answer} disabled={locked} onClick={onNotAbout} />
      </div>
    </>
  );
}
