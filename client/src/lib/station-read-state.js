// client/src/lib/station-read-state.js
//
// The note's station read on the Fast Complete sheet (GATE_STATION_FAST_COMPLETE)
// as one small state machine, and the table the station card shows from it.
//
// THE RULE: "all stations OK" is asserted (to the report writer, or to the
// record as a check for every station) only when the note's station read is
// KNOWN to have succeeded for the CURRENT note text, or the tech marked the
// stations by hand and confirmed it. The machine keeps
//  - `reads`: the last SUCCESSFUL read, for the one note whose marks are on the
//    sheet (a refresh in flight or failing never touches it, so that note stays
//    read; a successful read of other text replaces it);
//  - `attempt`: the read in flight or the last one that failed, for one note;
//  - `byHand`: the tech's hand check.
// The status of the current note is derived (readStatusFor): hand, ok, reading,
// failed, or none (not read yet; a changed note is none again).
const clean = (note) => String(note ?? '').trim();

export const INITIAL_READ_STATE = Object.freeze({ reads: {}, attempt: null, byHand: false });

const EVENTS = {
  // A changed note drops an attempt made for other text.
  noteChanged: (state, { note }) => (state.attempt && state.attempt.note !== clean(note) ? { ...state, attempt: null } : state),
  readStarted: (state, { note }) => ({ ...state, attempt: { note: clean(note), status: 'reading' } }),
  // Exactly ONE retained read: the note whose marks are applied now. A successful
  // read lands its marks over the earlier ones, so an older note's "ok" no longer
  // describes the marks on the sheet and is dropped (Codex P2 on #6205).
  readSucceeded: (state, { note }) => ({ ...state, reads: { [clean(note)]: 'ok' }, attempt: null }),
  // `detail` 'unresolved': the note was read but part of what it said about the
  // stations could not be pinned down, so it is not a clean read either.
  // A newer read that found something unplaced also withdraws an earlier clean read
  // of the same note: the stations are no longer known.
  readFailed: (state, { note, detail }) => {
    if (detail !== 'unresolved') return { ...state, attempt: { note: clean(note), status: 'failed' } };
    const { [clean(note)]: _withdrawn, ...reads } = state.reads;
    return { ...state, reads, attempt: { note: clean(note), status: 'unresolved' } };
  },
  handConfirmed: (state) => ({ ...state, byHand: true }),
  handCleared: (state) => ({ ...state, byHand: false }),
  // The property's stations changed under the sheet: nothing read or checked
  // against the old roster stands.
  rosterChanged: () => INITIAL_READ_STATE,
};

export function stationReadReducer(state, event) {
  const handler = EVENTS[event?.type];
  return handler ? handler(state, event) : state;
}

export function readStatusFor(state, note) {
  if (state.byHand) return 'hand';
  const text = clean(note);
  if (state.reads[text] === 'ok') return 'ok';
  return state.attempt && state.attempt.note === text ? state.attempt.status : 'none';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const flaggedText = (flagged) => `${flagged} flagged, the rest OK`;

// What the card shows and what holds Complete, per status: the summary line, the
// hold, whether the stations are KNOWN (chips are the answer), whether the card
// shows before a report exists, and which buttons.
export const READ_VIEW = {
  none: {
    known: false, warn: false, opensCard: false, handButton: true, undoButton: false, retryHint: false,
    summary: ({ count }) => `${plural(count, 'station')}. Not read from your note yet.`,
    hold: 'Your note hasn’t been read for the stations yet. Write the report again.',
  },
  reading: {
    known: false, warn: false, opensCard: false, handButton: false, undoButton: false, retryHint: false,
    summary: ({ count }) => `${plural(count, 'station')}. Reading your note…`,
    hold: 'Reading your note for the stations…',
  },
  failed: {
    known: false, warn: true, opensCard: true, handButton: true, undoButton: false, retryHint: true,
    summary: ({ count }) => `${plural(count, 'station')}. Couldn’t read them from your note.`,
    hold: 'Couldn’t read the stations from your note. Try again, or mark them by hand and tap “Stations checked by hand”.',
  },
  unresolved: {
    known: false, warn: true, opensCard: true, handButton: true, undoButton: false, retryHint: true,
    summary: ({ count }) => `${plural(count, 'station')}. Couldn’t match everything you said about them.`,
    hold: 'Couldn’t match everything you said about the stations. Mark them by hand and confirm.',
  },
  ok: {
    known: true, warn: false, opensCard: false, handButton: false, undoButton: false, retryHint: false,
    summary: ({ count, flagged }) => (flagged ? `${plural(count, 'station')}, ${flaggedText(flagged)}` : `${plural(count, 'station')}, all OK`),
    hold: '',
  },
  hand: {
    known: true, warn: false, opensCard: true, handButton: false, undoButton: true, retryHint: false,
    summary: ({ count, flagged }) => `${plural(count, 'station')}, checked by hand${flagged ? `, ${flaggedText(flagged)}` : ', all OK'}`,
    hold: '',
  },
};

// The card's one summary line: the registry first, then the read.
export function stationSummary({ registryState, hold, readStatus, count, flagged }) {
  if (registryState === 'loading') return 'Loading the stations…';
  return hold || READ_VIEW[readStatus].summary({ count, flagged });
}

// What the sheet says when a read did not succeed, by the server's detail.
export const READ_FAILED_MESSAGES = {
  unresolved: 'Couldn’t match everything you said about the stations. Mark them by hand and confirm.',
  roster_changed: 'The stations on this property changed, so they are loaded again. Try again.',
  default: 'Couldn’t read the stations from your note. Try again, or mark the stations by hand and confirm.',
};
