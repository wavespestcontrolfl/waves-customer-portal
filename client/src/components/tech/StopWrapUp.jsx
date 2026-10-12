// client/src/components/tech/StopWrapUp.jsx
//
// The Wrap-up of the grouped pest + lawn stop (FastCompleteComboSheet; GATE_FAST_COMPLETE_WRAP_UP and
// GATE_COMBO_FAST_COMPLETE both on, owner 2026-10-12): ONE section for the whole stop, above "Complete stop".
// Rows: one Time on-site clock, Send completion text, Send review request with its timing, and the next visit
// (shown only). No pay-link row, no time correction and no re-entry steppers: the packet sends one text for the
// stop whose pay link follows the stop's invoice, and records time and re-entry per service, so those stay on the
// full form. The parts are unchanged: each still hands over today's fixed bodies and shows no Wrap-up.
//
// The stop's choices reach the server through fields the packet already reads (see lib/fast-complete-wrap-up.js
// stopWrapUpFields): the container lays them onto BOTH item bodies at send (hooks/useComboStop.js). Untouched, it
// lays nothing, so the packet is exactly today's.
import React, { useCallback, useMemo, useState } from 'react';
import FastCompleteWrapUp, { useWrapUp } from './FastCompleteWrapUp';
import { firstMemberId, stopWrapUpFields, wrapUpBilling } from '../../lib/fast-complete-wrap-up';

// Each part reports its latest context's answer (true or false) while it is mounted, and null when it leaves. The section
// is on only while at least one part reports and every part that reports says true: a part that says false (a gate turned
// off under a part that remounted, or one still loading) closes it, and a part that is not mounted (restored from the
// saved draft) grants nothing. `withdrawn`: some part's latest answer is false.
function useWrapUpGates() {
  const [answers, setAnswers] = useState({});
  const reporters = useMemo(() => Object.fromEntries(['pest', 'lawn'].map((kind) => [kind, (on) => setAnswers((cur) => {
    if (on === null) return Object.fromEntries(Object.entries(cur).filter(([key]) => key !== kind));
    return cur[kind] === on ? cur : { ...cur, [kind]: on };
  })])), []);
  const list = Object.values(answers);
  return { live: list.length > 0 && list.every(Boolean), withdrawn: list.some((on) => on === false), reporters };
}

// The service whose billing facts the review hint reads: the first part that bills (the stop's one invoice holds the
// review until it is paid), else the pest part.
const billingServiceOf = (pest, lawn) => [pest, lawn].find((service) => wrapUpBilling(service).reviewAwaitsPayment) || pest;
// The service the Automatic review send time is previewed for: the packet enrolls the review from its first member (window
// start, then id), whichever part bills. `rows`: the stop's loaded schedule rows.
const reviewServiceOf = (pest, lawn, rows) => [pest, lawn].find((service) => service.id === firstMemberId(rows)) || pest;

// `open`: the stop is loaded, is still this pair, and has not been sent. `report(key, on)`: the container's work-in-flight
// counter, so the check holds Close, Complete stop and the parts like any other work. `fieldsRef`: read at send by
// useStopSend. `submit(send)`: the review check, then the send.
export function useStopWrapUp({ pest, lawn, rows, request, open, report, fieldsRef }) {
  const { live, withdrawn, reporters } = useWrapUpGates();
  const onChecking = useCallback((busy) => report('stop-wrap-up', busy), [report]);
  const service = billingServiceOf(pest.service, lawn.service);
  const wrapUp = useWrapUp({
    gate: live && open, service, reviewService: reviewServiceOf(pest.service, lawn.service, rows), request, base: `/admin/dispatch/${pest.service.id}`,
    omitAutoTiming: true, noPayLink: true, noAdjustTime: true, noReentry: true, onChecking,
  });
  // null: not shown (the saved bodies go as saved); {}: shown at its defaults, or withdrawn because a part's latest context
  // says the gate is off (the parts' own bodies go, no overlay); else the choices.
  fieldsRef.current = () => {
    if (wrapUp.enabled) return wrapUp.touched ? stopWrapUpFields(wrapUp.fields({})) : {};
    return withdrawn ? {} : null;
  };
  // A replay of an attempt whose outcome is unknown goes as it went: no fresh-submit check (the preview re-read could block
  // it or change what must not change), as the other sheets skip it for a stored attempt.
  const submit = async (send) => {
    if (!send.replaying && wrapUp.needsCheck() && !(await wrapUp.check())) return;
    await send.submit();
  };
  return { wrapUp, gates: reporters, since: pest.service.onSiteAt || lawn.service.onSiteAt, submit };
}

// The section, locked while the stop is busy (its review check included).
export function StopWrapUpSection({ stop, disabled }) {
  if (!stop.wrapUp.enabled) return null;
  return (
    <fieldset className="tech-visit-form" disabled={disabled}>
      <FastCompleteWrapUp wrapUp={stop.wrapUp} />
    </fieldset>
  );
}
