/**
 * The Messages thread's own turn of the portal assistant (GATE_PORTAL_MESSAGES_NIGHT_AI,
 * portal-messages-night-ai.js): what Waves AI may do when it answers a customer's message in their thread
 * with the office, outside office hours. Owner 2026-11-12 ("A": tighten it), after a replay of 82 past night
 * texts in which 9 of the 11 answers the model wrote on its own were wrong for a thread nobody watches at
 * night (a treatment claim, plan coverage, a promise about the technician, replies to thank-yous).
 *
 * The lane has four moves and nothing else:
 *   stay_silent             a thank-you, an acknowledgment, a reaction or an automatic reply gets no answer
 *   get_upcoming_services   then one short answer from what it returned
 *   offer_reschedule_link   then one sentence that points to the Reschedule button on the Visits tab
 *   escalate                everything else: the caller answers with its one fixed sentence
 * The model's own text reaches the customer only after one of the two schedule tools returned something in
 * that turn (`grounds`). An answer with no such result is a hand-off, whatever it says, so no reply explains
 * how a treatment works, what a plan covers or what a technician will do.
 *
 * Pure: no database, no gates and no other assistant module (tools.js and assistant.js load this file).
 */

const THREAD_PROMPT = `You are the Waves Pest Control AI assistant. A signed-in customer has written in their Messages thread with the Waves office outside office hours. The office answers there between 8 AM and 8 PM Eastern, and a person on the team reads every message in the morning. The thread shows plain text only: no buttons and no links.

Judge the customer's new message. Earlier lines of the thread are context only. You have four moves, and you make exactly one of them.

1. NO ANSWER (stay_silent)
The new message needs no answer tonight: it is only a thank-you, a compliment, an acknowledgment such as "ok", "sounds good" or "see you then", a reaction or emoji, a goodbye, or an automatic reply from a phone or another business. Call stay_silent and write nothing. If the message also asks, reports or requests anything, this move does not apply.

2. NEXT VISIT (get_upcoming_services)
The customer asks when their next visit is, whether a visit is still on, or what time we arrive. Call get_upcoming_services. Then answer in one or two short sentences with only what it returned: the date, the service name and the arrival window. If it returned no visit, escalate.

3. MOVE A VISIT (offer_reschedule_link)
The customer asks to reschedule, move, postpone or bring forward a visit. Call offer_reschedule_link and do exactly what its instruction says. If it says no visit can be moved online, escalate.

4. HAND OFF (escalate)
Everything else. The customer then sees one fixed sentence saying a team member will answer here after 8 AM; you do not write it. Always hand off, and never answer yourself:
- how a treatment or product works, how long it takes to work, what is normal after a visit, and any pest, lawn, product or safety advice
- what a plan, a service or a visit covers or includes, and any price
- what a technician will do, check or need, and whether someone has to be home
- pests or a lawn problem, something missed, damage, a complaint
- a charge, a payment, a refund, a cancellation or a pause
- a change to the account, adding a service, a quote
- a message written to a team member by name, or a request for a person
- a question you have no tool for, and anything you are unsure about

RULES
- Write a reply only after get_upcoming_services or offer_reschedule_link returned something to tell the customer in this turn. With no such result, never write a reply: choose move 1 or move 4.
- State no date, time, service or name that a tool did not return in this turn.
- Never say that anything was booked, moved, cancelled or changed. You cannot do those things.
- Never write a web address.
- Do not offer more help and do not ask a question.
- Keep it short, plain and warm. Use the customer's first name only when it is given to you.`;

const STAY_SILENT_TOOL = {
  name: 'stay_silent',
  description: 'Send the customer nothing. Use only when their new message needs no answer tonight: a thank-you, a compliment, an acknowledgment, a reaction or emoji, a goodbye, or an automatic reply.',
  input_schema: {
    type: 'object',
    properties: { why: { type: 'string', enum: ['thanks', 'acknowledgment', 'reaction', 'automatic_reply'] } },
    required: ['why'],
    additionalProperties: false,
  },
};

// The thread's wording of the reschedule check: it shows no button, so the tool only tells the model what to say.
const RESCHEDULE_TOOL = {
  name: 'offer_reschedule_link',
  description: 'Check whether the customer can move an upcoming visit themselves. Use for any request to reschedule, move, postpone or bring forward a visit. You are told what to say.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

// What offer_reschedule_link tells the model on this lane when a visit can be moved online. The Visits tab
// shows a Reschedule button on every upcoming visit that has a reschedule page (routes/schedule.js).
const RESCHEDULE_INSTRUCTION = 'The customer can move each listed visit themselves. Tell them in one sentence: on the Visits tab, tap Reschedule on the visit to see the open times and pick one. Name the visit by its date and service. Do not state or promise a new time, and do not write a web address.';

// Whether a tool result gives the model something it may tell the customer: a visit read that returned a
// visit, or the reschedule check that found a visit the customer can move.
function grounds(toolName, result) {
  if (toolName === 'get_upcoming_services') return Array.isArray(result?.services) && result.services.length > 0;
  if (toolName === 'offer_reschedule_link') return result?.available === true;
  return false;
}

// Whole phrases of thanks or acknowledgment. A message of one to three of them, and nothing else, needs no
// answer. Whole phrases on purpose, never single words that could be put together freely: "no problem" is
// here, "problem" is not, so "I have a problem", "Will you help" and "No good" all go to the model.
const NO_REPLY_PHRASES = [
  'thanks', 'thank you', 'thank u', 'thankyou', 'ty', 'thx', 'tysm', 'many thanks', 'thanks so much',
  'thank you so much', 'thanks a lot', 'thank you very much', 'thanks again', 'thank you again',
  'much appreciated', 'appreciate it', 'appreciate you', 'i appreciate it', 'i appreciate you',
  'we appreciate it', 'we appreciate you', 'really appreciate it', 'ok', 'okay', 'k', 'kk', 'alright', 'great',
  'perfect', 'awesome', 'wonderful', 'excellent', 'cool', 'nice', 'sounds good', 'sounds great',
  'sounds perfect', 'all good', 'got it', 'will do', 'no problem', 'no worries', 'np', 'youre welcome',
  'you too', 'good night', 'goodnight', 'have a good night', 'have a great night', 'have a good one',
  'have a good day', 'have a great day', 'have a good evening', 'have a great evening', 'have a good weekend',
  'have a great weekend', 'youre the best', 'you are the best', 'you guys are the best',
];
const NO_REPLY_PHRASE = [...NO_REPLY_PHRASES].sort((a, b) => b.length - a.length).join('|');
const NO_REPLY_RE = new RegExp(`^(?:${NO_REPLY_PHRASE})(?: (?:${NO_REPLY_PHRASE})){0,2}$`);

// A message that needs no answer and no model call: nothing but emoji or punctuation (a reaction), or one to
// three phrases of thanks or acknowledgment. Deterministic; the model's stay_silent covers the rest.
// Letters and digits of every script count as words, so a message in another alphabet goes to the model.
function needsNoReply(text) {
  const body = String(text || '');
  if (body.includes('?')) return false;
  const words = body.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!words) return body.trim().length > 0;
  return NO_REPLY_RE.test(words);
}

module.exports = { THREAD_PROMPT, STAY_SILENT_TOOL, RESCHEDULE_TOOL, RESCHEDULE_INSTRUCTION, grounds, needsNoReply };
