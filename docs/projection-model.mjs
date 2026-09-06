import {
  fantasyPoints,
  historyKey,
  historyRows,
  normalizeHistoryName,
  sampleStandardDeviation,
} from "./player-history.mjs?v=20260906-projection1";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const RECENCY_WEIGHTS = [5, 3, 2];

function numberOrNull(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) / numbers.length : null;
}

function weightedAverage(items, valueKey, weightKey = "weight") {
  const useful = items.filter(item => Number.isFinite(item[valueKey]) && Number(item[weightKey]) > 0);
  const weight = useful.reduce((total, item) => total + Number(item[weightKey]), 0);
  return weight ? useful.reduce((total, item) => total + (Number(item[valueKey]) * Number(item[weightKey])), 0) / weight : null;
}

export function ageOnSeptemberFirst(birthDate, season) {
  const match = String(birthDate || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const targetSeason = Number(season);
  if (!match || !Number.isInteger(targetSeason)) return null;
  const birthYear = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (birthYear < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return targetSeason - birthYear - (month > 9 || (month === 9 && day > 1) ? 1 : 0);
}

function playerIdentity(player) {
  const playerId = String(player?.player_id || "").trim();
  if (playerId && !["-", "nan", "none"].includes(playerId.toLocaleLowerCase())) return `id:${playerId}`;
  return `name:${normalizeHistoryName(player?.player)}|${String(player?.pos || "").toUpperCase()}`;
}

function reportLookup(newsBundle) {
  const lookup = new Map();
  Object.values(newsBundle?.reports || {}).forEach(report => {
    lookup.set(playerIdentity(report), report);
    const listedTeam = String(report?.listed_team || report?.team || "").toUpperCase();
    lookup.set(`listed:${String(report?.player || "").trim().toLocaleLowerCase()}|${listedTeam}`, report);
  });
  return lookup;
}

function reportFromLookup(lookup, player) {
  const identity = playerIdentity(player);
  if (lookup.has(identity)) return lookup.get(identity);
  const listedTeam = String(player?.listed_team || player?.team || "").toUpperCase();
  return lookup.get(`listed:${String(player?.player || "").trim().toLocaleLowerCase()}|${listedTeam}`) || null;
}

export function reportForPlayer(newsBundle, player) {
  return reportFromLookup(reportLookup(newsBundle), player);
}

export function buildPositionSamples(players, historyBundle, newsBundle, settings) {
  const reports = reportLookup(newsBundle);
  const samples = [];
  const seen = new Set();
  for (const player of players || []) {
    const identity = playerIdentity(player);
    if (seen.has(identity) || !POSITIONS.includes(String(player?.pos || "").toUpperCase())) continue;
    seen.add(identity);
    const report = reports.get(identity)
      || reports.get(`listed:${String(player?.player || "").trim().toLocaleLowerCase()}|${String(player?.listed_team || player?.team || "").toUpperCase()}`);
    const birthDate = report?.birth_date;
    if (!birthDate) continue;
    for (const row of historyRows(historyBundle, player)) {
      const games = numberOrNull(row.games);
      const season = numberOrNull(row.season);
      if (games === null || games < 4 || season === null) continue;
      const points = fantasyPoints({ ...row, pos: player.pos }, settings);
      const pointsPerGame = points / games;
      const age = ageOnSeptemberFirst(birthDate, season);
      if (!Number.isFinite(pointsPerGame) || !Number.isFinite(age) || age < 20 || age > 45) continue;
      samples.push({
        player: player.player,
        player_id: player.player_id || null,
        identity,
        pos: String(player.pos).toUpperCase(),
        season,
        age,
        games,
        fantasy_points: points,
        fantasy_points_per_game: pointsPerGame,
      });
    }
  }
  return samples;
}

export function positionAgeCurve(samples, position) {
  const positionSamples = (samples || []).filter(sample => sample.pos === position);
  if (!positionSamples.length) return [];
  const ages = positionSamples.map(sample => sample.age);
  const minimum = Math.min(...ages);
  const maximum = Math.max(...ages);
  const curve = [];
  for (let age = minimum; age <= maximum; age += 1) {
    const nearby = positionSamples
      .filter(sample => Math.abs(sample.age - age) <= 1)
      .map(sample => ({
        ...sample,
        weight: Math.min(sample.games, 17) * (sample.age === age ? 1 : 0.45),
      }));
    if (!nearby.length) continue;
    curve.push({
      age,
      mean: weightedAverage(nearby, "fantasy_points_per_game"),
      stddev: sampleStandardDeviation(nearby.map(sample => sample.fantasy_points_per_game)),
      count: nearby.length,
      exact_count: positionSamples.filter(sample => sample.age === age).length,
    });
  }
  return curve;
}

function nearestCurvePoint(curve, age) {
  if (!curve?.length || !Number.isFinite(age)) return null;
  return [...curve].sort((left, right) => Math.abs(left.age - age) - Math.abs(right.age - age))[0] || null;
}

export function ageChangeFactor(samples, position, nextAge) {
  const grouped = new Map();
  (samples || []).filter(sample => sample.pos === position).forEach(sample => {
    if (!grouped.has(sample.identity)) grouped.set(sample.identity, []);
    grouped.get(sample.identity).push(sample);
  });
  const changes = [];
  grouped.forEach(playerSamples => {
    const ordered = [...playerSamples].sort((left, right) => left.season - right.season);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (current.season - previous.season !== 1 || previous.games < 6 || current.games < 6) continue;
      if (previous.fantasy_points_per_game < 2 || Math.abs(current.age - nextAge) > 1) continue;
      changes.push({
        ratio: Math.max(0.65, Math.min(1.35, current.fantasy_points_per_game / previous.fantasy_points_per_game)),
        weight: Math.min(previous.games, current.games, 17) * (current.age === nextAge ? 1 : 0.55),
      });
    }
  });
  const evidenceWeight = changes.reduce((total, change) => total + change.weight, 0);
  const priorWeight = 34;
  const factor = evidenceWeight
    ? (changes.reduce((total, change) => total + (change.ratio * change.weight), 0) + priorWeight) / (evidenceWeight + priorWeight)
    : 1;
  return {
    factor: Math.max(0.88, Math.min(1.12, factor)),
    count: changes.length,
  };
}

function playerSeasonRows(player, historyBundle, settings) {
  return historyRows(historyBundle, player)
    .map(row => {
      const games = numberOrNull(row.games);
      if (games === null || games <= 0) return null;
      const fantasyPointsTotal = fantasyPoints({ ...row, pos: player.pos }, settings);
      return {
        ...row,
        season: Number(row.season),
        games,
        fantasy_points: fantasyPointsTotal,
        fantasy_points_per_game: fantasyPointsTotal / games,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.season - left.season);
}

export function projectPlayer(player, historyBundle, newsBundle, settings, projectionSeason, samples = null, context = null) {
  const report = context?.reports
    ? reportFromLookup(context.reports, player)
    : reportForPlayer(newsBundle, player);
  const age = ageOnSeptemberFirst(report?.birth_date, projectionSeason);
  const seasons = playerSeasonRows(player, historyBundle, settings);
  const existingProjection = numberOrNull(player?.projected_points);
  const allSamples = samples || buildPositionSamples([player], historyBundle, newsBundle, settings);
  const position = String(player?.pos || "").toUpperCase();
  const curve = context?.curves?.[position] || positionAgeCurve(allSamples, position);
  const cohort = nearestCurvePoint(curve, age);

  if (!seasons.length) {
    if (existingProjection === null) return null;
    return {
      age,
      birth_date: report?.birth_date || null,
      projected_ppg: existingProjection / 17,
      projected_points: existingProjection,
      projected_17_game_pace: existingProjection,
      expected_games: 17,
      expected_low: null,
      expected_high: null,
      projection_stddev: null,
      position_mean_ppg: cohort?.mean ?? null,
      position_stddev_ppg: cohort?.stddev ?? null,
      age_factor: 1,
      age_adjustment_pct: 0,
      age_change_sample: 0,
      history_seasons: 0,
      source: player?.is_rookie ? "rookie_market" : "existing_baseline",
    };
  }

  const recent = seasons.slice(0, RECENCY_WEIGHTS.length).map((season, index) => ({
    ...season,
    weight: RECENCY_WEIGHTS[index] * Math.max(0.35, Math.min(1, season.games / 12)),
  }));
  const recentPpg = weightedAverage(recent, "fantasy_points_per_game");
  const recentGames = weightedAverage(recent, "games");
  const evidenceGames = recent.reduce((total, season) => total + Math.min(season.games, 17), 0);
  const ageChange = ageChangeFactor(allSamples, String(player.pos).toUpperCase(), age);
  const ageAdjustedPpg = recentPpg * ageChange.factor;
  const reliability = Math.min(0.9, 0.75 + (Math.min(evidenceGames, 51) / 51) * 0.15);
  const projectedPpg = cohort?.mean === null || cohort?.mean === undefined
    ? ageAdjustedPpg
    : (ageAdjustedPpg * reliability) + (cohort.mean * (1 - reliability));
  const expectedGames = Math.max(10, Math.min(17, (recentGames * 0.8) + (16.5 * 0.2)));
  const playerStddev = sampleStandardDeviation(recent.map(season => season.fantasy_points_per_game));
  const cohortUncertainty = Number.isFinite(cohort?.stddev) ? cohort.stddev * 0.35 : null;
  const projectionStddev = playerStddev === null
    ? cohortUncertainty
    : cohortUncertainty === null
      ? playerStddev
      : Math.sqrt((playerStddev ** 2 * 0.7) + (cohortUncertainty ** 2 * 0.3));
  const projectedPoints = projectedPpg * expectedGames;
  const deviationPoints = projectionStddev === null ? null : projectionStddev * expectedGames;

  return {
    age,
    birth_date: report?.birth_date || null,
    projected_ppg: projectedPpg,
    projected_points: projectedPoints,
    projected_17_game_pace: projectedPpg * 17,
    expected_games: expectedGames,
    expected_low: deviationPoints === null ? null : Math.max(0, projectedPoints - deviationPoints),
    expected_high: deviationPoints === null ? null : projectedPoints + deviationPoints,
    projection_stddev: projectionStddev,
    position_mean_ppg: cohort?.mean ?? null,
    position_stddev_ppg: cohort?.stddev ?? null,
    position_sample: cohort?.count ?? 0,
    age_factor: ageChange.factor,
    age_adjustment_pct: (ageChange.factor - 1) * 100,
    age_change_sample: ageChange.count,
    history_seasons: seasons.length,
    source: age === null ? "recent_form" : "age_curve",
  };
}

function marketExpectation(rows) {
  const expected = new Map();
  POSITIONS.forEach(position => {
    const group = rows.filter(row => row.pos === position && numberOrNull(row.adp) !== null && numberOrNull(row.projected_points) !== null);
    if (group.length < 2) return;
    const meanAdp = average(group.map(row => Number(row.adp)));
    const meanPoints = average(group.map(row => Number(row.projected_points)));
    const denominator = group.reduce((total, row) => total + ((Number(row.adp) - meanAdp) ** 2), 0);
    const slope = denominator === 0 ? 0 : group.reduce(
      (total, row) => total + ((Number(row.adp) - meanAdp) * (Number(row.projected_points) - meanPoints)), 0,
    ) / denominator;
    const intercept = meanPoints - (slope * meanAdp);
    group.forEach(row => expected.set(row, (Number(row.adp) * slope) + intercept));
  });
  return expected;
}

function marketTag(value, adp) {
  if (numberOrNull(adp) === null || !Number.isFinite(value)) return "NO MARKET";
  if (value >= 50) return "TARGET";
  if (value >= 25) return "VALUE";
  if (value <= -20) return "REACH";
  return "FAIR";
}

function replacementCounts(settings) {
  const teams = Number(settings?.teams) || 12;
  const quarterbacks = String(settings?.quarterbacks) === "2QB" ? 2 : 1;
  return { QB: teams * quarterbacks, RB: Math.round(teams * 2.5), WR: Math.round(teams * 3.5), TE: teams };
}

export function applyProjectionModel(rows, historyBundle, newsBundle, settings, projectionSeason) {
  const baseRows = (rows || []).map(row => ({ ...row }));
  const samples = buildPositionSamples(baseRows, historyBundle, newsBundle, settings);
  const context = {
    reports: reportLookup(newsBundle),
    curves: Object.fromEntries(POSITIONS.map(position => [position, positionAgeCurve(samples, position)])),
  };
  const modeled = baseRows.map(row => {
    const projection = projectPlayer(row, historyBundle, newsBundle, settings, projectionSeason, samples, context);
    if (!projection) return row;
    return {
      ...row,
      age: projection.age,
      projected_ppg: projection.projected_ppg,
      projected_points: projection.projected_points,
      projected_17_game_pace: projection.projected_17_game_pace,
      projection_expected_games: projection.expected_games,
      projection_low: projection.expected_low,
      projection_high: projection.expected_high,
      projection_stddev: projection.projection_stddev,
      position_mean_ppg: projection.position_mean_ppg,
      position_stddev_ppg: projection.position_stddev_ppg,
      position_sample: projection.position_sample,
      age_adjustment_pct: projection.age_adjustment_pct,
      age_change_sample: projection.age_change_sample,
      projection_history_seasons: projection.history_seasons,
      projection_source: projection.source,
    };
  });

  const expected = marketExpectation(modeled);
  modeled.forEach(row => {
    row.market_expected_points = expected.get(row) ?? null;
    row.market_value = row.market_expected_points === null || numberOrNull(row.projected_points) === null
      ? null
      : Number(row.projected_points) - row.market_expected_points;
    row.market_draft_tag = marketTag(row.market_value, row.adp);
    row.draft_tag = row.market_draft_tag;
  });

  POSITIONS.forEach(position => {
    const group = modeled
      .filter(row => row.pos === position)
      .sort((left, right) => (numberOrNull(right.projected_points) ?? -Infinity) - (numberOrNull(left.projected_points) ?? -Infinity));
    group.forEach((row, index) => { row.position_rank = `${position}${index + 1}`; });
  });

  const counts = replacementCounts(settings);
  POSITIONS.forEach(position => {
    const points = modeled
      .filter(row => row.pos === position)
      .map(row => numberOrNull(row.projected_points))
      .filter(Number.isFinite)
      .sort((left, right) => right - left);
    const replacement = points.length ? points[Math.min(counts[position], points.length - 1)] : 0;
    modeled.filter(row => row.pos === position).forEach(row => {
      row.vorp = numberOrNull(row.projected_points) === null ? null : Number(row.projected_points) - replacement;
    });
  });

  modeled.sort((left, right) =>
    (numberOrNull(right.vorp) ?? -Infinity) - (numberOrNull(left.vorp) ?? -Infinity)
    || (numberOrNull(right.projected_points) ?? -Infinity) - (numberOrNull(left.projected_points) ?? -Infinity)
    || (numberOrNull(left.adp) ?? Infinity) - (numberOrNull(right.adp) ?? Infinity)
  );
  modeled.forEach((row, index) => {
    row.overall_rank = index + 1;
    row.value_vs_adp = numberOrNull(row.adp) === null ? null : Number(row.adp) - row.overall_rank;
  });
  return { rows: modeled, samples };
}

export function roundPositionExpectations(rows, teams, maximumRound = 15) {
  const teamCount = Math.max(1, Number(teams) || 12);
  const groups = new Map();
  (rows || []).forEach(row => {
    const adp = numberOrNull(row.adp);
    const points = numberOrNull(row.projected_points);
    if (adp === null || points === null || !POSITIONS.includes(row.pos)) return;
    const round = Math.ceil(adp / teamCount);
    if (round < 1 || round > maximumRound) return;
    const key = `${round}|${row.pos}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(points);
  });
  const result = [];
  for (let round = 1; round <= maximumRound; round += 1) {
    POSITIONS.forEach(position => {
      const values = groups.get(`${round}|${position}`) || [];
      result.push({
        round,
        pos: position,
        mean: average(values),
        stddev: sampleStandardDeviation(values),
        count: values.length,
      });
    });
  }
  return result;
}

export { POSITIONS };
