import {scoreFantasyStats} from "./fantasy-scoring.mjs?v=20261030-scoring1";

function numberOrNull(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeHistoryName(value) {
  const parts = String(value || "").toLocaleLowerCase().match(/[a-z0-9]+/g) || [];
  if (["jr", "sr", "ii", "iii", "iv", "v"].includes(parts.at(-1))) parts.pop();
  return parts.join("");
}

export function historyKey(player) {
  const playerId = String(player?.player_id || "").trim();
  if (playerId && !["-", "nan", "none", "null", "undefined", "n/a"].includes(playerId.toLocaleLowerCase())) return `id:${playerId}`;
  return `name:${normalizeHistoryName(player?.player)}|${String(player?.pos || "").toUpperCase()}`;
}

export function historyRows(bundle, player) {
  const record = bundle?.players?.[player?.history_key || historyKey(player)];
  if (!record?.seasons?.length || !bundle?.columns?.length) return [];
  return record.seasons.map(values => Object.fromEntries(
    bundle.columns.map((column, index) => [column, values[index]]),
  ));
}

export function historicalPlayers(bundle, rankedPlayers = []) {
  const rankedKeys = new Set(rankedPlayers.map(historyKey));
  return Object.entries(bundle?.players || {})
    .filter(([key, record]) => record.is_ranked === false && record.player && !rankedKeys.has(key) && !rankedKeys.has(historyKey(record)))
    .map(([key, record]) => ({ ...record, history_key: key, is_historical: true }))
    .sort((left, right) => left.player.localeCompare(right.player));
}

export function historyWindow(bundle) {
  const integerOrNull = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
  };
  const seasons = [...new Set((bundle?.seasons || [])
    .map(Number)
    .filter(Number.isInteger))]
    .sort((left, right) => left - right);
  const start = integerOrNull(bundle?.start_season) ?? seasons[0] ?? null;
  const end = integerOrNull(bundle?.end_season) ?? seasons.at(-1) ?? null;
  const count = integerOrNull(bundle?.season_count) ?? seasons.length;
  const range = start === null || end === null
    ? "History unavailable"
    : start === end ? String(start) : `${start}–${end}`;
  return {
    start,
    end,
    count,
    range,
    label: count ? `${range} · ${count} season${count === 1 ? "" : "s"}` : range,
  };
}

export function fantasyPoints(stats, settings) {
  return scoreFantasyStats(stats, settings, {allowLegacy: true, allowSparseCore: true}).points;
}

export function sampleStandardDeviation(values) {
  // An absent observation contributes neither a zero nor a sample count.
  const numbers = (values || []).map(numberOrNull).filter(Number.isFinite);
  if (numbers.length < 2) return null;
  const mean = numbers.reduce((total, value) => total + value, 0) / numbers.length;
  const variance = numbers.reduce((total, value) => total + ((value - mean) ** 2), 0) / (numbers.length - 1);
  return Math.sqrt(variance);
}

export function volatilityLabel(score) {
  if (!Number.isFinite(score)) return "Not rated";
  if (score < 20) return "Steady";
  if (score < 40) return "Moderate";
  if (score < 60) return "Volatile";
  return "High volatility";
}

export function historyAnalytics(rows, player, settings) {
  const seasons = (rows || []).map(row => {
    const scored = scoreFantasyStats({ ...row, pos: row.pos || player?.pos }, settings, {allowLegacy: true, allowSparseCore: true});
    const fantasyPointsTotal = scored.points;
    const games = numberOrNull(row.games);
    const fantasyPointsPerGame = Number.isInteger(games) && games > 0 && fantasyPointsTotal !== null ? fantasyPointsTotal / games : null;
    return {
      ...row,
      scoring_complete: scored.complete,
      fantasy_points: fantasyPointsTotal,
      fantasy_points_per_game: fantasyPointsPerGame,
      full_season_pace: fantasyPointsPerGame === null ? null : fantasyPointsPerGame * 17,
    };
  });
  const perGameValues = seasons
    .map(row => row.fantasy_points_per_game)
    .filter(Number.isFinite);
  const meanPerGame = perGameValues.length
    ? perGameValues.reduce((total, value) => total + value, 0) / perGameValues.length
    : null;
  const playerStdDev = sampleStandardDeviation(perGameValues);
  const playerCv = playerStdDev !== null && meanPerGame > 0 ? playerStdDev / meanPerGame : null;

  const marketAdp = numberOrNull(player?.adp);
  const marketStdDev = numberOrNull(player?.adp_stddev);
  const hasMarketVariation = Number.isFinite(marketAdp) && marketAdp > 0
    && Number.isFinite(marketStdDev) && marketStdDev >= 0
    && Number(player?.source_count) >= 2;
  const marketCv = hasMarketVariation ? marketStdDev / marketAdp : null;
  const components = [];
  if (playerCv !== null) components.push({ value: playerCv, weight: 0.7, name: "history" });
  if (marketCv !== null) components.push({ value: marketCv, weight: 0.3, name: "market" });
  const weight = components.reduce((total, component) => total + component.weight, 0);
  const rawScore = weight
    ? components.reduce((total, component) => total + (component.value * component.weight), 0) / weight
    : null;
  const volatilityScore = rawScore === null ? null : Math.round(Math.min(1, rawScore) * 100);
  const expectedPoints = meanPerGame === null ? null : meanPerGame * 17;
  const deviationPoints = playerStdDev === null ? null : playerStdDev * 17;

  return {
    seasons,
    mean_per_game: meanPerGame,
    player_stddev: playerStdDev,
    player_cv: playerCv,
    market_stddev: hasMarketVariation ? marketStdDev : null,
    market_cv: marketCv,
    expected_points: expectedPoints,
    expected_low: expectedPoints === null || deviationPoints === null ? null : Math.max(0, expectedPoints - deviationPoints),
    expected_high: expectedPoints === null || deviationPoints === null ? null : expectedPoints + deviationPoints,
    volatility_score: volatilityScore,
    volatility_label: volatilityLabel(volatilityScore),
    basis: components.map(component => component.name),
  };
}
