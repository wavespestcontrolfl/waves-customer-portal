import { describe, expect, it } from "vitest";
import { encodeEmailBody } from "./useEmailEditor";

describe("encodeEmailBody (F0578)", () => {
  it("escapes HTML-significant characters before the newline swap", () => {
    expect(encodeEmailBody("price <100 & >50\nthanks")).toBe(
      "price &lt;100 &amp; &gt;50<br>thanks",
    );
  });

  it("shows pasted markup instead of rendering it", () => {
    expect(encodeEmailBody('<a href="x">click</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;click&lt;/a&gt;",
    );
  });

  it("leaves plain text and line breaks as before", () => {
    expect(encodeEmailBody("First line\nSecond line")).toBe("First line<br>Second line");
    expect(encodeEmailBody("")).toBe("");
  });
});
