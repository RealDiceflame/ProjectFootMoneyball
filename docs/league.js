import {DIVISIONS} from "./league-model.mjs?v=20260909-labs2";
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const num = value => Number.isFinite(value) ? value.toFixed(1) : "—";
const pct = value => `${num(value * 100)}%`;
const date = value => new Date(value).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
let data, result, worker;
const name = team => data.teams.find(row => row.team === team)?.name || team;
function table(headers, rows, label) {
  const shell = el("div", undefined, "survivor-table-scroll"), output = el("table", undefined, "survivor-table"), head = el("thead"), heading = el("tr"), body = el("tbody");
  shell.tabIndex = 0; shell.setAttribute("role", "region"); shell.setAttribute("aria-label", label);
  headers.forEach(text => { const th = el("th", text); th.scope = "col"; heading.append(th); }); head.append(heading);
  rows.forEach(values => { const row = el("tr"); values.forEach((value, i) => { const cell = el(i ? "td" : "th", value); if (!i) cell.scope = "row"; row.append(cell); }); body.append(row); });
  output.append(head, body); shell.append(output); return shell;
}
function renderGames() {
  if (!result) return;
  const team = $("league-team").value, week = $("league-week").value;
  const games = result.games.filter(game => (team === "all" || [game.home, game.away].includes(team)) && (week === "all" || game.week === Number(week)));
  const range = stat => `${num(stat.p10)}–${num(stat.p90)}`;
  if (!games.length) { $("league-games").textContent = "No game for this selection (possibly a bye week)."; return; }
  $("league-games").replaceChildren(table(["Week / kickoff", "Game", "Away final points", "Away SD / 80% range", "Home final points", "Home SD / 80% range", "Winner / chances", "Status"], games.map(game => [
    `${game.week} · ${date(game.kickoff)}`, `${game.away} at ${game.home}${game.neutral ? " · neutral" : ""}`, num(game.away_stats.mean), game.final ? "Actual result" : `${num(game.away_stats.sd)} / ${range(game.away_stats)}`,
    num(game.home_stats.mean), game.final ? "Actual result" : `${num(game.home_stats.sd)} / ${range(game.home_stats)}`,
    game.final ? game.home_score === game.away_score ? "Tie" : game.home_score > game.away_score ? game.home : game.away : `${game.away} ${pct(game.away_win)} / ${game.home} ${pct(game.home_win)} / Tie ${pct(game.tie)}`,
    game.final ? "Final · fixed" : game.unresolved ? "Unresolved · NOT a live forecast" : "Simulated forecast"
  ]), "Game-by-game simulated scoring"));
}
function render() {
  const sorted = [...result.teams].sort((a, b) => b.champion_probability - a.champion_probability);
  const metric = (label, value, note) => { const item = el("div"); item.append(el("span", label), el("strong", value), el("small", note)); return item; };
  $("league-summary").replaceChildren(metric("Most frequent Super Bowl winner", sorted[0].team, `${name(sorted[0].team)} · ${pct(sorted[0].champion_probability)} of seasons`), metric("Simulated seasons", result.trials.toLocaleString(), `Seed ${result.seed} · repeatable`), metric("Completed games held fixed", String(result.completed_games), `${result.unresolved_games} unresolved started games; no live adjustment`));
  $("league-divisions").replaceChildren();
  for (const [division, teams] of Object.entries(DIVISIONS)) {
    const group = el("section", undefined, "league-section-table"); group.append(el("h3", division));
    const rows = result.teams.filter(row => teams.includes(row.team)).sort((a, b) => b.wins.mean - a.wins.mean);
    group.append(table(["Team", "Average W–L–T", "Wins SD", "Middle 80% wins", "Season points for / allowed", "Division title", "Playoffs"], rows.map(row => [name(row.team), `${num(row.wins.mean)}–${num(row.losses)}–${num(row.ties)}`, num(row.wins.sd), `${num(row.wins.p10)}–${num(row.wins.p90)}`, `${num(row.points_for)} / ${num(row.points_against)}`, pct(row.division_probability), pct(row.playoff_probability)]), `${division} simulated standings`)); $("league-divisions").append(group);
  }
  $("league-playoff-probabilities").replaceChildren();
  for (const conf of ["AFC", "NFC"]) {
    const group = el("section", undefined, "league-section-table"); group.append(el("h3", conf));
    const rows = result.teams.filter(row => row.division.startsWith(conf)).sort((a, b) => b.playoff_probability - a.playoff_probability);
    group.append(table(["Team", "Playoffs", "No. 1 seed / bye", "Win conference", "Win Super Bowl"], rows.map(row => [name(row.team), pct(row.playoff_probability), pct(row.bye_probability), pct(row.conference_probability), pct(row.champion_probability)]), `${conf} playoff probabilities`)); $("league-playoff-probabilities").append(group);
  }
  $("league-example-note").textContent = `Trial 1 of ${result.trials.toLocaleString()} · seed ${result.seed}. One internally consistent sampled season, not the average season or a prediction that these exact games will happen.`;
  $("league-example-records").replaceChildren(table(["Team", "Division", "Example W–L–T", "Playoff seed"], Object.entries(result.example.divisions).flatMap(([division, teams]) => teams.map(team => {
    const record = result.example.records[team], seeds = result.example.seeds[division.slice(0, 3)], seed = seeds.indexOf(team) + 1;
    return [name(team), division, `${record.wins}–${record.losses}–${record.ties}`, seed ? String(seed) : "Missed playoffs"];
  })), "One simulated season's final records"));
  $("league-bracket").replaceChildren();
  for (const conf of ["AFC", "NFC"]) {
    const group = el("section"); group.append(el("h3", `${conf} · ${result.example.seeds[conf][0]} has the first-round bye`));
    for (const round of ["Wild card", "Divisional", "Conference championship"]) {
      const section = el("div", undefined, "league-round"); section.append(el("h3", round));
      result.example.postseason.rounds.filter(game => game.conference === conf && game.round === round).forEach(game => {
        const item = el("div", `#${game.away_seed} ${game.away} ${game.away_points} at #${game.home_seed} ${game.home} ${game.home_points}`, "league-playoff-game"); item.append(el("strong", `${game.winner} advances`)); section.append(item);
      }); group.append(section);
    } $("league-bracket").append(group);
  }
  const final = result.example.postseason.rounds.at(-1), champion = el("section", undefined, "league-round league-champion");
  champion.append(el("h3", "Super Bowl · neutral field"), el("p", `${name(final.home)} ${final.home_points} — ${name(final.away)} ${final.away_points}`), el("h2", `${name(final.winner)} wins this simulated Super Bowl`)); $("league-bracket").append(champion);
  renderGames(); $("league-results").hidden = false;
}
function run() {
  if (!data) return;
  const seed = Number($("league-seed").value), trials = Number($("league-trials").value);
  $("league-error").hidden = true;
  if (!Number.isInteger(seed) || seed < 1 || seed > 2147483647) { $("league-error").textContent = "Choose a whole-number seed between 1 and 2147483647."; $("league-error").hidden = false; return; }
  worker?.terminate(); $("league-run").disabled = true; $("league-results").hidden = true;
  $("league-progress").textContent = "Simulating the schedule and playoffs…";
  const fail = message => { worker?.terminate(); $("league-run").disabled = false; $("league-progress").textContent = "Simulation did not finish."; $("league-error").textContent = message; $("league-error").hidden = false; };
  try {
    worker = new Worker(new URL("./league-worker.mjs?v=20260909-labs2", import.meta.url), {type: "module"});
    worker.onmessage = event => {
      if (event.data.error) { fail(event.data.error); return; }
      if (event.data.result) { result = event.data.result; render(); $("league-run").disabled = false; $("league-progress").textContent = `${trials.toLocaleString()} seasons complete. Results below use seed ${seed}.`; worker.terminate(); }
      else $("league-progress").textContent = `Simulating… ${Math.round(event.data.progress * 100)}%`;
    };
    worker.onerror = () => fail("The simulation worker could not run. Reload or try a current browser; no results have been invented.");
    worker.postMessage({data, options: {trials, seed, now: Date.now()}});
  } catch (error) { fail(error.message); }
}
async function init() {
  try {
    const response = await fetch("data/survivor.json", {cache: "no-store"}); if (!response.ok) throw new Error("Team snapshot unavailable."); data = await response.json();
    if (!Array.isArray(data.teams) || !Array.isArray(data.games) || !data.training) throw new Error("Invalid team snapshot.");
    $("league-status").textContent = `${data.season} · saved ${date(data.generated_at)}`;
    $("league-freshness").textContent = `Team strengths include results through ${date(data.training.training_last)}. ${data.training.current_season_games || 0} completed ${data.season} games in the fit. Injuries, lineups and weather are not modeled. ${Date.now() - Date.parse(data.generated_at) > 24 * 3600000 ? "Warning: snapshot over 24 hours old." : ""}`;
    data.teams.forEach(team => { const option = el("option", team.name); option.value = team.team; $("league-team").append(option); });
    for (let week = 1; week <= 18; week++) { const option = el("option", `Week ${week}`); option.value = week; $("league-week").append(option); }
    const next = data.games.filter(game => Date.parse(game.kickoff) > Date.now()).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff))[0]; if (next) $("league-week").value = next.week;
    $("league-team").addEventListener("change", renderGames); $("league-week").addEventListener("change", renderGames); $("league-run").addEventListener("click", run); run();
  } catch (error) { $("league-error").textContent = error.message; $("league-error").hidden = false; $("league-status").textContent = "Team data unavailable"; }
}
init();
