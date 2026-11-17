'use strict';

/**
 * What a caller on hold hears (GATE_CALL_HOLD, owner 2026-11-16 "ok build all"). Text only: the hold
 * route in routes/twilio-voice-webhook.js speaks it with the portal's Say voice. OPENING plays when
 * the hold starts, FACTS play in this order four at a time, and REMINDER plays between two facts
 * about once a minute. Each fact keeps its source in the comment beside it.
 *
 * Hold timer lines (owner-approved 2026-11-17): STAFF_REMINDER is said to the staff phone at 3 minutes (always
 * the computer voice); CALLER_VOICEMAIL is the only thing the caller hears when the hold ends at 5 minutes or
 * the staff phone hangs up; STAFF_VOICEMAIL tells the staff phone the caller is now leaving a message.
 */

const OPENING = 'Thanks for holding. Here are a few pest facts while you wait.';
const REMINDER = "Thanks for holding. We'll be right with you.";

const STAFF_REMINDER = 'Your caller has been on hold for 3 minutes.';
const STAFF_VOICEMAIL = 'Your caller went to voicemail.';
const CALLER_VOICEMAIL = 'Sorry for the wait. Please leave a message after the tone, and we will call you right back.';

const FACTS = [
  'When floodwater rises, fire ants can link their bodies together into a waterproof raft and float for days.', // PNAS, 2011
  'Ghost ants are tiny, with pale, milky-white legs and abdomens, which makes them hard to see.', // UF/IFAS IN532
  "White-footed ants are black with yellowish-white feet, and they don't bite or sting.", // UF/IFAS IN551
  'Florida carpenter ants mostly look for food at night, busiest from just before sunset to two hours after, and again near dawn.', // UF/IFAS IN455
  'About 90 kinds of mosquitoes live in Florida, and that list keeps growing as new species arrive from elsewhere.', // UF/IFAS news, 2023
  'Subterranean termites build mud tubes that work like highways between their underground colony and food above ground.', // UF/IFAS IN369
  'Despite its name, the West Indian drywood termite is native to the coastal desert of Peru and Chile.', // UF/IFAS IN236
  "The American cockroach isn't native here; it was brought over from Africa as early as 1625.", // UF/IFAS IN298
  'A 2024 genetic study found German cockroaches evolved from the Asian cockroach about 2,100 years ago, probably in India or Myanmar.', // PNAS, 2024
  'Chinch bugs usually walk, not fly, between lawns, and a group may cover over 400 feet in under an hour.', // UF/IFAS IN383
  'To stay cool, golden silk spiders may point their long bodies straight at the sun, so less of the body catches sunlight.', // UF/IFAS IN467
  'Roof rats are expert climbers, often seen at night running along utility lines, using their long tails for balance.', // University of California IPM
];

module.exports = { OPENING, REMINDER, STAFF_REMINDER, STAFF_VOICEMAIL, CALLER_VOICEMAIL, FACTS };
