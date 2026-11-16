// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxFits, insertDictatedText, isEligibleBox, readSelection } from "./dictationInsert";

// FocusedBoxMic (GATE_DICTATION_EVERY_BOX): which boxes get the shared mic, and
// how dictated words land in a box the mic does not own.

function box(html) {
  document.body.innerHTML = html;
  return document.querySelector("textarea");
}

afterEach(() => {
  document.body.innerHTML = "";
  delete document.execCommand;
});

describe("isEligibleBox", () => {
  it("accepts a plain enabled textarea", () => {
    expect(isEligibleBox(box("<textarea></textarea>"))).toBe(true);
  });

  it.each([
    ["disabled", "<textarea disabled></textarea>"],
    ["read-only", "<textarea readonly></textarea>"],
    ["inside a box with its own mic", '<div data-own-mic="true"><textarea></textarea></div>'],
    ["marked with its own mic", '<textarea data-own-mic="true"></textarea>'],
    ["opted out", '<textarea data-no-dictation="true"></textarea>'],
    ["hidden", '<textarea style="display:none"></textarea>'],
  ])("rejects a %s textarea", (_name, html) => {
    expect(isEligibleBox(box(html))).toBe(false);
  });

  it("rejects single-line inputs and nothing at all", () => {
    document.body.innerHTML = "<input type='text' />";
    expect(isEligibleBox(document.querySelector("input"))).toBe(false);
    expect(isEligibleBox(null)).toBe(false);
  });

  it("keeps the mic off a box that reads as one line", () => {
    expect(boxFits({ width: 300, height: 58 })).toBe(true);
    expect(boxFits({ width: 300, height: 36 })).toBe(false);
    expect(boxFits({ width: 60, height: 90 })).toBe(false);
  });
});

describe("insertDictatedText", () => {
  it("adds one leading space when the caret follows a non-space character", () => {
    const el = box("<textarea>Hello</textarea>");
    expect(insertDictatedText(el, "world", { start: 5, end: 5 })).toEqual({ ok: true });
    expect(el.value).toBe("Hello world");
  });

  it("adds no space at the start of the box or after whitespace", () => {
    const empty = box("<textarea></textarea>");
    insertDictatedText(empty, "First note", { start: 0, end: 0 });
    expect(empty.value).toBe("First note");
    const lines = box("<textarea>Line one\n</textarea>");
    insertDictatedText(lines, "Line two", { start: 9, end: 9 });
    expect(lines.value).toBe("Line one\nLine two");
  });

  it("replaces a saved selection and inserts at the saved caret, not the end", () => {
    const el = box("<textarea>Gate is red now</textarea>");
    insertDictatedText(el, "blue", { start: 8, end: 11 });
    expect(el.value).toBe("Gate is blue now");
  });

  it("does not trust saved offsets after the box was edited while the words came back", () => {
    const el = box("<textarea>Gate is red now</textarea>");
    el.setSelectionRange(8, 11);
    const saved = readSelection(el);
    el.value = "Totally new text";
    el.blur();
    insertDictatedText(el, "blue", saved);
    expect(el.value).toBe("Totally new text blue");
    // Still focused: the words go where the caret is now.
    const live = box("<textarea>Gate is red now</textarea>");
    live.setSelectionRange(8, 11);
    const savedLive = readSelection(live);
    live.value = "Edited text";
    live.focus();
    live.setSelectionRange(6, 6);
    insertDictatedText(live, "blue", savedLive);
    expect(live.value).toBe("Edited blue text");
  });

  it("tells a controlled React textarea: the native setter plus a bubbling input event", () => {
    const el = box("<textarea>Hello</textarea>");
    const seen = vi.fn();
    document.body.addEventListener("input", (e) => seen(e.target.value));
    insertDictatedText(el, "again", { start: 5, end: 5 });
    expect(seen).toHaveBeenCalledWith("Hello again");
  });

  it("uses the browser insert when it works and does not add the words twice", () => {
    const el = box("<textarea>Hello</textarea>");
    document.execCommand = vi.fn((cmd, _ui, text) => {
      el.value = el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    });
    const seen = vi.fn();
    el.addEventListener("input", seen);
    insertDictatedText(el, "world", { start: 5, end: 5 });
    expect(document.execCommand).toHaveBeenCalledWith("insertText", false, " world");
    expect(el.value).toBe("Hello world");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("falls back to the native setter when the browser insert changes nothing", () => {
    const el = box("<textarea>Hello</textarea>");
    document.execCommand = vi.fn(() => true);
    insertDictatedText(el, "world", { start: 5, end: 5 });
    expect(el.value).toBe("Hello world");
  });

  it("respects maxLength and reports a full box", () => {
    const el = box('<textarea maxlength="9">Hello</textarea>');
    insertDictatedText(el, "world", { start: 5, end: 5 });
    expect(el.value).toBe("Hello wor");
    expect(insertDictatedText(el, "more", { start: 9, end: 9 })).toEqual({ ok: false, reason: "full" });
  });

  it("drops the words when the box left the page or is locked now", () => {
    const el = box("<textarea>Hello</textarea>");
    el.disabled = true;
    expect(insertDictatedText(el, "x", { start: 5, end: 5 })).toEqual({ ok: false, reason: "locked" });
    el.disabled = false;
    el.remove();
    expect(insertDictatedText(el, "x", { start: 5, end: 5 })).toEqual({ ok: false, reason: "gone" });
    expect(el.value).toBe("Hello");
  });
});
