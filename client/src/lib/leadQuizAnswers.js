// The quiz pages' tap answers on a lead (extracted_data.quiz, which the lead
// webhook stores from a fixed allowlist of tokens). The Leads screen shows a
// label for a known token and nothing for anything else, so a value the
// webhook did not allowlist is never shown. The third answer, "How soon?", is
// the lead's declared timeline and has its own line.
const QUIZ_NAMES = { pest: "Pest Quiz", lawn: "Lawn Quiz" };
const QUIZ_SEEING_LABELS = {
  ants: "Ants",
  roaches: "Roaches",
  spiders: "Spiders",
  rodents: "Rodents",
  termites: "Termites",
  wasps: "Wasps",
  mosquitoes: "Mosquitoes",
  bedbugs: "Bed bugs",
  weeds: "Weeds",
  patches: "Patches",
  thinning: "Thinning",
  yellowing: "Yellowing",
  bugs: "Lawn bugs",
  fungus: "Fungus",
  shrubs: "Shrubs",
  palms: "Palms",
  unsure: "Not sure",
};
const QUIZ_PROPERTIES = ["house", "townhome", "condo", "business"];

// { name: "Pest Quiz", answers: "Roaches, condo" }, or null when the lead is
// not a quiz lead.
export function quizAnswerLine(quiz) {
  const name = quiz && typeof quiz === "object" ? QUIZ_NAMES[quiz.kind] : null;
  if (!name) return null;
  const answers = [
    QUIZ_SEEING_LABELS[quiz.seeing],
    QUIZ_PROPERTIES.includes(quiz.property) ? quiz.property : null,
  ].filter(Boolean);
  return { name, answers: answers.join(", ") };
}
