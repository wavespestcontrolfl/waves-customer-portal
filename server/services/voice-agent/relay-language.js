/**
 * Session language for the inbound relay agent (GATE_VOICE_SPANISH_MENU).
 *
 * The language is decided ONCE, deterministically, by the caller pressing 2 in
 * the /voice vestibule; it rides the <Parameter name="lang"> into the setup
 * frame and RelayConversation carries it as `this.language`. Three things key
 * off it here, all in code rather than left to the model:
 *   - the prompt addendum that makes the model answer in Spanish,
 *   - the deterministic spoken closes (an LLM instruction does NOT translate a
 *     hard-coded English string handed straight to TTS — each close has a
 *     Spanish twin selected by session language),
 * The customer-level preference stamp lives in relay-conversation
 * (`_persistLanguagePreference`) and writes through lead-from-extraction's
 * ONE `stampCustomerPreferredLanguage` — never a sibling writer here.
 * English copy is byte-identical to before: `copy(key)` with no/English
 * language returns the exact prior string.
 */

function isSpanish(language) {
  return /^es(?:[-_]|$)/i.test(String(language || ''));
}

const LANGUAGE_ADDENDUM_ES = [
  '',
  'SESSION LANGUAGE: SPANISH. The caller chose Spanish on the keypad. Speak ONLY in natural,',
  'plain Spanish for the rest of the call — every reply, every question, every confirmation.',
  'Never switch to English unless the caller explicitly asks. Keep names, street addresses,',
  'and email addresses exactly as the caller says them. Numbers, dates, and times are spoken',
  'in Spanish. Tool results arrive in English — translate what you tell the caller.',
].join('\n');

// Deterministic closes spoken directly (no model in the loop). Keys mirror
// the call sites in relay-conversation.js; the English half is the prior
// literal, verbatim.
const COPY = {
  turnCap: {
    en: 'A Waves team member will follow up with you as soon as possible to take care of this. Thanks for calling!',
    es: 'Un miembro del equipo de Waves se comunicará con usted lo antes posible para atender esto. ¡Gracias por llamar!',
  },
  unavailable: {
    en: 'Sorry, I am unable to help right now. A team member will call you back.',
    es: 'Lo siento, no puedo ayudarle en este momento. Un miembro del equipo le devolverá la llamada.',
  },
  streamTimeout: {
    en: 'Sorry, that took a moment — could you say that again?',
    es: 'Disculpe, eso tomó un momento. ¿Podría repetirlo?',
  },
  modelError: {
    en: 'Sorry, I had trouble there. Could you say that again?',
    es: 'Disculpe, tuve un problema. ¿Podría repetirlo?',
  },
  toolRounds: {
    en: "Sorry — that's taking me longer than it should. I've made a note for the team to follow up. Is there anything else I can help with?",
    es: 'Disculpe, esto me está tomando más de lo debido. He dejado una nota para que el equipo le dé seguimiento. ¿Hay algo más en lo que pueda ayudarle?',
  },
};

function copy(key, language) {
  const entry = COPY[key];
  if (!entry) throw new Error(`relay-language: unknown copy key ${key}`);
  return isSpanish(language) ? entry.es : entry.en;
}

module.exports = { isSpanish, LANGUAGE_ADDENDUM_ES, COPY, copy };
