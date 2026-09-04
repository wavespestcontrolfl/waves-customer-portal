/**
 * Shared speech vocabulary — the proper nouns Waves' recognizers mishear.
 *
 * ONE list, two readers: the post-call transcription keyword hints
 * (call-recording-processor, gpt-transcribe family) and the live
 * ConversationRelay `hints` attribute (voice-agent/relay-profiles). A place
 * name or product added for one reaches the other; a term dropped here is
 * dropped everywhere. These are the terms prod transcripts have actually
 * misheard — service-area place names ("Englewood" → "Inglewood") and
 * product/brand terms — not a general dictionary.
 */

const STT_HINTS = Object.freeze([
  'Waves Pest Control', 'WaveGuard', 'Sentricon', 'Termidor', 'WDO',
  'Bradenton', 'Sarasota', 'Venice', 'Parrish', 'Palmetto', 'Ellenton',
  'Englewood', 'North Port', 'Port Charlotte', 'Lakewood Ranch', 'Myakka',
]);

/** The ConversationRelay `hints` attribute value (comma-separated phrases). */
function sttHintsCsv() {
  return STT_HINTS.join(',');
}

module.exports = { STT_HINTS, sttHintsCsv };
