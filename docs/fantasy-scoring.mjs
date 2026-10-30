// Canonical scoring shared by historical projections and current value boards.
// A partial subtotal is explicit coverage, never evidence that a missing stat is 0.
const CORE = ["passing_yards", "passing_tds", "passing_interceptions", "rushing_yards",
  "rushing_tds", "receptions", "receiving_yards", "receiving_tds"];
const OPTIONAL = ["fumbles_lost_total", "passing_2pt_conversions", "rushing_2pt_conversions",
  "receiving_2pt_conversions", "special_teams_tds"];
const finite = value => typeof value === "number" && Number.isFinite(value);

export function scoreFantasyStats(stats, settings = {}, {allowLegacy = false, allowSparseCore = false} = {}) {
  if (!stats || typeof stats !== "object") return {points: null, complete: false};
  const known = key => finite(stats[key]) && (key.endsWith("_yards") || stats[key] >= 0);
  const coreComplete = CORE.every(known);
  // Historical sparse records can omit an entire unrelated category. A supplied
  // null, boolean, string or nonfinite value is unknown, and cannot become zero.
  if (CORE.some(key => Object.hasOwn(stats, key) ? !known(key) : !allowSparseCore)) return {points: null, complete: false};
  const complete = coreComplete && OPTIONAL.every(known);
  if (!complete && !allowLegacy) return {points: null, complete: false};
  const n = key => known(key) ? stats[key] : 0;
  const formats = {Standard: 0, "Half PPR": 0.5, "Full PPR": 1};
  const ppr = Object.hasOwn(formats, settings?.ppr) ? formats[settings.ppr] : 0.5;
  const premium = stats.pos === "TE" && settings?.tePremium === "+0.5" ? 0.5 : 0;
  const points = n("passing_yards") * .04 + n("passing_tds") * 4 - n("passing_interceptions") * 2
    + n("rushing_yards") * .1 + n("rushing_tds") * 6 + n("receptions") * (ppr + premium)
    + n("receiving_yards") * .1 + n("receiving_tds") * 6
    - n("fumbles_lost_total") * 2 + 2 * (n("passing_2pt_conversions") + n("rushing_2pt_conversions")
      + n("receiving_2pt_conversions")) + n("special_teams_tds") * 6;
  return Number.isFinite(points) ? {points, complete} : {points: null, complete: false};
}
