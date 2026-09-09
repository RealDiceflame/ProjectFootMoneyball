import {upcomingGames, simulateMatchup, matchupMarkets} from "./matchup-model.mjs?v=20260909-matchup1";

const $ = id => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const pct = value => `${(value * 100).toFixed(1)}%`;
const num = value => Number.isFinite(value) ? value.toFixed(1) : "—";
const signed = value => `${value > 0 ? "+" : ""}${num(value)}`;
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"}) : "Unknown";
const price = value => `${value > 0 ? "+" : ""}${value}`;

function table(id, headers, rows) {
  const head = el("thead"), heading = el("tr"), body = el("tbody");
  for (const label of headers) { const th = el("th", label); th.scope = "col"; heading.append(th); }
  head.append(heading);
  for (const values of rows) {
    const row = el("tr");
    values.forEach((value, i) => { const cell = el(i ? "td" : "th", value); if (!i) cell.scope = "row"; row.append(cell); });
    body.append(row);
  }
  $(id).replaceChildren(head, body);
}

function metric(label, value, note) {
  const node = el("div"); node.append(el("span", label), el("strong", value), el("small", note)); return node;
}

function drawDistribution(result, key) {
  const data = result.histograms[key], stats = result.stats[key];
  const names = {margin: `${result.forecast.home} minus ${result.forecast.away} points`, home: `${result.forecast.home} points`, away: `${result.forecast.away} points`, total: "Combined points"};
  const ns = "http://www.w3.org/2000/svg", svg = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const description = `${names[key]}. Average ${num(stats.mean)}, standard deviation ${num(stats.sd)}, middle 80% ${num(stats.p10)} to ${num(stats.p90)} points.`;
  const chart = svg("svg", {viewBox: "0 0 760 310", class: "matchup-distribution", role: "img", "aria-label": description});
  const low = Math.min(data[0].start, stats.mean - stats.sd), high = Math.max(data.at(-1).end + 1, stats.mean + stats.sd);
  const peak = Math.max(...data.map(bin => bin.probability)) * 1.2;
  const x = value => 60 + (value - low) / (high - low) * 670, y = value => 245 - value / peak * 210;
  chart.append(svg("rect", {x: x(stats.mean - stats.sd), y: 30, width: x(stats.mean + stats.sd) - x(stats.mean - stats.sd), height: 215, fill: "#d7ff54", opacity: .1}));
  for (let i = 0; i <= 4; i++) {
    const value = peak * i / 4;
    chart.append(svg("line", {x1: 60, x2: 730, y1: y(value), y2: y(value), stroke: "#365145"}), svg("text", {x: 52, y: y(value) + 5, "text-anchor": "end"}, pct(value)));
  }
  for (const bin of data) {
    const rect = svg("rect", {x: x(bin.start) + 1, y: y(bin.probability), width: Math.max(1, x(bin.end + 1) - x(bin.start) - 2), height: 245 - y(bin.probability), fill: key === "margin" && bin.end < 0 ? "#8cc6ff" : "#d7ff54", opacity: .85});
    rect.append(svg("title", {}, `${bin.start} to ${bin.end} points: ${pct(bin.probability)}`)); chart.append(rect);
  }
  if (low < 0 && high > 0) chart.append(svg("line", {x1: x(0), x2: x(0), y1: 28, y2: 245, stroke: "#8cc6ff", "stroke-dasharray": "4 4"}));
  chart.append(svg("line", {x1: x(stats.mean), x2: x(stats.mean), y1: 28, y2: 245, stroke: "#ffffff", "stroke-width": 2}));
  for (let i = 0; i <= 6; i++) {
    const value = low + (high - low) * i / 6;
    chart.append(svg("text", {x: x(value), y: 267, "text-anchor": "middle"}, String(Math.round(value))));
  }
  chart.append(svg("text", {x: 60, y: 18}, "Share of simulated games"), svg("text", {x: 395, y: 297, "text-anchor": "middle"}, names[key]));
  const shell = el("div", undefined, "survivor-table-scroll"); shell.tabIndex = 0; shell.setAttribute("role", "region"); shell.setAttribute("aria-label", "Score distribution; scroll horizontally on small screens"); shell.append(chart);
  $("matchup-chart").replaceChildren(shell);
  $("matchup-chart-description").textContent = `${description} White line: average. Shaded band: average ± one SD (not a guaranteed 68% interval).${key === "margin" ? ` Negative margins mean ${result.forecast.away} wins; positive margins mean ${result.forecast.home} wins.` : ""}`;
}

function renderResults(data, result) {
  const {forecast: f, stats, probabilities: p} = result;
  const home = data.teams.find(team => team.team === f.home), away = data.teams.find(team => team.team === f.away);
  const favorite = p.home > p.away ? home : away;
  const modelMargin = f.home_points - f.away_points;
  $("matchup-summary").replaceChildren(
    metric(`${home.name} win`, pct(p.home), `${num(stats.home.mean)} average points in simulations`),
    metric(`${away.name} win`, pct(p.away), `${num(stats.away.mean)} average points in simulations`),
    metric("Tie", pct(p.tie), "Final-game tie component"),
    metric("Model scoring line", `${f.home} ${signed(-modelMargin)}`, `${num(f.home_points + f.away_points)} combined points · not a sportsbook quote`)
  );
  $("matchup-verdict").textContent = Math.abs(p.home - p.away) < .02
    ? "Essentially a toss-up in these simulations. Neither team has a clear advantage."
    : `${favorite.name} wins more often (${pct(Math.max(p.home, p.away))}) under the model's assumptions. The other team still wins ${pct(Math.min(p.home, p.away))} of simulations. This is not a guarantee.`;
  const baselines = {home: f.home_points, away: f.away_points, margin: modelMargin, total: f.home_points + f.away_points};
  const labels = {home: f.home, away: f.away, margin: `${f.home} − ${f.away} margin`, total: "Combined points"};
  table("matchup-stats", ["Scoring statistic", "Team-model baseline", "Simulation average", "Median", "SD", "Middle 80% of simulations"],
    Object.entries(stats).map(([key, value]) => [labels[key], num(baselines[key]), num(value.mean), num(value.p50), num(value.sd), `${num(value.p10)} to ${num(value.p90)}`]));
  const outcomes = [`${f.away} wins by 15+`, `${f.away} wins by 8–14`, `${f.away} wins by 1–7`, "Tie", `${f.home} wins by 1–7`, `${f.home} wins by 8–14`, `${f.home} wins by 15+`];
  $("matchup-outcomes").replaceChildren(...outcomes.map((label, i) => {
    const row = el("div", undefined, `matchup-outcome ${i < 3 ? "away-outcome" : ""}`), bar = el("span", undefined, "matchup-outcome-bar");
    bar.style.setProperty("--chance", `${result.outcomes[i] * 100}%`); bar.setAttribute("aria-hidden", "true");
    row.append(el("span", label), bar, el("strong", pct(result.outcomes[i]))); return row;
  }));
  table("matchup-team-stats", ["Team", `${data.season} games completed`, "Season points/game", "Season allowed/game", "Offense points added", "Defense points prevented"],
    [home, away].map(team => [team.name, String(team.current_season?.games ?? 0), num(team.current_season?.points_for), num(team.current_season?.points_against), signed(team.offense), signed(team.defense)]));
  drawDistribution(result, $("matchup-chart-metric").value);
  $("matchup-results").hidden = false;
}

function renderMarkets(data, odds, choice, loading) {
  const target = $("matchup-market"), result = matchupMarkets(data, odds, choice);
  target.replaceChildren();
  if (result.status === "not_this_week") { target.append(el("p", "No matching upcoming fixture this week at this venue. This is a hypothetical or later-week comparison; no current betting line is attached.")); return; }
  if (loading) { target.append(el("p", "Loading the saved odds snapshot…")); return; }
  const current = result.books.filter(book => book.kind !== "reference");
  target.append(el("p", `${result.game.away} at ${result.game.home} · Week ${result.game.week} · ${date(result.game.kickoff)}. ${current.length ? "Saved quotes, not live prices. Check the provider before acting." : "No fresh, complete sportsbook or exchange quotes in the saved feed. Missing lines are not estimated."}`));
  if (!result.books.length) return;
  const scroll = el("div", undefined, "survivor-table-scroll"), output = el("table", undefined, "survivor-table");
  output.id = "matchup-odds-table"; scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "Betting line comparison"); scroll.append(output); target.append(scroll);
  table("matchup-odds-table", ["Source", "Type / freshness", "Moneyline", "Spread", "Total"], []);
  const body = output.querySelector("tbody");
  for (const book of result.books) {
    const row = el("tr"), source = el("th"); source.scope = "row";
    const link = book.url ? el("a", `${book.provider} ↗`) : el("span", book.provider);
    if (book.url) { link.href = book.url; link.target = "_blank"; link.rel = "noopener noreferrer"; } source.append(link); row.append(source);
    const quoteDates = Object.values(book.markets).flat().map(quote => Date.parse(quote.updated_at)).filter(Number.isFinite);
    row.append(el("td", book.kind === "reference" ? "Reference only · source quote time unknown" : `${book.kind === "exchange" ? "Prediction exchange" : "Sportsbook"} · ${date(new Date(Math.min(...quoteDates)).toISOString())}`));
    for (const market of ["Moneyline", "Spread", "Total"]) {
      const cell = el("td"), pair = book.markets[market];
      if (!pair) cell.textContent = "—";
      else pair.forEach(quote => cell.append(el("div", `${quote.selection}${market === "Moneyline" ? "" : ` ${market === "Spread" ? signed(quote.line) : num(quote.line)}`} (${price(quote.price)})`)));
      row.append(cell);
    }
    body.append(row);
  }
  if (result.books.some(book => book.kind === "reference")) target.append(el("p", `Reference lines are undated schedule data, not current offers. File saved ${date(result.generated_at)}; that is NOT the source quote time.`));
}

export function initMatchup(data) {
  let odds = null, loading = true, lastResult = null;
  const options = upcomingGames(data);
  for (const game of options) {
    const option = el("option", `Week ${game.week} · ${game.away} at ${game.home} · ${date(game.kickoff)}`);
    option.value = game.game_id; $("matchup-game").append(option);
  }
  for (const team of [...data.teams].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const side of ["home", "away"]) { const option = el("option", team.name); option.value = team.team; $(`matchup-${side}`).append(option); }
  }
  if (!options.length) { $("matchup-mode").value = "custom"; $("matchup-mode").options[0].disabled = true; }
  $("matchup-away").selectedIndex = 1;
  const choice = () => ({home: $("matchup-home").value, away: $("matchup-away").value,
    neutral: $("matchup-venue").value === "neutral", ...($("matchup-mode").value === "schedule" ? {game_id: $("matchup-game").value} : {})});
  const run = () => {
    $("matchup-error").hidden = true; $("matchup-results").hidden = true; lastResult = null;
    const scheduled = $("matchup-mode").value === "schedule";
    $("matchup-game-label").hidden = !scheduled;
    ["home", "away", "venue"].forEach(key => { $(`matchup-${key}`).disabled = scheduled; });
    const game = scheduled ? data.games.find(game => game.game_id === $("matchup-game").value) : null;
    if (game) {
      $("matchup-home").value = game.home; $("matchup-away").value = game.away; $("matchup-venue").value = game.neutral ? "neutral" : "home";
    }
    $("matchup-context").textContent = game
      ? `Week ${game.week} · ${game.away} at ${game.home} · ${date(game.kickoff)} · ${game.stadium || "Stadium unavailable"}${game.neutral ? " · Neutral site" : ""}. All times use your device's time zone.`
      : "Hypothetical game played with the latest saved team strengths. This is not a historical replay or a roster-adjusted forecast.";
    const age = (Date.now() - Date.parse(data.generated_at)) / 3600000;
    $("matchup-freshness").textContent = `Ratings saved ${date(data.generated_at)}${age > 24 ? " · Snapshot is over 24 hours old" : ""}. Results included through ${date(data.training.training_last)}. ${data.training.current_season_games ?? 0} completed ${data.season} games in the fit${data.training.current_season_games ? "." : "; preseason baseline until current-season results arrive."} Injuries, lineups, weather and roster changes are not modeled.`;
    try {
      lastResult = simulateMatchup(data, choice(), {seed: data.season}); renderResults(data, lastResult);
    } catch (error) { $("matchup-error").textContent = error.message; $("matchup-error").hidden = false; }
    renderMarkets(data, odds, choice(), loading);
  };
  for (const id of ["mode", "game", "home", "away", "venue"]) $(`matchup-${id}`).addEventListener("change", run);
  $("simulate-matchup").addEventListener("click", run);
  $("matchup-chart-metric").addEventListener("change", () => { if (lastResult) drawDistribution(lastResult, $("matchup-chart-metric").value); });
  run();
  fetch("data/nfl_odds.json", {cache: "no-cache"}).then(response => {
    if (!response.ok) throw new Error("Odds unavailable"); return response.json();
  }).then(value => { odds = value; }).catch(() => { odds = null; }).finally(() => { loading = false; renderMarkets(data, odds, choice(), loading); });
  // Expire quotes and pregame simulations even when a visitor leaves the tab open.
  let wasPlayable = true;
  setInterval(() => {
    const current = choice();
    const stillPlayable = !current.game_id || upcomingGames(data).some(game => game.game_id === current.game_id);
    if (wasPlayable && !stillPlayable) run();
    wasPlayable = stillPlayable;
    renderMarkets(data, odds, current, loading);
  }, 30000);
}
