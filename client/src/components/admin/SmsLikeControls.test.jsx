// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CustomerReactionLines, SmsLikeBadges, reactionVerb } from "./SmsLikeControls";

// GATE_SMS_LIKE: a customer's like is one short labeled line on our text.
const THUMB = "\u{1F44D}";
const HEART = "❤️";
afterEach(cleanup);

it("names the reaction: Liked for a thumbs-up, Loved for a heart, Reacted for anything else", () => {
  expect(reactionVerb(THUMB)).toBe("Liked");
  expect(reactionVerb(HEART)).toBe("Loved");
  expect(reactionVerb("❤")).toBe("Loved");
  expect(reactionVerb("\u{1F602}")).toBe("Reacted");
});

it("shows one line per like with the emoji, the verb and the Eastern time", () => {
  render(<CustomerReactionLines badges={[
    { id: "r1", emoji: HEART, createdAt: "2026-11-03T21:33:00Z" },
    { id: "r2", emoji: THUMB, createdAt: "2026-11-03T21:34:00Z" },
    { id: "r3", emoji: "\u{1F602}", createdAt: "2026-11-03T21:35:00Z" },
  ]} />);
  const lines = screen.getAllByTitle("The customer reacted to this text");
  expect(lines.map((l) => l.textContent)).toEqual([
    `${HEART} Loved · 4:33 PM`,
    `${THUMB} Liked · 4:34 PM`,
    "\u{1F602} Reacted · 4:35 PM",
  ]);
});

it("shows no line for a like taken back, or none at all", () => {
  const { container, rerender } = render(<CustomerReactionLines badges={[]} />);
  expect(container).toBeEmptyDOMElement();
  rerender(<CustomerReactionLines badges={undefined} />);
  expect(container).toBeEmptyDOMElement();
});

it("omits the time when the like has none; reads the lines on our text only", () => {
  render(<SmsLikeBadges message={{ id: "out", direction: "outbound" }} badges={new Map([["out", [{ id: "r", emoji: THUMB }]]])} />);
  expect(screen.getByTitle("The customer reacted to this text")).toHaveTextContent(`${THUMB} Liked`);
  expect(screen.getByTitle("The customer reacted to this text").textContent).not.toContain("·");
});
