// The note's station read for one visit, as the state machine in
// lib/station-read-state.js. The ref moves with the state: the report write
// reads it in the same breath that a read settles.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { INITIAL_READ_STATE, readStatusFor, stationReadReducer } from '../lib/station-read-state';

export default function useStationReadState(note) {
  const [state, dispatch] = useReducer(stationReadReducer, INITIAL_READ_STATE);
  const stateRef = useRef(state);
  const noteRef = useRef(note);
  noteRef.current = note;
  // Both apply the same pure reducer to the same events, so they agree.
  const send = useCallback((event) => {
    stateRef.current = stationReadReducer(stateRef.current, event);
    dispatch(event);
  }, []);
  useEffect(() => { send({ type: 'noteChanged', note }); }, [note, send]);
  return {
    status: readStatusFor(state, note),
    send,
    // The status of the CURRENT note right now, for calls that land after a render.
    statusNow: () => readStatusFor(stateRef.current, noteRef.current),
  };
}
