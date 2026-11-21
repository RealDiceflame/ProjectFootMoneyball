const record = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const finite = Number.isFinite;
const numericOrNull = value => value === null || finite(value);
const dateValid = value => typeof value === "string" && finite(Date.parse(value));
export function validateValueInputs(value) {
  const required = ["player_id", "player", "pos", "team", "week", "game_id", "kickoff", "analysis_ready", "passing_yards", "passing_tds", "passing_interceptions", "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost_total", "passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions", "special_teams_tds"];
  if (!record(value) || value.schema_version !== 1 || value.season_type !== "REG" || !Number.isInteger(value.season)
    || !dateValid(value.generated_at) || !Array.isArray(value.columns) || new Set(value.columns).size !== value.columns.length
    || !required.every(key => value.columns.includes(key)) || !Array.isArray(value.rows) || !Array.isArray(value.games) || !value.games.length) return false;
  const ids = new Set();
  for (const game of value.games) {
    if (!record(game) || typeof game.game_id !== "string" || ids.has(game.game_id) || !Number.isInteger(game.week)
      || !dateValid(game.kickoff) || typeof game.home !== "string" || typeof game.away !== "string" || game.home === game.away
      || typeof game.analysis_ready !== "boolean") return false;
    ids.add(game.game_id);
  }
  return value.rows.every(values => {
    if (!Array.isArray(values) || values.length !== value.columns.length) return false;
    const row = Object.fromEntries(value.columns.map((key, index) => [key, values[index]]));
    return ["player_id", "player", "pos", "team", "game_id"].every(key => typeof row[key] === "string" && row[key].length > 0)
      && ids.has(row.game_id) && Number.isInteger(row.week) && dateValid(row.kickoff) && typeof row.analysis_ready === "boolean"
      && required.slice(8).every(key => numericOrNull(row[key]));
  });
}
