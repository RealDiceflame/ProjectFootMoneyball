export function normalizeHistoryName(value) {
  const parts = String(value || "").toLocaleLowerCase().match(/[a-z0-9]+/g) || [];
  if (["jr", "sr", "ii", "iii", "iv", "v"].includes(parts.at(-1))) parts.pop();
  return parts.join("");
}

export function historyKey(player) {
  const playerId = String(player?.player_id || "").trim();
  if (playerId && !["-", "nan", "none"].includes(playerId.toLocaleLowerCase())) return `id:${playerId}`;
  return `name:${normalizeHistoryName(player?.player)}|${String(player?.pos || "").toUpperCase()}`;
}

export function historyRows(bundle, player) {
  const record = bundle?.players?.[historyKey(player)];
  if (!record?.seasons?.length || !bundle?.columns?.length) return [];
  return record.seasons.map(values => Object.fromEntries(
    bundle.columns.map((column, index) => [column, values[index]]),
  ));
}

export function fantasyPoints(stats, settings) {
  const basePpr = { Standard: 0, "Half PPR": 0.5, "Full PPR": 1 }[settings?.ppr] ?? 0.5;
  const tePremium = stats?.pos === "TE" && settings?.tePremium === "+0.5" ? 0.5 : 0;
  const number = key => Number(stats?.[key]) || 0;
  return (
    number("passing_yards") * 0.04
    + number("passing_tds") * 4
    - number("passing_interceptions") * 2
    + number("rushing_yards") * 0.1
    + number("rushing_tds") * 6
    + number("receptions") * (basePpr + tePremium)
    + number("receiving_yards") * 0.1
    + number("receiving_tds") * 6
    - number("fumbles_total") * 2
  );
}

export function sampleStandardDeviation(values) {
  const numbers = (values || []).map(Number).filter(Number.isFinite);
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
    const fantasyPointsTotal = fantasyPoints({ ...row, pos: player?.pos }, settings);
    const games = Number(row.games) || 0;
    const fantasyPointsPerGame = games > 0 ? fantasyPointsTotal / games : null;
    return {
      ...row,
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

  const marketAdp = Number(player?.adp);
  const marketStdDev = Number(player?.adp_stddev);
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
