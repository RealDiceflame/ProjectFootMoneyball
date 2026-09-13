export const MAX_SEED = 2147483647;

export function validSeed(seed) {
  return Number.isInteger(seed) && seed >= 1 && seed <= MAX_SEED;
}

// Seeds identify a sequence of draws, not a team's strength or an outcome.
export function freshSeed(previous, randomWord = () => crypto.getRandomValues(new Uint32Array(1))[0]) {
  const word = randomWord();
  if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) throw new Error("Random seed generation failed.");
  const seed = word % MAX_SEED + 1;
  return seed === previous ? seed % MAX_SEED + 1 : seed;
}

// Retain complete examples throughout the run without changing its random stream.
export function exampleTrialIndices(trials, count = 20) {
  if (!Number.isInteger(trials) || trials < 1 || !Number.isInteger(count) || count < 1) throw new Error("Invalid sample count.");
  const size = Math.min(trials, count);
  return Array.from({length: size}, (_, index) => size === 1 ? 0 : Math.floor(index * (trials - 1) / (size - 1)));
}
