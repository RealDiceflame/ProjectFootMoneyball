const record = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const columnsValid = columns => Array.isArray(columns) && columns.length > 0
  && columns.every(key => typeof key === "string" && key.length > 0) && new Set(columns).size === columns.length;
const arrayOfRecords = value => Array.isArray(value) && value.every(record);
export function validateColumnar(value, required, rows = value?.rows) {
  if (!record(value) || !columnsValid(value.columns) || !required.every(key => value.columns.includes(key))
      || !Array.isArray(rows) || !rows.length
      || rows.some(row => !Array.isArray(row) || row.length !== value.columns.length)) return false;
  const player = value.columns.indexOf("player"), pos = value.columns.indexOf("pos");
  return rows.every(row => typeof row[player] === "string" && row[player].trim() && typeof row[pos] === "string");
}
export function validateRankings(value) {
  return record(value) && Number.isInteger(value.projection_season) && record(value.boards)
    && Object.keys(value.boards).length > 0
    && Object.values(value.boards).every(rows => validateColumnar(value, ["player", "team", "pos", "projected_points", "overall_rank"], rows));
}
export const validateReports = value => record(value) && record(value.reports)
  && (value.injury_context == null || (record(value.injury_context)
    && (value.injury_context.teams == null || (Array.isArray(value.injury_context.teams) && value.injury_context.teams.every(team => typeof team === "string")))))
  && Object.values(value.reports).every(report => record(report)
    && (report.events == null || arrayOfRecords(report.events))
    && (report.sources == null || arrayOfRecords(report.sources))
    && (report.injury == null || (record(report.injury) && (report.injury.injuries == null || Array.isArray(report.injury.injuries))))
    && ["current_team", "team", "player", "pos"].every(key => report[key] == null || typeof report[key] === "string"));
export const validateHistory = value => record(value) && record(value.players) && columnsValid(value.columns)
  && ["season", "games", "pos"].every(key => value.columns.includes(key))
  && (value.seasons == null || (Array.isArray(value.seasons) && value.seasons.every(Number.isInteger)))
  && Object.values(value.players).every(player => record(player) && typeof player.player === "string"
    && typeof player.pos === "string" && Array.isArray(player.seasons)
    && player.seasons.every(row => Array.isArray(row) && row.length === value.columns.length));
export const validateSpecialTeams = value => validateColumnar(value, ["player", "team", "pos", "adp"]);
export function validateOdds(value) {
  return record(value) && Array.isArray(value.weeks) && value.weeks.every(week => Number.isInteger(week) && week >= 1 && week <= 22)
    && ["source_health", "sources"].every(key => value[key] == null || (record(value[key]) && Object.values(value[key]).every(record)))
    && (value.prediction_markets === undefined || (arrayOfRecords(value.prediction_markets)
      && value.prediction_markets.every(market => ["title", "url"].every(key => market[key] == null || typeof market[key] === "string")
        && (market.contracts === undefined || (arrayOfRecords(market.contracts) && market.contracts.every(contract =>
          typeof contract.label === "string" && Number.isFinite(contract.probability) && contract.probability >= 0 && contract.probability <= 1))))))
    && Array.isArray(value.games) && value.games.every(game => record(game) && typeof game.game_id === "string"
      && typeof game.away === "string" && typeof game.home === "string" && Number.isInteger(game.week)
      && Array.isArray(game.rows) && game.rows.every(row => record(row)
        && ["provider_key", "provider", "provider_kind", "selection", "market"].every(key => typeof row[key] === "string")));
}
