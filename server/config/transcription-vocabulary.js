/**
 * Shared speech vocabulary — the proper nouns Waves' recognizers mishear.
 *
 * ONE list, three readers:
 *   1. Post-call transcription keyword hints (`call-recording-processor`, gpt-transcribe family)
 *   2. Live ConversationRelay `hints` attribute (`voice-agent/relay-profiles`, <= 2000 chars, no [<>"&])
 *   3. Staff field dictation word list (`dictation-word-list`)
 *
 * Original 16 entries stay first so capped readers preserve core brand/city coverage.
 */

const STT_HINTS = Object.freeze([
  // Core brand, products, and top SWFL cities (original 16)
  'Waves Pest Control', 'WaveGuard', 'Sentricon', 'Termidor', 'WDO',
  'Bradenton', 'Sarasota', 'Venice', 'Parrish', 'Palmetto', 'Ellenton',
  'Englewood', 'North Port', 'Port Charlotte', 'Lakewood Ranch', 'Myakka',
  // Additional SWFL service-area cities & communities frequently misheard
  'Osprey', 'Nokomis', 'Rotonda West', 'Punta Gorda', 'Longboat Key',
  'Siesta Key', 'Anna Maria', 'Holmes Beach', 'Bradenton Beach', 'Cortez',
  'Sun City Center', 'Ruskin', 'Apollo Beach', 'Wimauma', 'Myakka City',
  'University Park', 'Palmer Ranch', 'Wellen Park', 'Babcock Ranch',
  'Bayshore Gardens', 'South Venice',
  // Domain products, regulatory terms, Florida turf & pests
  'Bora-Care', 'FDACS', 'St. Augustine', 'Zoysia', 'Bahia', 'Floratam',
  'chinch bugs', 'mole crickets', 'palmetto bugs', 'whiteflies',
  'ghost ants', 'sugar ants', 'fire ants', 'no-see-ums', 'silverfish',
  'wood-destroying organism',
]);

// Compact spelling hint line for promptable ASR models (OpenAI gpt-transcribe & Gemini fallback).
const TRANSCRIPTION_DOMAIN_HINT_LINE = `Common Waves Pest Control proper nouns (use exact spelling when heard): ${STT_HINTS.slice(0, 42).join(', ')}.`;

/** The ConversationRelay `hints` attribute value (comma-separated phrases). */
function sttHintsCsv() {
  return STT_HINTS.join(',');
}

module.exports = { STT_HINTS, TRANSCRIPTION_DOMAIN_HINT_LINE, sttHintsCsv };
