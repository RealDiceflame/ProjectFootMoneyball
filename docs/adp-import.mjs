const PLAYER_HEADERS = new Set(["player", "playername", "name", "fullname", "athlete"]);
const TEAM_HEADERS = new Set(["team", "nflteam", "proteam"]);
const POSITION_HEADERS = new Set(["position", "pos", "fantasyposition"]);
const PLAYER_ID_HEADERS = new Set(["playerid", "gsisid", "nflid"]);
const POSITION_PATTERN = /(?:^|[^A-Z])(QB|RB|WR|TE)(?:[^A-Z]|$)/i;

function normalizedHeader(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizedName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedTeam(value) {
  const team = String(value || "").trim().toUpperCase();
  return { JAC: "JAX", STL: "LAR", SD: "LAC", OAK: "LV" }[team] || team;
}

function normalizedPosition(value) {
  const match = String(value || "").toUpperCase().match(POSITION_PATTERN);
  return match ? match[1].toUpperCase() : "";
}

function adpNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(/,/g, "");
  if (!cleaned || cleaned === "-") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) && number > 0 && number < 999 ? number : null;
}

function detectDelimiter(text) {
  let quoted = false;
  const counts = new Map([[",", 0], ["\t", 0], [";", 0]]);
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (character === "\n" || character === "\r")) {
      break;
    } else if (!quoted && counts.has(character)) {
      counts.set(character, counts.get(character) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
}

export function parseDelimitedText(rawText) {
  const text = String(rawText || "").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("The selected file is empty.");
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("The file contains an unfinished quoted value.");
  row.push(cell.trim());
  if (row.some(value => value !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("The file needs a header and at least one player row.");
  return rows;
}

function headerIndex(headers, aliases) {
  return headers.findIndex(header => aliases.has(normalizedHeader(header)));
}

export function providerForColumn(column) {
  const header = normalizedHeader(column);
  if (["y", "yahoo", "yahooadp"].includes(header)) return "Yahoo";
  if (["sleeper", "sleeperadp"].includes(header)) return "Sleeper";
  if (["nfl", "nfladp", "espn", "espnadp", "nflespn"].includes(header)) return "NFL";
  return null;
}

export function inspectAdpText(text) {
  const matrix = parseDelimitedText(text);
  const headers = matrix[0].map((header, index) => String(header || `Column ${index + 1}`).trim());
  const playerIndex = headerIndex(headers, PLAYER_HEADERS);
  if (playerIndex < 0) throw new Error("No Player or Name column was found.");
  const teamIndex = headerIndex(headers, TEAM_HEADERS);
  const positionIndex = headerIndex(headers, POSITION_HEADERS);
  const playerIdIndex = headerIndex(headers, PLAYER_ID_HEADERS);
  const identityIndexes = new Set([playerIndex, teamIndex, positionIndex, playerIdIndex].filter(index => index >= 0));
  const candidates = headers
    .map((header, index) => {
      const values = matrix.slice(1).map(row => adpNumber(row[index])).filter(value => value !== null);
      return { header, index, numericCount: values.length, provider: providerForColumn(header) };
    })
    .filter(candidate => !identityIndexes.has(candidate.index) && candidate.numericCount > 0);
  if (!candidates.length) throw new Error("No numeric ADP column was found.");

  const preferred = candidates.find(candidate => candidate.provider === "Yahoo")
    || candidates.find(candidate => normalizedHeader(candidate.header) === "adp")
    || candidates[0];
  return {
    headers,
    rows: matrix.slice(1),
    playerIndex,
    teamIndex,
    positionIndex,
    playerIdIndex,
    candidates,
    preferredColumn: preferred.header,
  };
}

export function buildPersonalAdp(parsed, column, { fileName = "Imported ADP", snapshotDate = "" } = {}) {
  const candidate = parsed.candidates.find(item => item.header === column);
  if (!candidate) throw new Error("Choose an ADP column from the selected file.");
  const entries = [];
  for (const row of parsed.rows) {
    const player = String(row[parsed.playerIndex] || "").trim();
    const adp = adpNumber(row[candidate.index]);
    if (!player || adp === null) continue;
    entries.push({
      player,
      playerId: parsed.playerIdIndex >= 0 ? String(row[parsed.playerIdIndex] || "").trim() : "",
      team: parsed.teamIndex >= 0 ? normalizedTeam(row[parsed.teamIndex]) : "",
      position: parsed.positionIndex >= 0 ? normalizedPosition(row[parsed.positionIndex]) : "",
      adp,
    });
  }
  if (!entries.length) throw new Error(`The ${column} column has no usable ADP values.`);
  return {
    version: 1,
    fileName,
    column,
    provider: candidate.provider,
    snapshotDate,
    importedAt: new Date().toISOString(),
    entries,
  };
}

function uniqueLookup(items, keyBuilder) {
  const lookup = new Map();
  const duplicates = new Set();
  items.forEach(item => {
    const key = keyBuilder(item);
    if (!key) return;
    if (lookup.has(key)) duplicates.add(key);
    else lookup.set(key, item);
  });
  duplicates.forEach(key => lookup.delete(key));
  return lookup;
}

function keyCounts(items, keyBuilder) {
  const counts = new Map();
  items.forEach(item => {
    const key = keyBuilder(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

export function applyPersonalAdp(rows, snapshot) {
  if (!snapshot?.entries?.length) return { rows: rows.map(row => ({ ...row })), matched: 0 };
  const entries = snapshot.entries.map(entry => ({
    ...entry,
    _name: normalizedName(entry.player),
    _team: normalizedTeam(entry.team),
    _position: normalizedPosition(entry.position),
  }));
  const byId = uniqueLookup(entries, entry => String(entry.playerId || "").trim());
  const byNamePositionTeam = uniqueLookup(entries, entry => entry._name && entry._position && entry._team ? `${entry._name}|${entry._position}|${entry._team}` : "");
  const byNamePosition = uniqueLookup(entries, entry => entry._name && entry._position ? `${entry._name}|${entry._position}` : "");
  const byNameTeam = uniqueLookup(entries, entry => entry._name && entry._team ? `${entry._name}|${entry._team}` : "");
  const byName = uniqueLookup(entries, entry => entry._name);
  const preparedRows = rows.map(row => ({
    row,
    name: normalizedName(row.player),
    position: normalizedPosition(row.pos),
    team: normalizedTeam(row.current_team || row.team),
    listedTeam: normalizedTeam(row.listed_team || row.team),
  }));
  const baseNamePositionCounts = keyCounts(preparedRows, item => item.name && item.position ? `${item.name}|${item.position}` : "");
  const baseNameTeamCounts = keyCounts(preparedRows, item => item.name && item.team ? `${item.name}|${item.team}` : "");
  const baseNameCounts = keyCounts(preparedRows, item => item.name);
  let matched = 0;
  const updated = preparedRows.map(({ row, name, position, team, listedTeam }) => {
    const id = String(row.player_id || "").trim();
    const entry = (id && byId.get(id))
      || byNamePositionTeam.get(`${name}|${position}|${team}`)
      || byNamePositionTeam.get(`${name}|${position}|${listedTeam}`)
      || (baseNamePositionCounts.get(`${name}|${position}`) === 1 && byNamePosition.get(`${name}|${position}`))
      || (baseNameTeamCounts.get(`${name}|${team}`) === 1 && byNameTeam.get(`${name}|${team}`))
      || (baseNameTeamCounts.get(`${name}|${listedTeam}`) === 1 && byNameTeam.get(`${name}|${listedTeam}`))
      || (baseNameCounts.get(name) === 1 && byName.get(name));
    if (!entry) return { ...row };
    matched += 1;
    const next = { ...row, adp: entry.adp, value_vs_adp: entry.adp - Number(row.overall_rank), _personalAdp: true };
    if (snapshot.provider) next[snapshot.provider] = entry.adp;
    return next;
  });
  return { rows: updated, matched };
}

export function marketDraftTag(value) {
  if (!Number.isFinite(value)) return "FAIR";
  if (value >= 50) return "TARGET";
  if (value >= 25) return "VALUE";
  if (value <= -20) return "REACH";
  return "FAIR";
}

export function recalculateMarketMetrics(rows) {
  const groups = new Map();
  rows.forEach(row => {
    const position = normalizedPosition(row.pos);
    if (!groups.has(position)) groups.set(position, []);
    const adp = adpNumber(row.adp);
    const points = Number(row.projected_points);
    if (adp !== null && Number.isFinite(points)) groups.get(position).push({ adp, points });
  });

  const lines = new Map();
  groups.forEach((values, position) => {
    if (values.length < 2) return;
    const meanAdp = values.reduce((total, item) => total + item.adp, 0) / values.length;
    const meanPoints = values.reduce((total, item) => total + item.points, 0) / values.length;
    const denominator = values.reduce((total, item) => total + ((item.adp - meanAdp) ** 2), 0);
    const numerator = values.reduce((total, item) => total + ((item.adp - meanAdp) * (item.points - meanPoints)), 0);
    const slope = denominator === 0 ? 0 : numerator / denominator;
    lines.set(position, { slope, intercept: meanPoints - (slope * meanAdp) });
  });

  return rows.map(row => {
    const next = { ...row };
    const line = lines.get(normalizedPosition(row.pos));
    const adp = adpNumber(row.adp);
    const points = Number(row.projected_points);
    if (!line || adp === null || !Number.isFinite(points)) return next;
    next.market_expected_points = (adp * line.slope) + line.intercept;
    next.market_value = points - next.market_expected_points;
    next.market_draft_tag = marketDraftTag(next.market_value);
    next.draft_tag = next.market_draft_tag;
    return next;
  });
}
