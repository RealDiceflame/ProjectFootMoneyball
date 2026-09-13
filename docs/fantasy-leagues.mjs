// League setup is independent of the page so a future server can validate the same rules.
export const STORAGE_KEY = "outlierbaseline:fantasy-leagues:v1";
export const TEAM_COUNTS = [8, 10, 12, 14, 16];
export const SLOT_LIMITS = {
  QB: [1, 2], RB: [1, 4], WR: [1, 5], TE: [1, 3], FLEX: [0, 3],
  SUPERFLEX: [0, 1], K: [0, 1], DST: [0, 1], BN: [0, 12], IR: [0, 4],
};
export const DEFAULT_ROSTER = {QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 1, DST: 1, BN: 6, IR: 1};
const MAX_LEAGUES = 30;

function text(value, label, max = 60) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label} must contain 1–${max} characters.`);
  return value.trim();
}

function integer(value, min, max, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

function choice(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`${label} is not supported in this prototype.`);
  return value;
}

function identifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new Error("Invalid league or team identifier.");
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid saved date.");
  return new Date(value).toISOString();
}

export function validateLeague(input) {
  if (!input || typeof input !== "object" || input.provider !== "outlierbaseline" || input.status !== "setup") throw new Error("Only OutlierBaseline setup prototypes can be loaded here.");
  const teamCount = choice(input.team_count, TEAM_COUNTS, "Team count");
  if (!Array.isArray(input.teams) || input.teams.length !== teamCount) throw new Error("The team list must match the league size.");
  const teams = input.teams.map(team => ({id: identifier(team?.id), name: text(team?.name, "Team name", 50)}));
  if (new Set(teams.map(team => team.id)).size !== teamCount) throw new Error("Team identifiers must be unique.");
  if (new Set(teams.map(team => team.name.toLowerCase())).size !== teamCount) throw new Error("Give each team a different name.");
  const roster = Object.fromEntries(Object.entries(SLOT_LIMITS).map(([slot, [min, max]]) => [slot, integer(input.roster?.[slot], min, max, slot)]));
  return {
    id: identifier(input.id), provider: "outlierbaseline", status: "setup",
    name: text(input.name, "League name"), season: integer(input.season, 2020, 2100, "Season"),
    team_count: teamCount,
    scoring: {
      ppr: choice(input.scoring?.ppr, [0, 0.5, 1], "PPR"),
      te_premium: choice(input.scoring?.te_premium, [0, 0.5, 1], "TE premium"),
      passing_td: choice(input.scoring?.passing_td, [4, 6], "Passing TD points"),
    },
    roster, teams, created_at: timestamp(input.created_at), updated_at: timestamp(input.updated_at),
  };
}

export function createLeague(settings, {id = () => crypto.randomUUID(), now = new Date().toISOString()} = {}) {
  return validateLeague({
    ...settings, id: id(), provider: "outlierbaseline", status: "setup",
    teams: Array.from({length: choice(settings.team_count, TEAM_COUNTS, "Team count")}, (_, index) => ({id: id(), name: `Team ${index + 1}`})),
    created_at: now, updated_at: now,
  });
}

export function updateLeague(existing, settings, now = new Date().toISOString()) {
  if (settings.team_count !== existing.team_count) throw new Error("Create a new setup to change the team count in this prototype.");
  return validateLeague({...existing, ...settings, id: existing.id, provider: existing.provider, status: existing.status, created_at: existing.created_at, updated_at: now});
}

export function validateStore(input) {
  if (!input || input.schema_version !== 1 || input.mode !== "local-prototype" || !Array.isArray(input.leagues)) throw new Error("This is not an OutlierBaseline league-setup backup (version 1).");
  if (input.leagues.length > MAX_LEAGUES) throw new Error(`This prototype supports up to ${MAX_LEAGUES} saved leagues.`);
  const leagues = input.leagues.map(validateLeague);
  if (new Set(leagues.map(league => league.id)).size !== leagues.length) throw new Error("League identifiers must be unique.");
  return {schema_version: 1, mode: "local-prototype", leagues};
}

export function emptyStore() { return {schema_version: 1, mode: "local-prototype", leagues: []}; }

export function parseBackup(raw) {
  if (typeof raw !== "string" || raw.length > 1024 * 1024) throw new Error("Choose a league-setup JSON backup smaller than 1 MB.");
  try { return validateStore(JSON.parse(raw)); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("The backup is not valid JSON."); throw error; }
}

export function importCopies(current, incoming, {id = () => crypto.randomUUID(), now = new Date().toISOString()} = {}) {
  const originals = validateStore(current), backup = validateStore(incoming);
  const copies = backup.leagues.map(league => validateLeague({
    ...league, id: id(), name: `${league.name.slice(0, 53)} (copy)`,
    teams: league.teams.map(team => ({...team, id: id()})), created_at: now, updated_at: now,
  }));
  return validateStore({...originals, leagues: [...originals.leagues, ...copies]});
}

export function rosterSummary(roster) {
  const starters = Object.entries(roster).filter(([slot]) => !["BN", "IR"].includes(slot)).reduce((sum, [, count]) => sum + count, 0);
  return {starters, bench: roster.BN, reserve: roster.IR, total: starters + roster.BN + roster.IR};
}
