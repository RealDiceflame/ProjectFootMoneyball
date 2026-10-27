import {readFile} from "node:fs/promises";

// Pin the clock and its matching saved forecasts together. Loading the changing
// docs/data feed with a historical clock eventually makes planned weeks final
// and moves quoted games outside the matchup window. The model suites still
// exercise the current published snapshots separately.
// Source: docs/data at c9bb49faaed615c87fae1296bbebfc75c31f2875.
// The odds fixture keeps only the first upcoming game's original rows.
export const labNow = Date.parse("2026-10-27T16:17:18Z");

export async function readLabSnapshots() {
  const read = async name => JSON.parse(await readFile(new URL(`../fixtures/lab-${name}-2026-10-27.json`, import.meta.url), "utf8"));
  return {survivor: await read("survivor"), nfl_odds: await read("odds")};
}
