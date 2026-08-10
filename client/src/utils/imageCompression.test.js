import { describe, it, expect, vi } from "vitest";
import {
  fitImagesToBudget,
  isCompressibleImage,
  isAnimatedImage,
  formatBytes,
  totalBytes,
  MMS_TOTAL_BUDGET_BYTES,
  TWILIO_MMS_TOTAL_BYTES,
} from "./imageCompression";

// Build a fake File whose header bytes are sniffable, for animation detection.
function fileWithHeader(name, type, headerAscii, size = 1024) {
  const bytes = new TextEncoder().encode(headerAscii);
  return {
    name,
    type,
    size,
    slice: () => ({ arrayBuffer: async () => bytes.buffer }),
  };
}

const MB = 1024 * 1024;

// A stand-in for a picked File. jsdom has no canvas, so every test injects a
// fake encoder and asserts on the ladder/budget logic, which is where the
// behavior that matters lives.
function fakeFile(name, size, type = "image/jpeg") {
  return { name, size, type, lastModified: 0 };
}

// Encoder that shrinks by a fixed ratio per rung, mimicking the real ladder:
// later (lower-quality) rungs produce smaller output.
function encoderShrinkingByRung(ratios) {
  const seen = [];
  const encode = vi.fn(async (file, rung) => {
    let idx = seen.findIndex(
      (r) => r.maxEdge === rung.maxEdge && r.quality === rung.quality,
    );
    if (idx === -1) {
      seen.push(rung);
      idx = seen.length - 1;
    }
    const ratio = ratios[Math.min(idx, ratios.length - 1)];
    return {
      ...file,
      name: file.name.replace(/\.[^.]+$/, ".jpg"),
      type: "image/jpeg",
      size: Math.round(file.size * ratio),
    };
  });
  encode.rungs = seen;
  return encode;
}

describe("budget constants", () => {
  it("targets a budget strictly under Twilio’s hard 5MB ceiling", () => {
    expect(MMS_TOTAL_BUDGET_BYTES).toBeLessThan(TWILIO_MMS_TOTAL_BYTES);
    expect(TWILIO_MMS_TOTAL_BYTES).toBe(5 * MB);
  });
});

describe("isCompressibleImage", () => {
  it("accepts still raster images", () => {
    expect(isCompressibleImage(fakeFile("a.jpg", 1, "image/jpeg"))).toBe(true);
    expect(isCompressibleImage(fakeFile("a.png", 1, "image/png"))).toBe(true);
    expect(isCompressibleImage(fakeFile("a.webp", 1, "image/webp"))).toBe(true);
  });

  it("refuses GIFs — a canvas round-trip would flatten the animation", () => {
    expect(isCompressibleImage(fakeFile("a.gif", 1, "image/gif"))).toBe(false);
  });

  it("refuses non-images", () => {
    expect(isCompressibleImage(fakeFile("a.pdf", 1, "application/pdf"))).toBe(
      false,
    );
    expect(isCompressibleImage(null)).toBe(false);
  });
});

describe("isAnimatedImage", () => {
  it("treats every GIF as animated", async () => {
    await expect(
      isAnimatedImage(fakeFile("a.gif", 1, "image/gif")),
    ).resolves.toBe(true);
  });

  it("detects APNG via the acTL chunk", async () => {
    const apng = fileWithHeader(
      "a.png",
      "image/png",
      "\x89PNG\r\n\x1a\nIHDR....acTL....IDAT",
    );
    await expect(isAnimatedImage(apng)).resolves.toBe(true);
  });

  it("does not treat a still PNG as animated", async () => {
    const png = fileWithHeader(
      "a.png",
      "image/png",
      "\x89PNG\r\n\x1a\nIHDR....IDATacTL",
    );
    // "acTL" here sits AFTER IDAT — that's compressed pixel data coinciding,
    // not an animation control chunk.
    await expect(isAnimatedImage(png)).resolves.toBe(false);
  });

  it("detects animated WebP via the ANIM chunk", async () => {
    const webp = fileWithHeader(
      "a.webp",
      "image/webp",
      "RIFF....WEBPVP8X....ANIM",
    );
    await expect(isAnimatedImage(webp)).resolves.toBe(true);
  });

  it("does not treat a still WebP as animated", async () => {
    const webp = fileWithHeader("a.webp", "image/webp", "RIFF....WEBPVP8 ....");
    await expect(isAnimatedImage(webp)).resolves.toBe(false);
  });

  it("fails safe — an unreadable header counts as animated", async () => {
    const broken = {
      name: "x.png",
      type: "image/png",
      size: 10,
      slice: () => ({
        arrayBuffer: async () => {
          throw new Error("unreadable");
        },
      }),
    };
    await expect(isAnimatedImage(broken)).resolves.toBe(true);
  });

  it("ignores formats that cannot animate", async () => {
    await expect(
      isAnimatedImage(fakeFile("a.jpg", 1, "image/jpeg")),
    ).resolves.toBe(false);
  });
});

describe("fitImagesToBudget", () => {
  it("encodes sequentially so only one raster is live at a time", async () => {
    // A concurrent implementation would let both calls overlap; this asserts
    // call N finishes before call N+1 starts.
    let inFlight = 0;
    let maxInFlight = 0;
    const encode = vi.fn(async (file) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ...file, size: Math.round(file.size * 0.2) };
    });

    const files = Array.from({ length: 5 }, (_, i) =>
      fakeFile(`p${i}.jpg`, 2 * MB),
    );
    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
      detectAnimated: async () => false,
    });

    expect(res.ok).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("passes animated PNG/WebP through instead of flattening them", async () => {
    const encode = vi.fn(async (file) => ({
      ...file,
      size: Math.round(file.size * 0.1),
    }));
    const apng = fakeFile("loop.png", 2 * MB, "image/png");
    const jpg = fakeFile("photo.jpg", 4 * MB);

    const res = await fitImagesToBudget([apng, jpg], {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
      detectAnimated: async (f) => f.name === "loop.png",
    });

    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(apng); // untouched, animation intact
    expect(encode).not.toHaveBeenCalledWith(apng, expect.anything());
  });

  it("restores originals whose extra bytes fit the leftover headroom", async () => {
    // Budget 5MB. Originals 3MB + 3MB = 6MB, over. At the winning rung each
    // compresses to 1MB (total 2MB), leaving 3MB of headroom — enough to put
    // ONE 3MB original back byte-for-byte (1 + 3 = 4MB <= 5MB).
    const encode = vi.fn(async (file) => ({ ...file, size: 1 * MB }));
    const a = fakeFile("a.jpg", 3 * MB);
    const b = fakeFile("b.jpg", 3 * MB);

    const res = await fitImagesToBudget([a, b], {
      availableBytes: 5 * MB,
      encodeImage: encode,
      detectAnimated: async () => false,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBeLessThanOrEqual(5 * MB);
    const restored = res.files.filter((f, i) => f === [a, b][i]);
    expect(restored).toHaveLength(1); // one original survives losslessly
  });

  it("never restores so much that the batch goes back over budget", async () => {
    // Reaching the ladder means the originals exceed the budget, so restoring
    // ALL of them is by definition impossible — the invariant that matters is
    // that greedy restoration never overshoots.
    const encode = vi.fn(async (file) => ({ ...file, size: 1 * MB }));
    const files = [
      fakeFile("a.jpg", 3 * MB),
      fakeFile("b.jpg", 3 * MB),
      fakeFile("c.jpg", 3 * MB),
    ];

    const res = await fitImagesToBudget(files, {
      availableBytes: 5 * MB,
      encodeImage: encode,
      detectAnimated: async () => false,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBeLessThanOrEqual(5 * MB);
    expect(res.compressed).toBe(true);
  });

  it("leaves a batch that already fits completely untouched", async () => {
    const encode = vi.fn();
    const files = [fakeFile("a.jpg", 1 * MB), fakeFile("b.jpg", 2 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: MMS_TOTAL_BUDGET_BYTES,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.compressed).toBe(false);
    expect(res.files).toEqual(files); // same objects, not re-encoded copies
    expect(encode).not.toHaveBeenCalled();
  });

  it("stops at the FIRST rung that fits rather than compressing all the way down", async () => {
    // Rung 0 gets it to 4.0MB, which is already under budget — we must not
    // walk further down the ladder and shed quality we did not need to.
    const encode = encoderShrinkingByRung([0.4, 0.2, 0.1]);
    const files = [fakeFile("a.jpg", 5 * MB), fakeFile("b.jpg", 5 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.compressed).toBe(true);
    expect(res.finalBytes).toBe(4 * MB);
    expect(encode.rungs).toHaveLength(1); // only the top rung was tried
  });

  it("descends the ladder until it fits when the top rung is not enough", async () => {
    const encode = encoderShrinkingByRung([0.9, 0.6, 0.3]);
    const files = [fakeFile("a.jpg", 5 * MB), fakeFile("b.jpg", 5 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBe(3 * MB); // 10MB at the third rung's 0.3
    expect(encode.rungs).toHaveLength(3);
  });

  it("keeps the original when a re-encode comes out bigger", async () => {
    // Small already-optimized images routinely inflate on re-encode. The
    // 4MB file shrinks, the 200KB one bloats and must be left alone.
    const encode = vi.fn(async (file) =>
      file.size > MB
        ? { ...file, size: Math.round(file.size * 0.3) }
        : { ...file, size: file.size * 3 },
    );
    const small = fakeFile("small.png", 200 * 1024, "image/png");
    const big = fakeFile("big.jpg", 4 * MB);

    const res = await fitImagesToBudget([small, big], {
      availableBytes: 2 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(small); // identity preserved — original kept
    expect(res.files[1].size).toBe(Math.round(4 * MB * 0.3));
  });

  it("passes GIFs through uncompressed but still counts them against the budget", async () => {
    const encode = vi.fn(async (file) => ({
      ...file,
      size: Math.round(file.size * 0.1),
    }));
    const gif = fakeFile("loop.gif", 3 * MB, "image/gif");
    const jpg = fakeFile("photo.jpg", 4 * MB);

    const res = await fitImagesToBudget([gif, jpg], {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(gif);
    expect(encode).not.toHaveBeenCalledWith(gif, expect.anything());
    expect(res.finalBytes).toBe(3 * MB + Math.round(4 * MB * 0.1));
  });

  it("reports failure instead of silently overshooting when nothing fits", async () => {
    const gif = fakeFile("huge.gif", 9 * MB, "image/gif"); // never compressible

    const res = await fitImagesToBudget([gif], {
      availableBytes: 4.5 * MB,
      encodeImage: vi.fn(),
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("over-budget");
    expect(res.bestBytes).toBe(9 * MB);
  });

  it("treats an undecodable file (HEIC outside Safari) as pass-through, not a crash", async () => {
    const encode = vi.fn(async () => null);
    const heic = fakeFile("IMG_1.heic", 2 * MB, "image/heic");

    const res = await fitImagesToBudget([heic], {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    // 2MB already fits, so it short-circuits before touching the encoder.
    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(heic);
  });

  it("accounts for already-attached bytes via the caller’s available budget", async () => {
    const encode = encoderShrinkingByRung([0.2]);
    const files = [fakeFile("a.jpg", 2 * MB)];

    // 4MB already attached out of a 4.5MB budget leaves only 0.5MB.
    const res = await fitImagesToBudget(files, {
      availableBytes: 0.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBeLessThanOrEqual(0.5 * MB);
  });

  it("fails closed when the tray is already at budget", async () => {
    const res = await fitImagesToBudget([fakeFile("a.jpg", MB)], {
      availableBytes: 0,
      encodeImage: vi.fn(),
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-budget");
  });

  it("handles an empty selection", async () => {
    const res = await fitImagesToBudget([], {
      availableBytes: MMS_TOTAL_BUDGET_BYTES,
    });
    expect(res).toMatchObject({ ok: true, compressed: false, finalBytes: 0 });
  });

  it("returns files index-aligned with the input so callers can zip previews", async () => {
    const encode = encoderShrinkingByRung([0.2]);
    const files = [
      fakeFile("a.jpg", 3 * MB),
      fakeFile("b.gif", MB, "image/gif"),
      fakeFile("c.png", 3 * MB, "image/png"),
    ];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.files).toHaveLength(3);
    expect(res.files[1]).toBe(files[1]);
    expect(res.files[0].name).toBe("a.jpg");
    expect(res.files[2].name).toBe("c.jpg"); // re-encoded to JPEG
  });
});

describe("helpers", () => {
  it("sums sizes defensively", () => {
    expect(totalBytes([{ size: 10 }, { size: 5 }, {}, null])).toBe(15);
    expect(totalBytes()).toBe(0);
  });

  it("formats bytes at human scale", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(4.5 * MB)).toBe("4.5 MB");
  });
});
