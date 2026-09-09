import {fixture, playable, probability, sanitizeState, validatePlan, suggestPlan, survivalPath, simulatePlans} from "./survivor-model.mjs?v=1";

const $ = id => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const pct = p => Number.isFinite(p) ? `${(100 * p).toFixed(1)}%` : "—";
const signed = n => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
const date = value => new Date(value).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
let data, state, storageKey;

function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    $("save-status").textContent = "Saved only in this browser.";
  } catch {
    $("save-status").textContent = "Browser storage unavailable—keep this tab open to retain your picks.";
  }
}

function table(id, headers) {
  const node = $(id), head = el("thead"), row = el("tr"), body = el("tbody");
  headers.forEach(label => { const cell = el("th", label); cell.scope = "col"; row.append(cell); });
  head.append(row); node.replaceChildren(head, body);
  return body;
}

function marketShare(game, team) {
  const market = game?.market;
  if (!market || Date.now() - Date.parse(market.oldest_quote) > 48 * 3600000 || !playable(game)) return null;
  return market[team === game.home ? "home_share" : "away_share"];
}

function renderUsed() {
  $("used-count").textContent = `(${state.used.length}/32)`;
  $("used-teams").replaceChildren(...data.teams.map(team => {
    const label = el("label"), input = el("input");
    input.type = "checkbox"; input.checked = state.used.includes(team.team);
    input.setAttribute("aria-label", `${team.name} already used`);
    input.addEventListener("change", () => {
      const used = new Set(state.used);
      if (input.checked) {
        used.add(team.team);
        state.picks = Object.fromEntries(Object.entries(state.picks).filter(([, t]) => t !== team.team));
      } else used.delete(team.team);
      state.used = [...used];
      save(); render();
      $("plan-message").textContent = `${team.team} ${input.checked ? "marked used and removed from planned picks" : "available again"}.`;
      $("used-teams").querySelector(`[aria-label="${team.name} already used"]`)?.focus();
    });
    label.append(input, el("span", team.team)); label.title = team.name;
    return label;
  }));
}

function renderMatrix() {
  const weeks = Array.from({length: state.end - state.start + 1}, (_, i) => state.start + i);
  const body = table("survivor-matrix", ["Team", ...weeks.map(w => `Week ${w}`)]);
  const reserved = Object.fromEntries(Object.entries(state.picks).map(([w, t]) => [t, Number(w)]));
  data.teams.forEach(team => {
    const row = el("tr"), name = el("th", team.team);
    name.scope = "row"; name.title = team.name;
    if (state.used.includes(team.team)) name.append(el("small", "Used"));
    row.append(name);
    weeks.forEach(week => {
      const cell = el("td"), game = fixture(data, team.team, week);
      if (!game) { cell.append(el("small", "Bye / no game")); row.append(cell); return; }
      const home = game.home === team.team, opponent = home ? game.away : game.home;
      const p = probability(game, team.team, state.ties);
      const selected = state.picks[week] === team.team;
      const button = el("button", undefined, `matrix-pick${selected ? " selected" : ""}`);
      button.type = "button"; button.dataset.team = team.team; button.dataset.week = week;
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !playable(game) || p === null || state.used.includes(team.team) || (reserved[team.team] !== undefined && reserved[team.team] !== week);
      const label = game.status === "final" ? `${game.home_score}–${game.away_score}` : playable(game) ? pct(p) : "Locked";
      button.append(el("span", `${home ? "vs" : "@"} ${opponent}`), el("strong", selected ? `✓ ${label}` : label));
      if (game.status === "final") button.append(el("span", "Final · home–away"));
      button.style.setProperty("--heat", `${Math.max(0, Math.min(55, ((p ?? .25) - .25) * 85))}%`);
      button.title = `${team.name} ${home ? "vs" : "at"} ${opponent} · ${date(game.kickoff)}${game.neutral ? " · Neutral site" : ""}${game.model ? ` · Expected score: ${team.team} ${home ? game.model.home_points : game.model.away_points}, ${opponent} ${home ? game.model.away_points : game.model.home_points}` : ""}${reserved[team.team] && reserved[team.team] !== week ? ` · Reserved in week ${reserved[team.team]}` : ""}`;
      button.setAttribute("aria-label", `Week ${week}, ${team.team} ${home ? "versus" : "at"} ${opponent}, ${label}${selected ? ", selected" : ""}`);
      button.addEventListener("click", () => {
        if (!playable(game)) { render(); return; }
        if (selected) delete state.picks[week]; else state.picks[week] = team.team;
        save(); render();
        $("survivor-matrix").querySelector(`[data-team="${team.team}"][data-week="${week}"]`)?.focus();
      });
      cell.append(button); row.append(cell);
    });
    body.append(row);
  });
}

function metric(label, value, note) {
  const node = el("div"); node.append(el("span", label), el("strong", value), el("small", note)); return node;
}

function renderPath() {
  const errors = validatePlan(data, state), path = survivalPath(data, state);
  const filled = path.filter(row => row.team).length;
  $("plan-message").textContent = errors.length ? `${errors[0]}${errors.length > 1 ? ` (${errors.length} items to resolve.)` : ""}` : "Your plan is complete. Compare it with a fresh suggested path below.";
  $("simulate-plan").disabled = errors.length > 0;
  $("survival-summary").replaceChildren(
    metric("Picks in this window", `${filled} / ${path.length}`, `Weeks ${state.start}–${state.end}`),
    metric("Estimated survival through window", errors.length ? "—" : pct(path.at(-1).cumulative), "Product of model estimates, assuming independent weeks"),
    metric("Teams still available", String(data.teams.length - new Set([...state.used, ...Object.values(state.picks)]).size), "Excludes previous and planned picks")
  );
  const body = table("plan-table", ["Week", "Your team", "Opponent / kickoff", "Model survival", "Market no-vig share", "Survive through week"]);
  for (const entry of path) {
    const row = el("tr"), select = el("select");
    select.setAttribute("aria-label", `Pick for week ${entry.week}`);
    const empty = el("option", "Choose team"); empty.value = ""; select.append(empty);
    const reserved = new Set([...state.used, ...Object.entries(state.picks).filter(([w]) => Number(w) !== entry.week).map(([, t]) => t)]);
    const candidates = data.teams.filter(t => t.team === entry.team || (!reserved.has(t.team) && playable(fixture(data, t.team, entry.week))));
    candidates.sort((a, b) => (probability(fixture(data, b.team, entry.week), b.team, state.ties) ?? -1) - (probability(fixture(data, a.team, entry.week), a.team, state.ties) ?? -1));
    for (const team of candidates) {
      const option = el("option", `${team.team} · ${pct(probability(fixture(data, team.team, entry.week), team.team, state.ties))}`);
      option.value = team.team; select.append(option);
    }
    select.value = entry.team ?? "";
    select.addEventListener("change", () => {
      if (select.value) state.picks[entry.week] = select.value; else delete state.picks[entry.week];
      save(); render();
      $("plan-table").querySelector(`[aria-label="Pick for week ${entry.week}"]`)?.focus();
    });
    const game = fixture(data, entry.team, entry.week), choice = el("td"); choice.append(select);
    const opponent = game ? `${game.home === entry.team ? "vs " + game.away : "@ " + game.home}${game.neutral ? " (neutral)" : ""}` : "—";
    const match = el("td", opponent);
    if (game) match.append(el("br"), el("small", date(game.kickoff)));
    const market = el("td", pct(marketShare(game, entry.team)));
    if (marketShare(game, entry.team) !== null) market.title = `${game.market.books} paired sportsbook(s); oldest quote ${date(game.market.oldest_quote)}. Non-tie share only.`;
    row.append(el("td", String(entry.week)), choice, match, el("td", playable(game) ? pct(entry.probability) : "—"), market, el("td", errors.length ? "—" : pct(entry.cumulative)));
    body.append(row);
  }
}

function render() {
  $("start-week").value = state.start; $("end-week").value = state.end;
  $("tie-rule").value = state.ties ? "survive" : "lose";
  $("simulation-results").replaceChildren();
  renderUsed(); renderMatrix(); renderPath();
  const hours = (Date.now() - Date.parse(data.generated_at)) / 3600000;
  $("survivor-status").textContent = `${data.season} · Updated ${date(data.generated_at)}${hours > 24 ? " · Snapshot over 24 hours old" : ""}`;
}

function chart(result) {
  const ns = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    if (text) node.textContent = text;
    return node;
  };
  const svg = svgEl("svg", {viewBox: "0 0 760 240", class: "simulation-chart", role: "img", "aria-label": "Simulated cumulative survival by week: lime is your plan, blue is the fresh suggested path. Exact results appear in the table below."});
  const weeks = state.end - state.start + 1;
  for (const p of [0, .25, .5, .75, 1]) {
    svg.append(svgEl("line", {x1: 60, x2: 735, y1: 205 - 180 * p, y2: 205 - 180 * p, stroke: "#365145"}), svgEl("text", {x: 5, y: 210 - 180 * p}, `${p * 100}%`));
  }
  result.plans.forEach((plan, index) => {
    const values = [1, ...plan.byWeek];
    const points = values.map((p, i) => `${60 + 675 * i / weeks},${205 - 180 * p}`).join(" ");
    svg.append(svgEl("polyline", {points, fill: "none", stroke: index ? "#8cc6ff" : "#d7ff54", "stroke-width": 3, ...(index ? {"stroke-dasharray": "6 5"} : {})}));
  });
  svg.append(svgEl("text", {x: 60, y: 230}, `Before week ${state.start}`), svgEl("text", {x: 610, y: 230}, `After week ${state.end}`));
  const shell = el("div", undefined, "survivor-table-scroll"); shell.append(svg); return shell;
}

function runSimulation() {
  const fresh = suggestPlan(data, state, Date.now(), false);
  if (fresh.errors.length) { $("plan-message").textContent = fresh.errors[0]; return; }
  try {
    const result = simulatePlans(data, [state, {...state, picks: fresh.picks}], {seed: data.season});
    const target = $("simulation-results"), summary = el("div", undefined, "survival-summary");
    result.plans.forEach((plan, i) => summary.append(metric(i ? "Fresh suggested path" : "Your plan", pct(plan.survival), `20,000 trials · model product ${pct(plan.expected)}`)));
    target.replaceChildren(el("h3", "Simulated survival—not odds of winning your pool"), summary,
      el("p", "Lime: your plan. Dashed blue: a fresh suggested path, keeping used teams and picks outside this window reserved. Identical plans give identical results. Random sampling can vary slightly from the exact model product; team-strength uncertainty is not simulated."), chart(result));
    const scroll = el("div", undefined, "survivor-table-scroll"), output = el("table", undefined, "survivor-table");
    output.id = "simulation-table"; scroll.append(output); target.append(scroll);
    const body = table("simulation-table", ["Week", "Your pick", "Your survival", "Suggested pick", "Suggested survival"]);
    result.plans[0].byWeek.forEach((p, i) => {
      const week = state.start + i, row = el("tr");
      [String(week), state.picks[week], pct(p), fresh.picks[week], pct(result.plans[1].byWeek[i])].forEach(value => row.append(el("td", value)));
      body.append(row);
    });
  } catch (error) { $("plan-message").textContent = error.message; renderPath(); }
}

function renderEvidence() {
  const body = table("team-ratings", ["Team", "Offense points added", "Defense points prevented", "Combined rating"]);
  [...data.teams].sort((a, b) => (b.offense + b.defense) - (a.offense + a.defense)).forEach(team => {
    const row = el("tr"); [team.name, signed(team.offense), signed(team.defense), signed(team.offense + team.defense)].forEach(value => row.append(el("td", value))); body.append(row);
  });
  $("ratings-summary").textContent = `League baseline: ${data.league_points.toFixed(1)} points/team/game · Home-field margin: ${signed(data.home_advantage)} points`;
  const test = data.backtest;
  $("model-evidence").replaceChildren(
    el("p", `Current fit: ${data.training.training_games} completed games, from ${date(data.training.training_first)} through ${date(data.training.training_last)}. Margin variation: ${data.training.margin_sd.toFixed(1)} points. Smoothed tie estimate: ${pct(data.training.tie_probability)}.`),
    el("p", test.games ? `Historical check (${test.seasons.join("–")}): ${test.games} games, refitting before each week. Home-win Brier error: ${test.brier_score.toFixed(4)}, versus ${test.coin_flip_brier.toFixed(4)} for 50/50. Lower is better. This is a diagnostic, not evidence of a profitable betting edge or a calibrated probability interval.` : "Historical validation is unavailable.")
  );
}

async function init() {
  try {
    const response = await fetch("data/survivor.json", {cache: "no-cache"});
    if (!response.ok) throw new Error(`Snapshot unavailable (${response.status}).`);
    data = await response.json();
    if (!Array.isArray(data.teams) || data.teams.length !== 32 || !Array.isArray(data.games) || !Number.isInteger(data.season) || !data.training || !Number.isFinite(Date.parse(data.generated_at))) throw new Error("Snapshot format is invalid.");
    for (const game of data.games) if (game.model) {
      const values = [game.model.home_win, game.model.away_win, game.model.tie];
      if (values.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > .00001) throw new Error("Invalid probability in snapshot.");
    }
    storageKey = `outlierbaseline-survivor-v1-${data.season}`;
    let raw;
    try { raw = JSON.parse(localStorage.getItem(storageKey)); } catch { raw = null; }
    state = sanitizeState(raw, data);
    ["start-week", "end-week"].forEach(id => {
      for (let w = 1; w <= 18; w++) { const option = el("option", `Week ${w}`); option.value = w; $(id).append(option); }
      $(id).addEventListener("change", () => {
        state[id === "start-week" ? "start" : "end"] = Number($(id).value);
        if (state.end < state.start) { if (id === "start-week") state.end = state.start; else state.start = state.end; }
        save(); render();
      });
    });
    $("tie-rule").addEventListener("change", () => { state.ties = $("tie-rule").value === "survive"; save(); render(); });
    $("fill-plan").addEventListener("click", () => {
      const result = suggestPlan(data, state);
      if (result.errors.length) $("plan-message").textContent = result.errors[0];
      else { state.picks = result.picks; save(); render(); }
    });
    $("clear-plan").addEventListener("click", () => {
      for (let w = state.start; w <= state.end; w++) delete state.picks[w];
      save(); render();
    });
    $("simulate-plan").addEventListener("click", runSimulation);
    renderEvidence(); render(); save();
    $("survivor-content").hidden = false;
    // Only redraw when kickoff locks change, preserving focus during normal use.
    let lockSignature = data.games.map(g => playable(g)).join();
    setInterval(() => {
      const next = data.games.map(g => playable(g)).join();
      if (next !== lockSignature) { lockSignature = next; render(); }
    }, 30000);
  } catch (error) {
    $("survivor-status").textContent = "Survivor data unavailable";
    $("survivor-error").hidden = false;
    $("survivor-error").textContent = `${error.message} Your saved picks have not been cleared. Please try again after the next site update.`;
  }
}

init();
