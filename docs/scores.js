import {TEAM_NAMES, scoreboardGames, defaultScoreWeek, scoreDisplay, scoreboardStale, gameConditions} from "./scores-data.mjs?v=20260915-weather1";
import {teamMark} from "./team-logos.mjs?v=20260915-games1";
const list = document.getElementById("score-games"), select = document.getElementById("score-week"), status = document.getElementById("score-status");
const el = (tag, text, className) => {const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;};
let bundle, games = [], busy = false, lastAttempt = 0, userSelectedWeek = false;

function render() {
  list.replaceChildren(...games.filter(game => game.week === Number(select.value)).map(game => {
    const card = el("a", undefined, "home-score-card"), display = scoreDisplay(game);
    card.href = `game.html?game=${encodeURIComponent(game.game_id)}`;
    card.append(el("span", display.label, "home-score-label"));
    for (const side of ["away", "home"]) {
      const row = el("div", undefined, "home-score-team");
      const team = el("span", undefined, "home-score-name"); team.title = game[side];
      team.append(teamMark(game[side]), el("span", TEAM_NAMES[game[side]]));
      row.append(team, el("strong", display[side])); card.append(row);
    }
    const kickoff = Date.parse(game.kickoff);
    const time = el("time", Number.isFinite(kickoff) ? new Date(kickoff).toLocaleString(undefined,
      {weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZoneName:"short"}) : `${game.gameday || "Date TBD"} · Time TBD`);
    if (Number.isFinite(kickoff)) time.dateTime = game.kickoff;
    const conditions = gameConditions(game);
    const location = el("span", conditions.location, "home-score-location");
    location.title = game.stadium || conditions.location;
    card.append(time, location, el("span", conditions.weather, "home-score-weather"),
      el("span", "Game stats →", "home-score-link")); return card;
  }));
  if (!list.children.length) list.append(el("p", "No games available for this week."));
  const stale = scoreboardStale(bundle);
  status.textContent = `Checked ${new Date(bundle.checked_at).toLocaleString(undefined, {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}${stale ? " · Update delayed" : ""}`;
  status.classList.toggle("stale", stale);
}

async function load() {
  if (busy || document.hidden) return;
  busy = true; lastAttempt = Date.now();
  try {
    const response = await fetch("data/scores.json", {cache:"no-store", signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error("Scores unavailable");
    const next = await response.json(), nextGames = scoreboardGames(next);
    if (!nextGames.length) throw new Error("No games");
    const previousWeek = userSelectedWeek && bundle?.season === next.season ? Number(select.value) : null;
    // Freshness and rendering both use validated rows, never the raw response.
    const candidate = {...next, games: nextGames};
    scoreboardStale(candidate);
    bundle = candidate; games = nextGames;
    const weeks = [...new Set(games.map(game => game.week))];
    select.replaceChildren(...weeks.map(week => {const option = el("option", `${bundle.season} · Week ${week}`); option.value = String(week); return option;}));
    select.value = String(weeks.includes(previousWeek) ? previousWeek : defaultScoreWeek(games));
    select.disabled = false; render();
  } catch {
    if (bundle) {render(); status.textContent += " · Refresh unavailable";}
    else {status.textContent = "Scores temporarily unavailable"; list.replaceChildren(el("p", "Please try again later."));}
    status.classList.add("stale");
  } finally {busy = false;}
}
select.addEventListener("change", () => {userSelectedWeek = true; render();});
document.addEventListener("visibilitychange", () => {if (!document.hidden && Date.now()-lastAttempt >= 60000) load();});
// Only reread our shared published snapshot; visitors never call a score provider.
setInterval(load, 60000);
load();
