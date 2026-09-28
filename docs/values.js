import {MODEL_VERSION, valueFormatKey, buildValueBoard} from "./player-values.mjs?v=20260928-values1";
import {fetchSnapshot, startAutoRefresh, preserveView, snapshotSignature} from "./auto-refresh.mjs?v=20260927-refresh1";
import {validateRankings, validateHistory, validateReports} from "./snapshot-validation.mjs?v=20260927-refresh1";

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(["status", "error", "quarterbacks", "ppr", "te-premium", "search", "position", "rows", "count", "empty", "table-region", "board-heading", "points-heading", "player", "player-heading", "player-meta", "player-content", "player-metrics", "player-note", "weekly-chart", "weekly-note", "weekly-data", "history-chart", "history-note", "history-context", "history-data", "model-version", "assumptions", "coverage"].map(key => [key, $(`values-${key}`)]));
const state = {settings: {quarterbacks: "1QB", ppr: "Half PPR", tePremium: "None"}, horizon: "ros", player: null,
  sources: null, board: null, signature: null, unavailable: [], archive: [], archiveNote: "Checking saved daily captures…", archiveCache: new Map()};
const record = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const finite = Number.isFinite;
const numericOrNull = value => value === null || finite(value);
const dateValid = value => typeof value === "string" && finite(Date.parse(value));
const usableSourceTime = value => dateValid(value?.generated_at) && Date.parse(value.generated_at) <= Date.now() + 300000;
const formatNumber = (value, digits = 1) => finite(value) ? value.toLocaleString(undefined, {maximumFractionDigits: digits, minimumFractionDigits: digits}) : "—";
const formatIndex = value => finite(value) ? value.toLocaleString(undefined, {maximumFractionDigits: 0}) : "—";
const formatDate = value => dateValid(value) ? new Date(value).toLocaleString(undefined, {month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"}) : "time unavailable";
const textNode = (tag, text, className) => {const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node;};
const horizonName = () => state.horizon === "ros" ? "Rest of season" : "Dynasty · 3 years";

function validateInputs(value) {
  const required = ["player_id", "player", "pos", "team", "week", "game_id", "kickoff", "analysis_ready", "passing_yards", "passing_tds", "passing_interceptions", "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost_total", "passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions", "special_teams_tds"];
  if (!record(value) || value.schema_version !== 1 || value.season_type !== "REG" || !Number.isInteger(value.season)
    || !dateValid(value.generated_at) || !Array.isArray(value.columns) || new Set(value.columns).size !== value.columns.length
    || !required.every(key => value.columns.includes(key)) || !Array.isArray(value.rows) || !Array.isArray(value.games) || !value.games.length) return false;
  const ids = new Set();
  for (const game of value.games) {
    if (!record(game) || typeof game.game_id !== "string" || ids.has(game.game_id) || !Number.isInteger(game.week)
      || !dateValid(game.kickoff) || typeof game.home !== "string" || typeof game.away !== "string" || game.home === game.away
      || typeof game.analysis_ready !== "boolean") return false;
    ids.add(game.game_id);
  }
  return value.rows.every(values => {
    if (!Array.isArray(values) || values.length !== value.columns.length) return false;
    const row = Object.fromEntries(value.columns.map((key, index) => [key, values[index]]));
    return ["player_id", "player", "pos", "team", "game_id"].every(key => typeof row[key] === "string" && row[key].length > 0)
      && ids.has(row.game_id) && Number.isInteger(row.week) && dateValid(row.kickoff) && typeof row.analysis_ready === "boolean"
      && required.slice(8).every(key => numericOrNull(row[key]));
  });
}

function validateBoard(board) {
  return record(board) && board.model_version === MODEL_VERSION && Number.isInteger(board.season) && Array.isArray(board.rows)
    && board.rows.every(row => typeof row.player_id === "string" && typeof row.player === "string" && ["QB", "RB", "WR", "TE"].includes(row.pos)
      && ["ros_index", "dynasty_index", "ros_points", "dynasty_points", "projected_ppg"].every(key => numericOrNull(row[key])));
}

function selectedPlayer() { return state.board?.rows.find(row => row.player_id === state.player) || null; }
function orderedRows() {
  return [...(state.board?.rows || [])].sort((a, b) => (a[`rank_${state.horizon}`] ?? Infinity) - (b[`rank_${state.horizon}`] ?? Infinity) || a.player.localeCompare(b.player));
}
function availability(row) {
  if (!row.injury?.current) return "Current status unknown";
  const status = row.injury.currentInjury?.report_status || row.injury.injury?.report_status || row.injury.currentInjury?.status || row.injury.injury?.status || "Current report";
  return `${status} · ${row.injury.reportLabel || "current report"}`;
}
function updateStatus() {
  if (!state.board) return;
  ui.status.textContent = `${state.board.season} · ${state.board.rows.length} players · Box scores checked ${formatDate(state.sources.inputs.sources?.archive?.checked_at)}${state.unavailable.length ? ` · ${state.unavailable.join(" · ")}` : ""}`;
}

function renderTable() {
  if (!state.board) return;
  const query = ui.search.value.trim().toLocaleLowerCase(), position = ui.position.value;
  const rows = orderedRows().filter(row => (position === "all" || row.pos === position)
    && `${row.player} ${row.team || ""}`.toLocaleLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement("tr"); tr.dataset.playerId = row.player_id;
    tr.setAttribute("aria-selected", String(row.player_id === state.player));
    tr.append(textNode("td", formatIndex(row[`rank_${state.horizon}`])));
    const name = document.createElement("td"), button = document.createElement("button");
    button.type = "button"; button.className = "values-player-button"; button.dataset.player = row.player_id;
    button.id = `values-open-${encodeURIComponent(row.player_id)}`;
    button.setAttribute("aria-label", `View ${row.player}'s player notebook`);
    button.setAttribute("aria-pressed", String(row.player_id === state.player));
    const initials = textNode("span", row.player.split(/\s+/).slice(0, 2).map(part => part[0]).join(""), "values-avatar"); initials.setAttribute("aria-hidden", "true");
    const labels = document.createElement("span"); labels.append(textNode("strong", row.player), textNode("small", `${row.team || "Team unknown"} · ${finite(row.age) ? `Age ${row.age}` : "Age unknown"}`), textNode("span", `Value ${formatIndex(row[`${state.horizon}_index`])} · PPG ${formatNumber(row.projected_ppg)}`, "values-mobile-value"));
    button.append(initials, labels); name.append(button); tr.append(name, textNode("td", row.pos));
    const index = textNode("td", formatIndex(row[`${state.horizon}_index`]), "values-index");
    if (row[`${state.horizon}_index`] === null) index.setAttribute("aria-label", "Value unavailable");
    tr.append(index, textNode("td", formatNumber(row.projected_ppg)), textNode("td", formatNumber(row[`${state.horizon}_points`])), textNode("td", formatIndex(row.remaining_games)));
    const status = document.createElement("td"); status.append(textNode("span", availability(row), `values-availability${row.injury?.risk ? " risk" : ""}`)); tr.append(status);
    fragment.append(tr);
  }
  ui.rows.replaceChildren(fragment);
  ui.empty.hidden = rows.length !== 0;
  ui.count.textContent = `${rows.length} of ${state.board.rows.length} players · sorted by modeled surplus`;
  ui["board-heading"].textContent = state.horizon === "ros" ? "Rest-of-season values" : "Three-year dynasty values";
  ui["points-heading"].textContent = state.horizon === "ros" ? "ROS points" : "3-year points*";
  ui["table-region"].setAttribute("aria-busy", "false");
}

const svgNode = (tag, attributes = {}, text) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  if (text !== undefined) node.textContent = text;
  return node;
};
function chart(container, entries, {label, kind = "line", maximum = null} = {}) {
  if (!entries.length) {container.replaceChildren(textNode("p", kind === "bars" ? "No complete current-season scoring observations yet." : "No matching daily value captures yet.", "values-chart-empty")); return;}
  const w = entries.length > 8 ? 640 : Math.max(250, Math.min(640, container.parentElement.clientWidth)), h = 260, left = 54, right = 24, top = 28, bottom = 45;
  const min = Math.min(0, ...entries.map(entry => entry.value)), max = maximum ?? Math.max(1, ...entries.map(entry => entry.value)) * 1.15;
  const xLow = Math.min(...entries.map(entry => entry.x)), xHigh = Math.max(...entries.map(entry => entry.x));
  const x = value => xHigh === xLow ? (w + left - right) / 2 : left + 22 + (value - xLow) / (xHigh - xLow) * (w - left - right - 44);
  const y = value => top + (max - value) / (max - min) * (h - top - bottom);
  const svg = svgNode("svg", {viewBox: `0 0 ${w} ${h}`, class: "values-chart", role: "img", "aria-label": label});
  svg.style.minWidth = `${w}px`;
  svg.dataset.points = entries.length;
  svg.append(svgNode("title", {}, label));
  for (let index = 0; index <= 4; index++) {
    const value = min + (max - min) * index / 4;
    svg.append(svgNode("line", {x1: left, x2: w - right, y1: y(value), y2: y(value), class: "values-chart-gridline"}), svgNode("text", {x: left - 9, y: y(value) + 5, "text-anchor": "end"}, maximum ? formatIndex(Math.round(value)) : formatNumber(value, 0)));
  }
  if (kind === "line" && entries.length > 1) svg.append(svgNode("polyline", {points: entries.map(entry => `${x(entry.x)},${y(entry.value)}`).join(" "), class: "values-chart-line"}));
  entries.forEach((entry, index) => {
    const node = kind === "bars"
      ? svgNode("rect", {x: x(entry.x) - 13, y: Math.min(y(0), y(entry.value)), width: 26, height: Math.max(1, Math.abs(y(entry.value) - y(0))), class: `values-chart-bar${entry.value < 0 ? " negative" : ""}`})
      : svgNode("circle", {cx: x(entry.x), cy: y(entry.value), r: 4.5, class: "values-chart-point"});
    node.append(svgNode("title", {}, `${entry.label}: ${kind === "bars" ? formatNumber(entry.value) + " points" : formatIndex(entry.value) + " value index"}`)); svg.append(node);
    if (entries.length <= 10 || index === 0 || index === entries.length - 1 || index % Math.ceil(entries.length / 6) === 0) svg.append(svgNode("text", {x: x(entry.x), y: h - 17, "text-anchor": "middle"}, entry.label));
  });
  container.replaceChildren(svg);
}
function metric(label, value, detail) {
  const box = document.createElement("div"); box.className = "values-metric";
  box.append(textNode("span", label), textNode("strong", value), textNode("small", detail)); return box;
}
function dataRows(container, entries, formatters, emptyText) {
  container.replaceChildren(...entries.map(entry => {const tr = document.createElement("tr"); formatters.forEach(format => tr.append(textNode("td", format(entry)))); return tr;}));
  if (!entries.length) {const tr = document.createElement("tr"), cell = textNode("td", emptyText); cell.colSpan = formatters.length; tr.append(cell); container.append(tr);}
}

function renderHistory() {
  const player = selectedPlayer(); if (!player) return;
  const format = valueFormatKey(state.settings), column = `${state.horizon}_index`;
  const points = [];
  for (const {entry, snapshot} of state.archive) {
    if (snapshot.model_version !== MODEL_VERSION || snapshot.season !== state.board.season) continue;
    const saved = snapshot.formats?.[format]; if (!saved || !saved.columns.includes(column)) continue;
    const id = saved.columns.indexOf("player_id"), value = saved.columns.indexOf(column);
    const row = saved.rows.find(values => values[id] === player.player_id);
    if (!row || !finite(row[value]) || row[value] < 0 || row[value] > 10000) continue;
    points.push({date: entry.date, x: Date.parse(`${entry.date}T00:00:00Z`), label: entry.date.slice(5), value: row[value]});
  }
  points.sort((a, b) => a.x - b.x);
  chart(ui["history-chart"], points, {label: `${player.player}, ${horizonName()} value index in ${points.length} genuinely saved daily captures`, maximum: 10000});
  dataRows(ui["history-data"], points, [point => point.date, point => formatIndex(point.value)], "No matching capture available.");
  ui["history-context"].textContent = `${horizonName()} · ${state.board.season} · ${state.settings.quarterbacks}, ${state.settings.ppr}${state.settings.tePremium === "+0.5" ? ", TE +0.5" : ""}. Same-model dated captures only.`;
  const count = points.length === 1 ? "One real capture so far; a trend needs more dates." : points.length ? `${points.length} dated captures. Lines connect saved observations, not reconstructed daily values.` : "History starts with the first matching capture; past values are not invented.";
  ui["history-note"].textContent = `${count}${state.archiveNote ? ` ${state.archiveNote}` : ""}`;
}

function renderPlayer() {
  const row = selectedPlayer(); ui["player-content"].hidden = !row; if (!row) return;
  ui.player.value = row.player_id;
  ui["player-heading"].textContent = row.player;
  ui["player-meta"].textContent = `${row.pos} · ${row.team || "Team unknown"} · ${finite(row.age) ? `Age ${row.age}` : "Age unavailable"} · ${row.confidence || "Limited evidence"}`;
  ui["player-metrics"].replaceChildren(
    metric(`${horizonName()} index`, formatIndex(row[`${state.horizon}_index`]), "Relative to this format's modeled surplus"),
    metric("Projected scoring", formatNumber(row.projected_ppg), "Fantasy points per game"),
    metric("Observed scoring", formatNumber(row.current_ppg), `${row.appearances || 0} complete stat appearances`),
    metric("Remaining opportunity", formatIndex(row.available_games), `${formatIndex(row.remaining_games)} scheduled games · ${availability(row)}`),
    metric("Targets per game", formatNumber(row.targets_per_game), "Observed complete stat appearances"),
    metric("Carries per game", formatNumber(row.carries_per_game), "Observed complete stat appearances"),
  );
  const prior = Array.isArray(row.prior_seasons) && row.prior_seasons.length ? `Prior seasons: ${row.prior_seasons.join(", ")}. ` : "No usable recent-season prior. ";
  ui["player-note"].textContent = `${prior}${Array.isArray(row.notes) ? row.notes.join(" ") : ""}`;
  const weekly = (row.weekly || []).filter(game => Number.isInteger(game.week) && finite(game.points)).sort((a, b) => a.week - b.week);
  chart(ui["weekly-chart"], weekly.map(game => ({x: game.week, label: `W${game.week}`, value: game.points})), {label: `${row.player}, observed ${state.board.season} fantasy points by week in ${state.settings.ppr}`, kind: "bars"});
  ui["weekly-note"].textContent = `${weekly.length} observed game${weekly.length === 1 ? "" : "s"}. ${weekly.some(game => game.provisional) ? "Some source results are provisional and may be corrected. " : ""}Byes and missing appearances are not zero-point observations.`;
  dataRows(ui["weekly-data"], weekly, [game => `Week ${game.week}`, game => game.game_id, game => formatNumber(game.points)], "No complete scoring observation available.");
  renderHistory();
}

function renderBoard() {
  const rows = orderedRows();
  if (!rows.some(row => row.player_id === state.player)) state.player = rows[0]?.player_id || null;
  const options = [...rows].sort((a, b) => a.player.localeCompare(b.player));
  const signature = options.map(row => `${row.player_id}|${row.player}|${row.team}`).join("\n");
  if (ui.player.dataset.signature !== signature) {
    ui.player.replaceChildren(...options.map(row => new Option(`${row.player} · ${row.pos} · ${row.team || "—"}`, row.player_id)));
    ui.player.dataset.signature = signature;
  }
  ui.player.disabled = !rows.length;
  renderTable(); renderPlayer(); updateStatus();
  ui["model-version"].textContent = `${MODEL_VERSION} · Fixed 12-team reference · Current calculation ${formatDate(state.board.as_of)}`;
  ui.assumptions.replaceChildren(...(state.board.assumptions || []).filter(item => typeof item === "string").map(item => textNode("li", item)));
  const coverage = state.board.coverage;
  const {inputs, history, news} = state.sources;
  ui.coverage.textContent = `Saved inputs: ${formatIndex(coverage.analysis_ready_games)} analysis-ready games out of ${formatIndex(coverage.scheduled_games)} scheduled games.${finite(coverage.completed_games) && finite(coverage.analysis_ready_games) ? ` ${Math.max(0, coverage.completed_games - coverage.analysis_ready_games)} reported game(s) still awaiting usable statistics.` : ""} Box scores checked ${formatDate(inputs.sources?.archive?.checked_at)}. Schedule scores checked ${formatDate(inputs.sources?.scores?.checked_at)}. History captured ${formatDate(history.generated_at)}. News captured ${formatDate(news.generated_at)}. Value inputs assembled ${formatDate(inputs.generated_at)}; assembly time is not provider freshness.`;
}
function rebuild(force = false) {
  if (!state.sources) return;
  const board = buildValueBoard(state.sources, state.settings, {now: Date.now()});
  if (!validateBoard(board)) throw new Error("Calculated value board is incomplete.");
  const signature = snapshotSignature({...board, as_of: null});
  state.board = board;
  if (force || signature !== state.signature) {
    state.signature = signature;
    preserveView(renderBoard, [ui["table-region"], ...document.querySelectorAll(".values-chart-scroll")]);
  } else updateStatus();
}

function validManifest(value) {
  if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.snapshots)) return false;
  const dates = new Set();
  return value.snapshots.every(entry => {
    if (!record(entry) || typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      || !dateValid(`${entry.date}T00:00:00Z`) || new Date(`${entry.date}T00:00:00Z`).toISOString().slice(0, 10) !== entry.date
      || entry.path !== `${entry.date}.json` || !Number.isInteger(entry.season) || !dateValid(entry.as_of) || typeof entry.model_version !== "string" || dates.has(entry.date)) return false;
    dates.add(entry.date); return true;
  });
}
function validCapture(value) {
  const required = ["player_id", "ros_index", "dynasty_index", "ros_points", "dynasty_points"];
  return record(value) && typeof value.model_version === "string" && Number.isInteger(value.season) && dateValid(value.as_of) && record(value.formats)
    && Object.values(value.formats).every(format => record(format) && Array.isArray(format.columns)
      && new Set(format.columns).size === format.columns.length && required.every(key => format.columns.includes(key)) && Array.isArray(format.rows)
      && format.rows.every(row => Array.isArray(row) && row.length === format.columns.length
        && typeof row[format.columns.indexOf("player_id")] === "string"
        && required.slice(1).every(key => numericOrNull(row[format.columns.indexOf(key)]))));
}
async function refreshArchive(signal) {
  try {
    const manifest = await fetchSnapshot("./data/player_values/index.json", {signal, validate: validManifest});
    const entries = manifest.snapshots.filter(entry => entry.model_version === MODEL_VERSION && entry.season === state.board.season && Date.parse(entry.as_of) <= Date.now() + 300000).sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
    const next = [], unavailable = [];
    // Bound concurrency; changing the selected player never downloads these again.
    for (let offset = 0; offset < entries.length; offset += 4) await Promise.all(entries.slice(offset, offset + 4).map(async entry => {
      const key = `${entry.path}|${entry.as_of}|${entry.model_version}`;
      try {
        const snapshot = state.archiveCache.get(key) || await fetchSnapshot(`./data/player_values/${entry.path}`, {signal, validate: validCapture});
        if (snapshot.model_version !== entry.model_version || snapshot.as_of !== entry.as_of) return;
        next.push({entry, snapshot}); state.archiveCache.set(key, snapshot);
      } catch (error) {signal.throwIfAborted(); unavailable.push(entry.date);}
    }));
    signal.throwIfAborted();
    state.archive = next;
    state.archiveNote = unavailable.length ? `${unavailable.length} capture(s) unavailable; those dates are omitted.` : "";
    const keep = new Set(entries.map(entry => `${entry.path}|${entry.as_of}|${entry.model_version}`));
    for (const key of state.archiveCache.keys()) if (!keep.has(key)) state.archiveCache.delete(key);
  } catch (error) {
    signal.throwIfAborted();
    state.archiveNote = state.archive.length ? "Daily history refresh unavailable; showing previously loaded captures." : "Daily archive unavailable or not published yet.";
  }
  preserveView(renderHistory, [...document.querySelectorAll(".values-chart-scroll")]);
}
async function refresh(signal) {
  const unavailable = [];
  const optional = async (url, validate, fallback, label) => {
    try {return await fetchSnapshot(url, {signal, validate});}
    catch (error) {signal.throwIfAborted(); unavailable.push(label); return fallback;}
  };
  const [rankings, inputs, history, news] = await Promise.all([
    fetchSnapshot("./data/rankings.json", {signal, validate: validateRankings}),
    fetchSnapshot("./data/player_value_inputs.json", {signal, validate: validateInputs}),
    optional("./data/player_history.json", value => validateHistory(value) && usableSourceTime(value), state.sources?.history || {}, "History unavailable; limited prior evidence"),
    optional("./data/player_news.json", value => validateReports(value) && usableSourceTime(value), {}, "News unavailable; injury status unknown"),
  ]);
  signal.throwIfAborted();
  if (rankings.projection_season !== inputs.season) throw new Error("Player rankings and game inputs belong to different seasons.");
  const sources = {rankings, inputs, history, news};
  const board = buildValueBoard(sources, state.settings, {now: Date.now()});
  if (!validateBoard(board)) throw new Error("Calculated value board is incomplete.");
  state.sources = sources; state.unavailable = unavailable;
  ui.error.hidden = true; rebuild();
  await refreshArchive(signal);
  if (unavailable.length) throw new Error(unavailable.join(" · "));
}

for (const key of ["quarterbacks", "ppr", "te-premium"]) ui[key].addEventListener("change", () => {
  state.settings = {quarterbacks: ui.quarterbacks.value, ppr: ui.ppr.value, tePremium: ui["te-premium"].value};
  try {rebuild(true);} catch (error) {ui.error.textContent = error.message; ui.error.hidden = false;}
});
document.querySelectorAll("[data-horizon]").forEach(button => button.addEventListener("click", () => {
  state.horizon = button.dataset.horizon;
  document.querySelectorAll("[data-horizon]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  preserveView(() => {renderTable(); renderPlayer();}, [ui["table-region"]]);
}));
ui.search.addEventListener("input", renderTable);
ui.position.addEventListener("change", renderTable);
ui.player.addEventListener("change", () => {state.player = ui.player.value; preserveView(() => {renderTable(); renderPlayer();}, [ui["table-region"]]);});
ui.rows.addEventListener("click", event => {
  const button = event.target.closest("[data-player]"); if (!button) return;
  state.player = button.dataset.player;
  preserveView(() => {renderTable(); renderPlayer();}, [ui["table-region"]]);
});
let chartWidths = "", chartResizeFrame = null;
const chartResize = new ResizeObserver(() => {
  const next = [...document.querySelectorAll(".values-chart-scroll")].map(element => element.clientWidth).join("|");
  if (next === chartWidths) return;
  chartWidths = next;
  if (chartResizeFrame !== null) cancelAnimationFrame(chartResizeFrame);
  // Paint in the next frame: a new chart's height may itself resize the region.
  // Writing inside ResizeObserver delivery causes loop errors in WebKit.
  chartResizeFrame = requestAnimationFrame(() => {
    chartResizeFrame = null;
    if (state.board) preserveView(renderPlayer, [...document.querySelectorAll(".values-chart-scroll")]);
  });
});
document.querySelectorAll(".values-chart-scroll").forEach(element => chartResize.observe(element));
startAutoRefresh(refresh, {
  canRefresh: () => !document.activeElement?.matches("select") && !document.querySelector("dialog[open]"),
  onCheck: () => {if (state.sources) rebuild();},
  onError: error => {
    ui.error.hidden = false;
    ui.error.textContent = state.board ? `Update incomplete; available data remains visible. ${error.message}` : `Could not build the value board. ${error.message} Retrying automatically.`;
    if (!state.board) {ui.status.textContent = "Waiting for valid saved player inputs. No values have been invented."; ui["table-region"].setAttribute("aria-busy", "false");}
  },
});
