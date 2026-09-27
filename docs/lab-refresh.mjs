// Snapshot checks and view preservation shared by the simulation labs.
export function validateTeamSnapshot(value) {
  const finite = Number.isFinite;
  if (!value || !Number.isInteger(value.season) || !finite(Date.parse(value.generated_at))
    || !Array.isArray(value.teams) || value.teams.length !== 32 || !Array.isArray(value.games) || value.games.length !== 272
    || !finite(value.league_points) || !finite(value.home_advantage)
    || !value.training || !finite(value.training.margin_sd) || value.training.margin_sd <= 0
    || !finite(value.training.tie_probability) || value.training.tie_probability < 0 || value.training.tie_probability > .1
    || !finite(value.training.training_games) || !finite(Date.parse(value.training.training_first)) || !finite(Date.parse(value.training.training_last))
    || !Array.isArray(value.simulation?.residuals) || value.simulation.residuals.length < 100
    || value.simulation.residuals.some(row => !Array.isArray(row) || row.length !== 3 || !row.every(finite) || row[2] <= 0)
    || !value.backtest || !finite(value.backtest.games)
    || (value.backtest.games && (!Array.isArray(value.backtest.seasons) || !finite(value.backtest.brier_score) || !finite(value.backtest.coin_flip_brier)))) {
    throw new Error("Team snapshot format is invalid.");
  }
  const teams = new Set(), knownTeams = new Set("ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LA LAC LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS".split(" "));
  for (const team of value.teams) {
    if (!team || !knownTeams.has(team.team) || teams.has(team.team) || typeof team.name !== "string"
      || !finite(team.offense) || !finite(team.defense)) throw new Error("Invalid team in snapshot.");
    teams.add(team.team);
  }
  const ids = new Set();
  for (const game of value.games) {
    if (!game || typeof game.game_id !== "string" || ids.has(game.game_id) || !teams.has(game.home) || !teams.has(game.away)
      || game.home === game.away || !Number.isInteger(game.week) || game.week < 1 || game.week > 18
      || !finite(Date.parse(game.kickoff)) || typeof game.status !== "string"
      || (game.status === "final" && (!finite(game.home_score) || !finite(game.away_score)))) throw new Error("Invalid game in snapshot.");
    ids.add(game.game_id);
    if (game.model) {
      const probabilities = [game.model.home_win, game.model.away_win, game.model.tie];
      if (probabilities.some(p => !finite(p) || p < 0 || p > 1) || Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > .00001
        || !finite(game.model.home_points) || !finite(game.model.away_points)) throw new Error("Invalid forecast in snapshot.");
    }
  }
  return true;
}

export function canRefreshLabs() {
  const active = document.activeElement;
  return !document.querySelector("dialog[open]") && !active?.matches("textarea, [contenteditable='true'], input:not([type=checkbox]):not([type=radio]):not([readonly])");
}

export function preserveLabView(render) {
  const active = document.activeElement;
  const selector = active?.id ? `#${CSS.escape(active.id)}`
    : active?.dataset.team && active?.dataset.week ? `[data-team="${CSS.escape(active.dataset.team)}"][data-week="${CSS.escape(active.dataset.week)}"]`
      : active?.getAttribute("aria-label") ? `[aria-label="${CSS.escape(active.getAttribute("aria-label"))}"]`
        : active?.matches("a[href]") ? `a[href="${CSS.escape(active.getAttribute("href"))}"]` : null;
  const x = window.scrollX, y = window.scrollY;
  const scrolls = [...document.querySelectorAll(".survivor-table-scroll, .round-map-scroll")].map(node => ({node, label: node.getAttribute("aria-label"), x: node.scrollLeft, y: node.scrollTop}));
  render();
  if (active?.isConnected) active.focus?.({preventScroll: true});
  else if (selector) document.querySelector(selector)?.focus({preventScroll: true});
  for (const saved of scrolls) {
    const node = saved.node.isConnected ? saved.node : saved.label ? document.querySelector(`[aria-label="${CSS.escape(saved.label)}"]`) : null;
    if (node) { node.scrollLeft = saved.x; node.scrollTop = saved.y; }
  }
  window.scrollTo({left: x, top: y, behavior: "instant"});
}
