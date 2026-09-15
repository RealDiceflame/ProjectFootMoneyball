export const TEAM_NAMES = {ARI:"Cardinals",ATL:"Falcons",BAL:"Ravens",BUF:"Bills",CAR:"Panthers",CHI:"Bears",CIN:"Bengals",CLE:"Browns",DAL:"Cowboys",DEN:"Broncos",DET:"Lions",GB:"Packers",HOU:"Texans",IND:"Colts",JAX:"Jaguars",KC:"Chiefs",LA:"Rams",LAC:"Chargers",LV:"Raiders",MIA:"Dolphins",MIN:"Vikings",NE:"Patriots",NO:"Saints",NYG:"Giants",NYJ:"Jets",PHI:"Eagles",PIT:"Steelers",SEA:"Seahawks",SF:"49ers",TB:"Buccaneers",TEN:"Titans",WAS:"Commanders"};

export function scoreboardGames(bundle) {
  if (!Array.isArray(bundle?.games) || !Number.isInteger(bundle.season) || !Number.isFinite(Date.parse(bundle.checked_at))) throw new Error("Scores unavailable");
  const seen = new Set();
  return bundle.games.filter(game => {
    if (!game || typeof game.game_id !== "string" || !game.game_id || seen.has(game.game_id)
        || !Object.hasOwn(TEAM_NAMES, game.home) || !Object.hasOwn(TEAM_NAMES, game.away)
        || game.home === game.away || !Number.isInteger(game.week) || game.week < 1 || game.week > 18) return false;
    seen.add(game.game_id); return true;
  }).sort((a,b) => a.week-b.week || String(a.kickoff || a.gameday).localeCompare(String(b.kickoff || b.gameday)));
}

export function defaultScoreWeek(games, now = Date.now()) {
  const weeks = [...new Set(games.map(game => game.week))].sort((a,b) => a-b);
  // Open the next NFL week one day before its first kickoff; retain prior results.
  const opened = weeks.filter(week => Math.min(...games.filter(game => game.week === week)
    .map(game => Date.parse(game.kickoff || `${game.gameday}T12:00:00Z`))) - 24*3600000 <= now);
  return opened.at(-1) || weeks[0] || null;
}

export function scoreDisplay(game, now = Date.now()) {
  const kickoff = Date.parse(game.kickoff);
  const started = Number.isFinite(kickoff) && kickoff <= now;
  const valid = value => Number.isInteger(value) && value >= 0 && value <= 200;
  const reported = started && valid(game.home_score) && valid(game.away_score);
  // The schedule source has no final flag or game clock. Never infer either.
  return {label: reported ? "Reported score" : started ? "Awaiting score" : Number.isFinite(kickoff) ? "Scheduled" : "Time TBD",
    home: reported ? String(game.home_score) : "—", away: reported ? String(game.away_score) : "—"};
}

export function scoreboardStale(bundle, now = Date.now()) {
  const checked = Date.parse(bundle?.checked_at);
  const inWindow = Array.isArray(bundle?.games) && bundle.games.some(game => {const time = Date.parse(game?.kickoff); return Number.isFinite(time) && now >= time-2*3600000 && now <= time+10*3600000;});
  return !Number.isFinite(checked) || checked > now+300000 || now-checked > (inWindow ? 45*60000 : 7*3600000);
}
