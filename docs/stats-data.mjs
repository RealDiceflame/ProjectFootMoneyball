import {TEAM_NAMES, scoreDisplay} from "./scores-data.mjs?v=20260915-weather1";
import {validGameId} from "./game-data.mjs?v=20260915-games1";

export function statsSummary(value, season) {
  if (value?.schema_version !== 1 || value.season !== season || value.season_type !== "REG"
      || !Number.isFinite(Date.parse(value.checked_at)) || !Array.isArray(value.games)
      || !Array.isArray(value.metrics) || !value.periods?.all) throw new Error("Stats snapshot unavailable");
  const seen = new Set();
  for (const game of value.games) {
    if (!validGameId(game?.game_id) || Number(game.game_id.slice(0,4)) !== season || seen.has(game.game_id)
        || !TEAM_NAMES[game.home] || !TEAM_NAMES[game.away] || game.home === game.away
        || !Number.isInteger(game.week) || game.week < 1 || game.week > 18
        || typeof game.stats_available !== "boolean") throw new Error("Invalid stats game");
    seen.add(game.game_id);
  }
  for (const [key,period] of Object.entries(value.periods)) {
    const available=value.games.filter(game=>game.stats_available&&(key==="all"||String(game.week)===key));
    if (!Number.isInteger(period.game_count) || !Array.isArray(period.game_ids)
        || period.game_count !== period.game_ids.length || period.game_count !== available.length
        || new Set(period.game_ids).size !== period.game_count
        || available.some(game=>!period.game_ids.includes(game.game_id)) || !period.leaders) throw new Error("Invalid stats coverage");
    for (const metric of value.metrics) {
      const rows = period.leaders[metric.key];
      if (typeof metric.key !== "string" || typeof metric.label !== "string" || typeof metric.group !== "string"
          || !Array.isArray(rows) || rows.length > 10 || rows.some(row=>!row.player_id || typeof row.player !== "string"
            || !Array.isArray(row.teams) || !Number.isFinite(row.value) || !Number.isInteger(row.rank))) throw new Error("Invalid league leaders");
    }
  }
  return value;
}

export function defaultStatsWeek(summary, leaders = false) {
  if (leaders) return "all";
  return String(Math.max(0,...summary.games.filter(game=>game.stats_available).map(game=>game.week)) || 1);
}

export function selectedGames(summary, week, now = Date.now()) {
  return summary.games.filter(game=>(week === "all" || String(game.week) === week)
    && (game.stats_available || scoreDisplay(game, now).home !== "—"))
    .sort((a,b)=>b.week-a.week || String(a.kickoff || "").localeCompare(String(b.kickoff || "")));
}

export function coverageText(summary, week, now = Date.now()) {
  const available = summary.periods[week]?.game_count || 0;
  const pending = selectedGames(summary,week,now).filter(game=>!game.stats_available).length;
  return `${summary.season} regular season · ${week === "all" ? "Season totals" : "Week " + week} · ${available} game box score${available === 1 ? "" : "s"}`
    + (pending ? ` · ${pending} reported game${pending === 1 ? "" : "s"} awaiting stats` : "");
}
