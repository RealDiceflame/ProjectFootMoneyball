import {validGameId} from "./game-data.mjs?v=20261030-historical1";

const GROUPS = ["offense", "defense", "st"];

// Participation stays separate from production: a missing row is not a DNP.
export function validateSnapCounts(bundle, gameId) {
  if (!validGameId(gameId) || bundle?.schema_version !== 1 || bundle.game_id !== gameId
      || bundle.season !== Number(gameId.slice(0, 4)) || !Array.isArray(bundle.players)) {
    throw new Error("Invalid participation snapshot");
  }
  const teams = gameId.split("_").slice(2), pfrIds = new Set(), playerIds = new Set();
  if (typeof bundle.updated_at !== "string" || !Number.isFinite(Date.parse(bundle.updated_at))) {
    throw new Error("Missing participation timestamp");
  }
  for (const row of bundle.players) {
    if (!row || !teams.includes(row.team) || typeof row.player_name !== "string" || !row.player_name.trim()
        || typeof row.pfr_player_id !== "string" || !/^[A-Za-z0-9._'-]{1,32}$/.test(row.pfr_player_id)
        || pfrIds.has(row.pfr_player_id) || (row.player_id !== null && !/^00-\d{7}$/.test(row.player_id))) {
      throw new Error("Invalid participation identity");
    }
    if (row.player_id && playerIds.has(row.player_id)) throw new Error("Duplicate participation identity");
    if (row.data_issues !== undefined) {
      if (!Array.isArray(row.data_issues) || row.data_issues.length > 6 || row.data_issues.some(issue =>
        !issue || !GROUPS.some(group => issue.field === `${group}_pct`)
        || row[issue.field] !== null || typeof issue.source_value !== "string" || issue.source_value.length > 64
        || typeof issue.reason !== "string" || !issue.reason.trim() || issue.reason.length > 240)) {
        throw new Error("Invalid participation source issue");
      }
    }
    pfrIds.add(row.pfr_player_id);
    if (row.player_id) playerIds.add(row.player_id);
    for (const group of GROUPS) {
      const count = row[`${group}_snaps`], pct = row[`${group}_pct`];
      if (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 300)) throw new Error("Invalid snap count");
      if (pct !== null && (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1)) throw new Error("Invalid snap percentage");
      if (count === 0 && pct > 0) throw new Error("Inconsistent snap count");
    }
  }
  if (new Set(bundle.players.map(row => row.team)).size !== 2) throw new Error("Incomplete participation teams");
  return bundle;
}

export function snapValue(count, pct) {
  const snaps = count === null || count === undefined ? "—" : String(count);
  const share = pct === null || pct === undefined ? "—" : `${Number((pct * 100).toFixed(1))}%`;
  return `${snaps} · ${share}`;
}

export function snapRowsForTeam(bundle, team) {
  return bundle.players.filter(row => row.team === team).slice().sort((a, b) =>
    ((b.offense_snaps ?? 0) + (b.defense_snaps ?? 0) + (b.st_snaps ?? 0))
    - ((a.offense_snaps ?? 0) + (a.defense_snaps ?? 0) + (a.st_snaps ?? 0))
    || a.player_name.localeCompare(b.player_name) || a.pfr_player_id.localeCompare(b.pfr_player_id));
}
