import {DIVISIONS} from "./league-model.mjs?v=20260913-home1";
import {freshSeed, validSeed} from "./simulation-runs.mjs?v=20260913-home1";
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const num = value => Number.isFinite(value) ? value.toFixed(1) : "—";
const pct = value => `${num(value * 100)}%`;
const date = value => new Date(value).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
let data, result, worker, runCount = 0;
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
  $("league-example-select").replaceChildren(...result.examples.map((example, index) => {
    const option = el("option", `Example ${index + 1} · trial ${example.trial.toLocaleString()}`); option.value = index; return option;
  }));
  renderExample(); renderGames(); $("league-results").hidden = false;
}
function renderExample() {
  if (!result) return;
  const index = Number($("league-example-select").value), example = result.examples[index];
  if (!example) return;
  $("league-example-note").textContent = `Example ${index + 1} of ${result.examples.length} saved complete seasons · trial ${example.trial.toLocaleString()} of ${result.trials.toLocaleString()} · run seed ${result.seed}. The records, all 272 regular-season games, and 13 playoff games below belong to the same sampled season. Browsing examples does not change the averages above.`;
  $("league-example-records").replaceChildren(table(["Team", "Division", "Example W–L–T", "Playoff seed"], Object.entries(example.divisions).flatMap(([division, teams]) => teams.map(team => {
    const record = example.records[team], seeds = example.seeds[division.slice(0, 3)], seed = seeds.indexOf(team) + 1;
    return [name(team), division, `${record.wins}–${record.losses}–${record.ties}`, seed ? String(seed) : "Missed playoffs"];
  })), "One simulated season's final records"));
  $("league-bracket").replaceChildren();
  for (const conf of ["AFC", "NFC"]) {
    const group = el("section"); group.append(el("h3", `${conf} · ${example.seeds[conf][0]} has the first-round bye`));
    for (const round of ["Wild card", "Divisional", "Conference championship"]) {
      const section = el("div", undefined, "league-round"); section.append(el("h3", round));
      example.postseason.rounds.filter(game => game.conference === conf && game.round === round).forEach(game => {
        const item = el("div", `#${game.away_seed} ${game.away} ${game.away_points} at #${game.home_seed} ${game.home} ${game.home_points}`, "league-playoff-game"); item.append(el("strong", `${game.winner} advances`)); section.append(item);
      }); group.append(section);
    } $("league-bracket").append(group);
  }
  const final = example.postseason.rounds.at(-1), champion = el("section", undefined, "league-round league-champion");
  champion.append(el("h3", "Super Bowl · neutral field"), el("p", `${name(final.home)} ${final.home_points} — ${name(final.away)} ${final.away_points}`), el("h2", `${name(final.winner)} wins this simulated Super Bowl`)); $("league-bracket").append(champion);
  const fixtures = new Map(result.games.map(game => [game.game_id, game]));
  const games = [...example.games].sort((a, b) => fixtures.get(a.game_id).week - fixtures.get(b.game_id).week || Date.parse(fixtures.get(a.game_id).kickoff) - Date.parse(fixtures.get(b.game_id).kickoff));
  $("league-example-games").replaceChildren(table(["Week", "Game", "Away score", "Home score", "Outcome", "Basis"], games.map(score => {
    const game = fixtures.get(score.game_id);
    return [String(game.week), `${game.away} at ${game.home}`, String(score.away), String(score.home), score.home === score.away ? "Tie" : score.home > score.away ? game.home : game.away, game.final ? "Actual final · fixed" : game.unresolved ? "Sampled · unresolved, not live" : "Sampled outcome"];
  }), "All regular-season games in this example"));
}
function setBusy(busy) {
  for (const id of ["league-run", "league-trials", "league-seed", "league-fixed-seed", "league-next-example", "league-example-select"]) $(id).disabled = busy;
}
function updateSeedMode() {
  const fixed = $("league-fixed-seed").checked;
  $("league-seed").readOnly = !fixed;
  $("league-run").textContent = fixed ? "Run with this seed" : "Run fresh simulations";
}
function run() {
  if (!data) return;
  let seed = Number($("league-seed").value);
  const trials = Number($("league-trials").value), fixed = $("league-fixed-seed").checked;
  $("league-error").hidden = true;
  try {
    if (!fixed) seed = freshSeed(result?.seed);
    if (!validSeed(seed)) throw new Error("Choose a whole-number seed between 1 and 2147483647.");
  } catch (error) { $("league-error").textContent = error.message; $("league-error").hidden = false; return; }
  $("league-seed").value = seed;
  worker?.terminate(); setBusy(true); $("league-results").hidden = true;
  $("league-progress").textContent = "Simulating the schedule and playoffs…";
  let watchdog;
  const fail = message => { clearTimeout(watchdog); worker?.terminate(); setBusy(false); $("league-progress").textContent = "Simulation did not finish; no partial run is shown."; $("league-error").textContent = message; $("league-error").hidden = false; };
  try {
    worker = new Worker(new URL("./league-worker.mjs?v=20260913-home1", import.meta.url), {type: "module"});
    const activeWorker = worker;
    worker.onmessage = event => {
      if (worker !== activeWorker) return;
      if (event.data.error) { fail(event.data.error); return; }
      if (event.data.result) {
        try {
          const completed = event.data.result;
          if (completed.trials !== trials || completed.games?.length !== 272 || !completed.examples?.length || completed.examples.some(example => example.games.length !== 272 || example.postseason.rounds.length !== 13)) throw new Error("The worker returned an incomplete run. Please try again.");
          result = completed; render(); clearTimeout(watchdog); setBusy(false); runCount++;
          $("league-progress").textContent = `Run ${runCount}: ${trials.toLocaleString()} complete seasons, each with the full schedule and playoffs. Seed ${seed} · ${fixed ? "fixed-seed mode" : "fresh draws"} · ${result.examples.length} complete examples available below.`;
          worker.terminate();
        } catch (error) { fail(error.message); }
      }
      else $("league-progress").textContent = `Simulating… ${Math.round(event.data.progress * 100)}%`;
    };
    worker.onerror = () => fail("The simulation worker could not run. Reload or try a current browser; no results have been invented.");
    worker.postMessage({data, options: {trials, seed, now: Date.now()}});
    watchdog = setTimeout(() => fail("This run took too long. Try fewer simulations or reload."), 90000);
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
    $("league-team").addEventListener("change", renderGames); $("league-week").addEventListener("change", renderGames); $("league-run").addEventListener("click", run);
    $("league-fixed-seed").addEventListener("change", updateSeedMode);
    $("league-example-select").addEventListener("change", renderExample);
    $("league-next-example").addEventListener("click", () => { if (result) { $("league-example-select").value = (Number($("league-example-select").value) + 1) % result.examples.length; renderExample(); } });
    updateSeedMode(); run();
  } catch (error) { $("league-error").textContent = error.message; $("league-error").hidden = false; $("league-status").textContent = "Team data unavailable"; }
}
init();
