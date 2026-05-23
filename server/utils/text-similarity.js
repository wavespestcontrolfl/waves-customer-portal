function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function wordTrigrams(text) {
  const words = tokenize(text);
  const trigrams = new Set();
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return trigrams;
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function computeBodySimilarity(text1, text2) {
  const trigramsA = wordTrigrams(text1);
  const trigramsB = wordTrigrams(text2);
  const similarity = jaccardSimilarity(trigramsA, trigramsB);
  return {
    similarity_pct: Math.round(similarity * 100),
    trigram_count_a: trigramsA.size,
    trigram_count_b: trigramsB.size,
  };
}

module.exports = {
  tokenize,
  wordTrigrams,
  jaccardSimilarity,
  computeBodySimilarity,
};
