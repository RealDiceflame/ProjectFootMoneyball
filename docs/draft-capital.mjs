import {fantasyPoints} from "./player-history.mjs?v=20260909-archive1";
import {POSITIONS, roundPositionExpectations} from "./projection-model.mjs?v=20260909-capital1";

export function historicalRoundExpectations(bundle, settings, selectedSeason = "all", maximumRound = 15) {
  const available = [...new Set((bundle?.seasons || []).filter(Number.isInteger))].sort((a, b) => a - b);
  const seasons = selectedSeason === "all" ? available : available.filter(s => String(s) === String(selectedSeason));
  const rows = [], seen = new Set();
  const coverage = {adp_players: 0, matched: 0, missing_stats: 0, ambiguous: 0};
  for (const season of seasons) {
    const year = bundle.years?.[season];
    if (!year || !Array.isArray(bundle.columns)) continue;
    for (const field of Object.keys(coverage)) coverage[field] += Number(year.coverage?.[field]) || 0;
    for (const values of year.rows || []) {
      const row = Object.fromEntries(bundle.columns.map((column, index) => [column, values[index]]));
      const key = `${row.season}|${row.player_id}`;
      if (row.season !== season || !row.player_id || !POSITIONS.includes(row.pos) || !Number.isFinite(row.adp) || row.adp <= 0 || !Number.isFinite(row.games) || row.games <= 0 || seen.has(key)) continue;
      seen.add(key);
      rows.push({...row, actual_points: fantasyPoints(row, settings)});
    }
  }
  const teamCount = Math.max(1, Number(settings?.teams) || 12);
  const cells = roundPositionExpectations(rows, teamCount, maximumRound, "actual_points").map(cell => {
    const group = rows.filter(row => row.pos === cell.pos && Math.ceil(row.adp / teamCount) === cell.round);
    return {...cell, season_count: new Set(group.map(row => row.season)).size,
      player_count: new Set(group.map(row => row.player_id)).size};
  });
  return {cells, seasons, coverage, in_rounds: cells.reduce((n, cell) => n + cell.count, 0), rows};
}
