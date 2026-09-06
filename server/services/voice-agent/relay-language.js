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
  transferring: {
    en: 'Sure — let me connect you with a Waves team member now. One moment.',
    es: 'Claro, le comunico ahora con un miembro del equipo de Waves. Un momento.',
  },
  toolRounds: {
    en: "Sorry — that's taking me longer than it should. I've made a note for the team to follow up. Is there anything else I can help with?",
    es: 'Disculpe, esto me está tomando más de lo debido. He dejado una nota para que el equipo le dé seguimiento. ¿Hay algo más en lo que pueda ayudarle?',
  },
  // PR 2B — session recovery. `resumed` is the reconnected leg's welcome
  // greeting (spoken by Twilio before the socket opens); the other two are
  // the provider-failure handoff.
  resumed: {
    en: 'Sorry, I lost you for a second — where were we?',
    es: 'Disculpe, se cortó por un segundo. ¿En qué estábamos?',
  },

  writePending: {
    en: "Your request is still processing, so I can't confirm the result yet. Please don't repeat the request while it is pending. Is there anything else I can help with?",
    es: 'Su solicitud sigue en proceso, así que todavía no puedo confirmar el resultado. Por favor, no repita la solicitud mientras esté pendiente. ¿Hay algo más en lo que pueda ayudarle?',
  },
  troubleNoCallback: {
    en: "I'm having trouble pulling that up right now, and I couldn't save a callback either. Please call us back when you get a chance — thanks for calling.",
    es: 'Estoy teniendo problemas para acceder a eso y tampoco pude guardar una devolución de llamada. Por favor, llámenos de nuevo cuando pueda. Gracias por llamar.',
  },
  troubleCallback: {
    en: "I'm having trouble pulling that up. I've noted your number, and a Waves team member will call you back as soon as possible. Thanks for calling.",
    es: 'Estoy teniendo problemas para acceder a eso. He anotado su número y un miembro del equipo de Waves le devolverá la llamada lo antes posible. Gracias por llamar.',
  },
};

function copy(key, language) {
  const entry = COPY[key];
  if (!entry) throw new Error(`relay-language: unknown copy key ${key}`);
  return isSpanish(language) ? entry.es : entry.en;
}

module.exports = { isSpanish, LANGUAGE_ADDENDUM_ES, COPY, copy };
