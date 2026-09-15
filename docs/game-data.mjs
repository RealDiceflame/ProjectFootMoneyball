export const ID_FIELDS = new Set(["player_id","player_name","player_display_name","position","position_group","headshot_url","season","week","season_type","game_id","team","opponent_team"]);
export const TEAM_SUMMARY = ["completions","attempts","passing_yards","passing_tds","passing_interceptions",
  "carries","rushing_yards","rushing_tds","def_sacks","def_interceptions","fg_made","fg_att","penalties","penalty_yards"];
const GROUPS = [
  ["Passing", /^(completions$|attempts$|passing_|sack_|sacks_suffered$)/],
  ["Rushing", /^(carries$|rushing_)/],
  ["Receiving", /^(targets$|receptions$|receiving_|target_share$|air_yards_share$|wopr$|racr$)/],
  ["Defense", /^def_/], ["Kicking", /^(fg_|pat_|gwfg_)/], ["Punting", /^pt_/],
  ["Returns", /^(punt_return|kickoff_return|kick_return)/], ["Fantasy", /^fantasy_/],
];

export function validGameId(value) {
  return typeof value === "string" && /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(value);
}

export function unpackStats(bundle, gameId) {
  if (!bundle || bundle.schema_version !== 1 || bundle.game?.game_id !== gameId) throw new Error("Invalid game snapshot");
  const unpack = kind => {
    const columns = bundle[kind === "players" ? "player_columns" : "team_columns"], rows = bundle[kind];
    if (!Array.isArray(columns) || new Set(columns).size !== columns.length || !columns.includes("team")
        || !Array.isArray(rows)) throw new Error("Invalid stats columns");
    return rows.map(row => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new Error("Incomplete stats row");
      const record = Object.fromEntries(columns.map((column,index) => [column,row[index]]));
      if (record.game_id !== gameId || ![bundle.game.home,bundle.game.away].includes(record.team)) throw new Error("Mismatched game row");
      return record;
    });
  };
  const teams = unpack("teams"), players = unpack("players");
  if (teams.length !== 2 || new Set(teams.map(row=>row.team)).size !== 2) throw new Error("Incomplete team stats");
  return {teams, players};
}

export function statGroups(columns) {
  const groups = new Map(GROUPS.map(([name]) => [name, []]));
  groups.set("Other", []);
  for (const key of columns.filter(column => !ID_FIELDS.has(column))) {
    const name = GROUPS.find(([,pattern]) => pattern.test(key))?.[0] || "Other";
    groups.get(name).push(key);
  }
  return [...groups].filter(([,keys])=>keys.length);
}

export function statLabel(key) {
  const labels = {completions:"Completions", attempts:"Pass attempts", carries:"Rush attempts", receptions:"Receptions",
    passing_tds:"Passing TDs", rushing_tds:"Rushing TDs", receiving_tds:"Receiving TDs",
    fg_att:"FG attempts", fg_made:"FG made", pat_att:"Extra-point attempts", pat_made:"Extra points made",
    pt_att:"Punts", pt_yards:"Punt yards", pt_net_yards:"Net punt yards", def_sacks:"Sacks",
    def_tackles_solo:"Solo tackles", def_tackle_assists:"Tackle assists"};
  return labels[key] || key.replaceAll("_"," ").replace(/\b(def|fg|pat|pt|tds|epa|cpoe|wopr|racr|pct)\b/g, word=>word.toUpperCase())
    .replace(/^./,letter=>letter.toUpperCase());
}

export function statValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(undefined,{maximumFractionDigits:3}) : String(value);
}

export function activeStatRows(rows, keys) {
  return rows.filter(row => keys.some(key => row[key] !== null && row[key] !== undefined && row[key] !== "" && row[key] !== 0));
}
