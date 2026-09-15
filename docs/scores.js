import {TEAM_NAMES, scoreboardGames, defaultScoreWeek, scoreDisplay, scoreboardStale, gameConditions} from "./scores-data.mjs?v=20260915-weather1";
import {teamMark} from "./team-logos.mjs?v=20260915-games1";
const list = document.getElementById("score-games"), select = document.getElementById("score-week"), status = document.getElementById("score-status");
const previous = document.getElementById("score-prev"), next = document.getElementById("score-next");
const el = (tag, text, className) => {const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;};
let bundle, games = [], busy = false, lastAttempt = 0, userSelectedWeek = false;
let renderedKey = null, renderedWeek = null;

function updateTickerControls() {
  previous.disabled = list.scrollLeft <= 1;
  next.disabled = list.scrollWidth - list.clientWidth - list.scrollLeft <= 1;
}

function render() {
  const selected = games.filter(game => game.week === Number(select.value));
  const weekKey = `${bundle.season}:${select.value}`;
  const key = JSON.stringify([weekKey, selected.map(game => [game, scoreDisplay(game), gameConditions(game)])]);
  if (key !== renderedKey) {
    const scrollLeft = renderedWeek === weekKey ? list.scrollLeft : 0;
    const focusedGame = document.activeElement?.dataset?.gameId;
    const cards = selected.map(game => {
      const card = el("a", undefined, "home-score-card"), display = scoreDisplay(game);
      card.dataset.gameId = game.game_id;
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
        {weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit"}) : `${game.gameday || "Date TBD"} · Time TBD`);
      if (Number.isFinite(kickoff)) time.dateTime = game.kickoff;
      const conditions = gameConditions(game);
      const fullTime = Number.isFinite(kickoff) ? new Date(kickoff).toLocaleString(undefined,
        {month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"}) : "Time TBD";
      const details = `${fullTime}. ${game.stadium || conditions.location}. ${conditions.location}. ${conditions.weather}. View game stats.`;
      card.title = details;
      card.append(time, el("span", details, "home-score-extra")); return card;
    });
    list.replaceChildren(...cards);
    list.scrollLeft = scrollLeft;
    if (focusedGame) cards.find(card => card.dataset.gameId === focusedGame)?.focus({preventScroll:true});
    renderedKey = key; renderedWeek = weekKey;
  }
  if (!list.children.length) list.append(el("p", "No games available for this week."));
  updateTickerControls();
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
previous.addEventListener("click", () => list.scrollBy({left:-Math.max(184,list.clientWidth*.8),behavior:"auto"}));
next.addEventListener("click", () => list.scrollBy({left:Math.max(184,list.clientWidth*.8),behavior:"auto"}));
list.addEventListener("scroll", updateTickerControls, {passive:true});
globalThis.addEventListener?.("resize", updateTickerControls);
document.addEventListener("visibilitychange", () => {if (!document.hidden && Date.now()-lastAttempt >= 60000) load();});
// Only reread our shared published snapshot; visitors never call a score provider.
setInterval(load, 60000);
load();
