import { describe, expect, test } from "vitest";
import { quizAnswerLine } from "./leadQuizAnswers";

describe("quizAnswerLine", () => {
  test("names the quiz and its two tap answers", () => {
    expect(quizAnswerLine({ kind: "pest", seeing: "roaches", property: "condo" }))
      .toEqual({ name: "Pest Quiz", answers: "Roaches, condo" });
    expect(quizAnswerLine({ kind: "lawn", seeing: "bugs", property: "business" }))
      .toEqual({ name: "Lawn Quiz", answers: "Lawn bugs, business" });
  });

  test("an unknown token shows nothing, never the raw value", () => {
    expect(quizAnswerLine({ kind: "pest", seeing: "<b>x</b>", property: "castle" }))
      .toEqual({ name: "Pest Quiz", answers: "" });
    expect(quizAnswerLine({ kind: "pest", seeing: "unsure" })).toEqual({ name: "Pest Quiz", answers: "Not sure" });
  });

  test("a lead with no quiz, or a malformed one, has no line", () => {
    expect(quizAnswerLine(undefined)).toBeNull();
    expect(quizAnswerLine(null)).toBeNull();
    expect(quizAnswerLine("pest")).toBeNull();
    expect(quizAnswerLine({ kind: "tree" })).toBeNull();
  });

  test("a prototype name is not a token", () => {
    expect(quizAnswerLine({ kind: "constructor" })).toBeNull();
    expect(quizAnswerLine({ kind: "__proto__" })).toBeNull();
    expect(quizAnswerLine({ kind: "pest", seeing: "constructor", property: "toString" }))
      .toEqual({ name: "Pest Quiz", answers: "" });
    expect(quizAnswerLine({ kind: "pest", seeing: ["roaches"], property: "condo" }))
      .toEqual({ name: "Pest Quiz", answers: "condo" });
  });
});
