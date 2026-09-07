// Per-tech Twilio lines — mirrors server/config/twilio-numbers.js `fieldTech`.
// Which technician holds a line is set on the Team tab (technicians.twilio_number);
// the Communications number list and the Team tab picker both read this so the
// two cannot drift.
export const TECH_LINE_NUMBERS = [
  { number: "+19413529161", formatted: "(941) 352-9161", label: "Tech line 1" },
];
