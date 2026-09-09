import { historyWindow, sampleStandardDeviation } from "./player-history.mjs?v=20260909-history10";
import {
  applyProjectionModel,
  POSITIONS,
  positionAgeCurve,
  roundPositionExpectations,
} from "./projection-model.mjs?v=20260909-history10";

const DATA_URL = "./data/rankings.json";
const HISTORY_URL = "./data/player_history.json";
const NEWS_URL = "./data/player_news.json";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const ui = {
  status: document.querySelector("#projection-status"),
  teams: document.querySelector("#model-teams"),
  quarterbacks: document.querySelector("#model-quarterbacks"),
  ppr: document.querySelector("#model-ppr"),
  tePremium: document.querySelector("#model-te-premium"),
  position: document.querySelector("#model-position"),
  player: document.querySelector("#model-player"),
  loading: document.querySelector("#projection-loading"),
  content: document.querySelector("#projection-content"),
  error: document.querySelector("#projection-error"),
  historyCopy: document.querySelector("#projection-history-copy"),
  ageHeading: document.querySelector("#age-curve-heading"),
  ageSummary: document.querySelector("#age-curve-summary"),
  ageChart: document.querySelector("#age-chart"),
  playerCards: document.querySelector("#player-projection-cards"),
  positionVariance: document.querySelector("#position-variance"),
  roundMap: document.querySelector("#round-map"),
};

const params = new URLSearchParams(window.location.search);
const state = {
  data: null,
  history: null,
  news: null,
  settings: {
    teams: params.get("teams") || "12",
    quarterbacks: params.get("quarterbacks") || "2QB",
    ppr: params.get("ppr") || "Half PPR",
    tePremium: params.get("tePremium") || "+0.5",
  },
  position: POSITIONS.includes(params.get("pos")) ? params.get("pos") : "RB",
  player: params.get("player") || "",
  rows: [],
  samples: [],
};

function numeric(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) / numbers.length : null;
}

function slug() {
  const ppr = { Standard: "standard", "Half PPR": "half_ppr", "Full PPR": "full_ppr" }[state.settings.ppr];
  const qb = state.settings.quarterbacks.toLowerCase();
  let format;
  if (state.settings.tePremium === "+0.5") {
    if (ppr === "half_ppr" && qb === "1qb") format = "te_premium_half_ppr";
    else if (ppr === "half_ppr" && qb === "2qb") format = "2qb_te_premium_half_ppr";
    else format = `${qb}_te_premium_${ppr}`;
  } else {
    format = `${qb}_${ppr}`;
  }
  return `${state.settings.teams}team_${format}`;
}

function boardRows() {
  const board = state.data.boards[slug()];
  if (!board) throw new Error(`Missing ranking format ${slug()}`);
  return board.map(values => {
    const row = Object.fromEntries(state.data.columns.map((column, index) => [column, values[index]]));
    row.listed_team = String(row.team || "").toUpperCase();
    row.current_team = row.listed_team;
    row.is_rookie = row.is_rookie === true || String(row.is_rookie).toLocaleLowerCase() === "true";
    return row;
  });
}

function syncControls() {
  ui.teams.value = state.settings.teams;
  ui.quarterbacks.value = state.settings.quarterbacks;
  ui.ppr.value = state.settings.ppr;
  ui.tePremium.value = state.settings.tePremium;
  ui.position.value = state.position;
}

function syncUrl() {
  const next = new URL(window.location.href);
  next.searchParams.set("teams", state.settings.teams);
  next.searchParams.set("quarterbacks", state.settings.quarterbacks);
  next.searchParams.set("ppr", state.settings.ppr);
  next.searchParams.set("tePremium", state.settings.tePremium);
  next.searchParams.set("pos", state.position);
  if (state.player) next.searchParams.set("player", state.player);
  else next.searchParams.delete("player");
  window.history.replaceState({}, "", next);
}

function svgNode(name, attributes = {}, text = null) {
  const node = document.createElementNS(SVG_NAMESPACE, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text !== null) node.textContent = text;
  return node;
}

function withTooltip(node, text) {
  node.append(svgNode("title", {}, text));
  return node;
}

function selectedPlayer() {
  return state.rows.find(row => row.pos === state.position && row.player === state.player)
    || state.rows.find(row => row.pos === state.position)
    || null;
}

function historySampleDescription() {
  const window = historyWindow(state.history);
  return window.count ? `${window.range} history` : "available history";
}

function renderPlayerOptions() {
  const choices = state.rows
    .filter(row => row.pos === state.position)
    .sort((left, right) => left.overall_rank - right.overall_rank);
  const preferred = choices.some(row => row.player === state.player) ? state.player : choices[0]?.player || "";
  state.player = preferred;
  ui.player.replaceChildren(...choices.map(row => new Option(`${row.player} · ${row.position_rank}`, row.player, false, row.player === preferred)));
}

function metricCard(label, value, detail, tone = "") {
  const card = document.createElement("article");
  card.className = `model-metric-card ${tone}`.trim();
  const name = document.createElement("span");
  name.textContent = label;
  const number = document.createElement("strong");
  number.textContent = value;
  const context = document.createElement("small");
  context.textContent = detail;
  card.append(name, number, context);
  return card;
}

function renderPlayerCards(player) {
  if (!player) {
    ui.playerCards.replaceChildren();
    return;
  }
  const adjustment = numeric(player.age_adjustment_pct);
  const range = numeric(player.projection_low) !== null && numeric(player.projection_high) !== null
    ? `${Number(player.projection_low).toFixed(0)}–${Number(player.projection_high).toFixed(0)}`
    : "—";
  ui.playerCards.replaceChildren(
    metricCard("Projected PPG", numeric(player.projected_ppg)?.toFixed(1) || "—", `${state.settings.ppr}${player.pos === "TE" && state.settings.tePremium === "+0.5" ? " + TE premium" : ""}`, "featured"),
    metricCard("Season projection", numeric(player.projected_points)?.toFixed(1) || "—", `${numeric(player.projection_expected_games)?.toFixed(1) || "—"} expected games`),
    metricCard("Expected range", range, "± one model standard deviation"),
    metricCard("Age adjustment", adjustment === null ? "—" : `${adjustment >= 0 ? "+" : ""}${adjustment.toFixed(1)}%`, `${Math.round(numeric(player.age) || 0)} years old · ${Number(player.age_change_sample) || 0} comparable transitions`),
    metricCard("Position at this age", numeric(player.position_mean_ppg)?.toFixed(1) || "—", `Average PPG · SD ${numeric(player.position_stddev_ppg)?.toFixed(1) || "—"}`),
  );
}

function renderAgeChart(player) {
  const samples = state.samples.filter(sample => sample.pos === state.position);
  const curve = positionAgeCurve(state.samples, state.position);
  if (!samples.length || !curve.length) {
    ui.ageChart.textContent = "Age data is not yet available for this position.";
    return;
  }
  const width = 980;
  const height = 430;
  const margin = { top: 30, right: 30, bottom: 52, left: 58 };
  const playerAge = numeric(player?.age);
  const minAge = Math.min(...curve.map(point => point.age), playerAge ?? Infinity);
  const maxAge = Math.max(...curve.map(point => point.age), playerAge ?? -Infinity);
  const maxPpg = Math.max(
    1,
    ...samples.map(sample => sample.fantasy_points_per_game),
    ...curve.map(point => point.mean + (point.stddev || 0)),
    numeric(player?.projected_ppg) || 0,
  ) * 1.08;
  const x = age => margin.left + (((age - minAge) / Math.max(1, maxAge - minAge)) * (width - margin.left - margin.right));
  const y = points => height - margin.bottom - ((Math.max(0, points) / maxPpg) * (height - margin.top - margin.bottom));
  const svg = svgNode("svg", {
    class: "model-age-chart",
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${state.position} fantasy points per game by age, with ${player?.player || "the selected player"} highlighted`,
  });

  [0, 0.25, 0.5, 0.75, 1].forEach(ratio => {
    const value = maxPpg * ratio;
    svg.append(
      svgNode("line", { class: "model-grid-line", x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value) }),
      svgNode("text", { class: "model-axis-label", x: margin.left - 10, y: y(value) + 4, "text-anchor": "end" }, value.toFixed(0)),
    );
  });
  for (let age = minAge; age <= maxAge; age += 1) {
    svg.append(svgNode("text", { class: "model-axis-label", x: x(age), y: height - 22, "text-anchor": "middle" }, String(age)));
  }
  svg.append(svgNode("text", { class: "model-axis-title", x: width / 2, y: height - 3, "text-anchor": "middle" }, "Age on September 1"));
  svg.append(svgNode("text", { class: "model-axis-title", x: 14, y: height / 2, transform: `rotate(-90 14 ${height / 2})`, "text-anchor": "middle" }, "Fantasy points per game"));

  const upper = curve.map(point => `${x(point.age)},${y(point.mean + (point.stddev || 0))}`);
  const lower = [...curve].reverse().map(point => `${x(point.age)},${y(Math.max(0, point.mean - (point.stddev || 0)))}`);
  svg.append(svgNode("polygon", { class: "model-curve-band", points: [...upper, ...lower].join(" ") }));

  samples.forEach((sample, index) => {
    const isSelected = player && (sample.identity === (player.player_id ? `id:${player.player_id}` : "") || sample.player === player.player);
    const jitter = ((index % 7) - 3) * 1.4;
    svg.append(withTooltip(svgNode("circle", {
      class: isSelected ? "model-player-season selected" : "model-player-season",
      cx: x(sample.age) + jitter,
      cy: y(sample.fantasy_points_per_game),
      r: isSelected ? 6 : 3.2,
    }), `${sample.player}, age ${sample.age} (${sample.season}): ${sample.fantasy_points_per_game.toFixed(1)} FPTS/G in ${sample.games} games`));
  });

  const linePoints = curve.map(point => `${x(point.age)},${y(point.mean)}`).join(" ");
  svg.append(withTooltip(svgNode("polyline", { class: "model-curve-line", points: linePoints }), `${state.position} smoothed position average`));
  curve.forEach(point => {
    svg.append(withTooltip(svgNode("circle", { class: "model-curve-point", cx: x(point.age), cy: y(point.mean), r: 4 }), `Age ${point.age}: ${point.mean.toFixed(1)} average FPTS/G, SD ${point.stddev?.toFixed(1) || "—"}, ${point.count} player-seasons`));
  });

  if (player && numeric(player.age) !== null && numeric(player.projected_ppg) !== null) {
    const centerX = x(player.age);
    const centerY = y(player.projected_ppg);
    const size = 9;
    svg.append(
      withTooltip(svgNode("polygon", {
        class: "model-projection-point",
        points: `${centerX},${centerY - size} ${centerX + size},${centerY} ${centerX},${centerY + size} ${centerX - size},${centerY}`,
      }), `${player.player} ${state.data.projection_season} projection: ${Number(player.projected_ppg).toFixed(1)} FPTS/G at age ${Math.round(player.age)}`),
      svgNode("text", { class: "model-projection-label", x: centerX, y: Math.max(18, centerY - 15), "text-anchor": "middle" }, `${player.player} projection`),
    );
  }
  ui.ageChart.replaceChildren(svg);
}

function renderPositionVariance() {
  const cards = POSITIONS.map(position => {
    const rows = state.rows.filter(row => row.pos === position && numeric(row.projected_points) !== null);
    const points = rows.map(row => Number(row.projected_points));
    const ppg = rows.map(row => numeric(row.projected_ppg)).filter(Number.isFinite);
    return metricCard(
      position,
      average(points)?.toFixed(1) || "—",
      `Season points · SD ${sampleStandardDeviation(points)?.toFixed(1) || "—"} · ${rows.length} players · ${average(ppg)?.toFixed(1) || "—"} PPG`,
      position === state.position ? "featured" : "",
    );
  });
  ui.positionVariance.replaceChildren(...cards);
}

function renderRoundMap() {
  const expectations = roundPositionExpectations(state.rows, state.settings.teams, 15);
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  ["Round", ...POSITIONS].forEach(label => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    header.append(th);
  });
  head.append(header);
  const body = document.createElement("tbody");
  for (let round = 1; round <= 15; round += 1) {
    const tr = document.createElement("tr");
    const roundCell = document.createElement("th");
    roundCell.scope = "row";
    roundCell.textContent = String(round);
    tr.append(roundCell);
    POSITIONS.forEach(position => {
      const result = expectations.find(item => item.round === round && item.pos === position);
      const td = document.createElement("td");
      if (!result?.count) {
        td.className = "round-empty";
        td.textContent = "—";
      } else {
        const value = document.createElement("strong");
        value.textContent = result.mean.toFixed(0);
        const spread = document.createElement("span");
        spread.textContent = result.stddev === null ? "SD —" : `± ${result.stddev.toFixed(0)}`;
        const count = document.createElement("small");
        count.textContent = `${result.count} player${result.count === 1 ? "" : "s"}`;
        td.append(value, spread, count);
      }
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(head, body);
  ui.roundMap.replaceChildren(table);
}

function render() {
  const modeled = applyProjectionModel(boardRows(), state.history, state.news, state.settings, state.data.projection_season);
  state.rows = modeled.rows;
  state.samples = modeled.samples;
  renderPlayerOptions();
  const player = selectedPlayer();
  state.player = player?.player || "";
  ui.ageHeading.textContent = `${state.position} production by age`;
  ui.ageSummary.textContent = player
    ? `${player.player} is projected for ${numeric(player.projected_ppg)?.toFixed(1) || "—"} points per game at age ${numeric(player.age) === null ? "unknown" : Math.round(player.age)}. The faded dots are every qualifying ${state.position} season in the ${historySampleDescription()}.`
    : `No ${state.position} player is available for this format.`;
  renderAgeChart(player);
  renderPlayerCards(player);
  renderPositionVariance();
  renderRoundMap();
  syncUrl();
}

function connectControls() {
  [ui.teams, ui.quarterbacks, ui.ppr, ui.tePremium].forEach(control => {
    control.addEventListener("change", () => {
      state.settings = {
        teams: ui.teams.value,
        quarterbacks: ui.quarterbacks.value,
        ppr: ui.ppr.value,
        tePremium: ui.tePremium.value,
      };
      render();
    });
  });
  ui.position.addEventListener("change", () => {
    state.position = ui.position.value;
    state.player = "";
    render();
  });
  ui.player.addEventListener("change", () => {
    state.player = ui.player.value;
    const player = selectedPlayer();
    ui.ageSummary.textContent = player
      ? `${player.player} is projected for ${numeric(player.projected_ppg)?.toFixed(1) || "—"} points per game at age ${numeric(player.age) === null ? "unknown" : Math.round(player.age)}. The faded dots are every qualifying ${state.position} season in the ${historySampleDescription()}.`
      : "Select a player to compare.";
    renderAgeChart(player);
    renderPlayerCards(player);
    syncUrl();
  });
}

async function load() {
  syncControls();
  connectControls();
  try {
    const [rankingsResponse, historyResponse, newsResponse] = await Promise.all([
      fetch(DATA_URL, { cache: "no-store" }),
      fetch(HISTORY_URL, { cache: "no-store" }),
      fetch(NEWS_URL, { cache: "no-store" }),
    ]);
    if (![rankingsResponse, historyResponse, newsResponse].every(response => response.ok)) throw new Error("One or more model inputs are unavailable");
    [state.data, state.history, state.news] = await Promise.all([
      rankingsResponse.json(), historyResponse.json(), newsResponse.json(),
    ]);
    const historyCoverage = historyWindow(state.history);
    const historyPhrase = historyCoverage.count
      ? `${historyCoverage.count}-season history (${historyCoverage.range})`
      : "available history";
    ui.historyCopy.textContent = `Compare a player with every same-position season in the maintained ${historyPhrase}. Recent production sets the baseline, position-specific aging adjusts the scoring rate, and expected games turns it into a season projection.`;
    render();
    ui.status.textContent = `${state.data.projection_season} model · ${historyCoverage.label} · ${state.samples.length} qualifying player-seasons`;
    ui.loading.classList.add("hidden");
    ui.content.classList.remove("hidden");
  } catch (error) {
    ui.loading.classList.add("hidden");
    ui.error.classList.remove("hidden");
    ui.status.textContent = "Projection data unavailable";
  }
}

load();
