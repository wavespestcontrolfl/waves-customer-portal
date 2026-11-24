/**
 * pest-insider-fonts.js — READ-ONLY helper for the Pest Insider drawing scripts (pest-insider-cards.js, pest-insider-heroes.js)
 *
 * The @font-face rules for Anton and Inter, built from font files the portal
 * already ships and inlined as data URLs, so a drawing needs no network and
 * never changes with a font update on Google Fonts:
 *   Anton: every Anton face in client/public/fonts/fonts.css (the portal's
 *          self-hosted Google Fonts files; client/public/fonts/sources.json).
 *   Inter: every face @fontsource/inter ships for each weight asked for.
 * Each face keeps its unicode-range, as Google Fonts serves them.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

// The body of each @font-face rule in a stylesheet.
const faceBodies = (css) => [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);

function face(family, weight, file, body) {
  const range = /unicode-range:\s*([^;]+);/.exec(body);
  if (!range) throw new Error(`${path.basename(file)}: its @font-face has no unicode-range`);
  const data = fs.readFileSync(file).toString('base64');
  return `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; font-display: block; src: url(data:font/woff2;base64,${data}) format('woff2'); unicode-range: ${range[1].trim()}; }`;
}

function antonFaces() {
  const dir = path.join(repoRoot, 'client/public/fonts');
  const faces = faceBodies(fs.readFileSync(path.join(dir, 'fonts.css'), 'utf8'))
    .filter((body) => /font-family:\s*'Anton'/.test(body))
    .map((body) => {
      const file = /src:\s*url\(\/fonts\/([0-9a-f]+\.woff2)\)/.exec(body);
      if (!file) throw new Error('client/public/fonts/fonts.css: an Anton face has no woff2 file');
      return face('Anton', 400, path.join(dir, file[1]), body);
    });
  if (!faces.length) throw new Error('client/public/fonts/fonts.css has no Anton face');
  return faces;
}

function interFaces(weights) {
  const dir = path.dirname(require.resolve('@fontsource/inter/package.json'));
  return weights.flatMap((weight) => {
    const faces = faceBodies(fs.readFileSync(path.join(dir, `${weight}.css`), 'utf8')).map((body) => {
      const file = /src:\s*url\(\.\/files\/([a-z0-9-]+\.woff2)\)/.exec(body);
      if (!file) throw new Error(`@fontsource/inter ${weight}.css: a face has no woff2 file`);
      return face('Inter', weight, path.join(dir, 'files', file[1]), body);
    });
    if (!faces.length) throw new Error(`@fontsource/inter has no ${weight} face`);
    return faces;
  });
}

/** A <style> block with Anton and Inter at the given weights. */
function fontStyle(interWeights) {
  return `<style>\n${[...antonFaces(), ...interFaces(interWeights)].join('\n')}\n</style>`;
}

module.exports = { fontStyle };
