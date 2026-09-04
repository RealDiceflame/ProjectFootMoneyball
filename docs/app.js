const DATA_URL = "./data/rankings.json";
const DRAFTED_KEY = "project-foot-moneyball:drafted:v1";
const SETTINGS_KEY = "project-foot-moneyball:settings:v1";

const columns = [
  { key: "drafted", label: "Drafted", width: 62, kind: "drafted" },
  { key: "overall_rank", label: "Rank", width: 62, kind: "number" },
  { key: "player", label: "Player", width: 200, kind: "text", className: "player" },
  { key: "team", label: "Team", width: 65, kind: "category" },
  { key: "pos", label: "Pos", width: 58, kind: "category" },
  { key: "position_rank", label: "Pos Rank", width: 78, kind: "positionRank" },
  { key: "projected_points", label: "Projected", width: 88, kind: "number" },
  { key: "vorp", label: "VORP", width: 78, kind: "number" },
  { key: "adp", label: "ADP", width: 70, kind: "number" },
  { key: "value_vs_adp", label: "Value", width: 70, kind: "number" },
  { key: "Yahoo", label: "Yahoo", width: 70, kind: "number" },
  { key: "Sleeper", label: "Sleeper", width: 74, kind: "number" },
  { key: "NFL", label: "NFL/ESPN", width: 82, kind: "number" },
  { key: "draft_tag", label: "Draft Tag", width: 82, kind: "category" },
];

const ui = {
  teams: document.querySelector("#teams"),
  quarterbacks: document.querySelector("#quarterbacks"),
  ppr: document.querySelector("#ppr"),
  tePremium: document.querySelector("#te-premium"),
  sourceStatus: document.querySelector("#source-status"),
  boardHeading: document.querySelector("#board-heading"),
  boardSummary: document.querySelector("#board-summary"),
  search: document.querySelector("#search"),
  positionFilters: document.querySelector("#position-filters"),
  clearFilters: document.querySelector("#clear-filters"),
  exportBoard: document.querySelector("#export-board"),
  resetDraft: document.querySelector("#reset-draft"),
  resetDialog: document.querySelector("#reset-dialog"),
  tableShell: document.querySelector("#table-shell"),
  tableHead: document.querySelector("#table-head"),
  tableBody: document.querySelector("#table-body"),
  loadingState: document.querySelector("#loading-state"),
  emptyState: document.querySelector("#empty-state"),
  emptyClear: document.querySelector("#empty-clear"),
};

const savedDrafted = loadJson(DRAFTED_KEY, []);
const state = {
  data: null,
  settings: loadJson(SETTINGS_KEY, { teams: "12", quarterbacks: "2QB", ppr: "Half PPR", tePremium: "+0.5" }),
  drafted: new Set(Array.isArray(savedDrafted) ? savedDrafted : []),
  search: "",
  position: "ALL",
  filters: {},
  sortColumn: "overall_rank",
  sortAscending: true,
  visibleRows: [],
};

function loadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The board still works when private browsing blocks storage.
  }
}

function rankingSlug() {
  const qb = state.settings.quarterbacks.toLowerCase();
  const ppr = { "Standard": "standard", "Half PPR": "half_ppr", "Full PPR": "full_ppr" }[state.settings.ppr];
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

function playerKey(row) {
  return `${String(row.player).trim().toLocaleLowerCase()}|${String(row.team).trim().toUpperCase()}`;
}

function rowsForCurrentBoard() {
  const arrays = state.data.boards[rankingSlug()];
  if (!arrays) throw new Error(`Rankings are missing for ${rankingSlug()}`);
  return arrays.map(values => Object.fromEntries(state.data.columns.map((column, index) => [column, values[index]])));
}

function numeric(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function matchesFilter(value, rawQuery, kind) {
  const query = rawQuery.trim();
  if (!query) return true;
  const text = value === null || value === undefined ? "" : String(value).trim();
  const normalized = query.toLocaleLowerCase();
  if (normalized === "blank" || normalized === "empty") return text === "" || text === "-";
  if (normalized === "not blank" || normalized === "not empty") return text !== "" && text !== "-";

  if (kind === "number") {
    const valueNumber = numeric(value);
    const range = query.match(/^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/);
    if (range && valueNumber !== null) {
      const low = Math.min(Number(range[1]), Number(range[2]));
      const high = Math.max(Number(range[1]), Number(range[2]));
      return valueNumber >= low && valueNumber <= high;
    }
    const comparison = query.match(/^(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?)$/);
    if (comparison && valueNumber !== null) {
      const wanted = Number(comparison[2]);
      return { ">": valueNumber > wanted, ">=": valueNumber >= wanted, "<": valueNumber < wanted, "<=": valueNumber <= wanted, "=": valueNumber === wanted }[comparison[1]];
    }
    if (/^-?\d+(?:\.\d+)?$/.test(query) && valueNumber !== null) return valueNumber === Number(query);
  }

  const terms = query.split(",").map(term => term.trim().toLocaleLowerCase()).filter(Boolean);
  if (!terms.length) return true;
  if (kind === "category") return terms.includes(text.toLocaleLowerCase());
  return terms.some(term => text.toLocaleLowerCase().includes(term));
}

function filterRows(rows) {
  const search = state.search.trim().toLocaleLowerCase();
  return rows.filter(row => {
    const drafted = state.drafted.has(playerKey(row));
    if (search && ![row.player, row.team, row.pos].some(value => String(value).toLocaleLowerCase().includes(search))) return false;
    if (state.position !== "ALL" && row.pos !== state.position) return false;
    return columns.every(column => {
      const query = state.filters[column.key] || "";
      if (column.key === "drafted") return !query || (query === "yes" ? drafted : !drafted);
      return matchesFilter(row[column.key], query, column.kind);
    });
  });
}

function sortRows(rows) {
  const meta = columns.find(column => column.key === state.sortColumn);
  const direction = state.sortAscending ? 1 : -1;
  return [...rows].sort((left, right) => {
    let a = meta.key === "drafted" ? state.drafted.has(playerKey(left)) : left[meta.key];
    let b = meta.key === "drafted" ? state.drafted.has(playerKey(right)) : right[meta.key];
    if (meta.kind === "number" || meta.kind === "drafted") {
      a = meta.kind === "drafted" ? Number(a) : numeric(a);
      b = meta.kind === "drafted" ? Number(b) : numeric(b);
      if (a === null && b !== null) return 1;
      if (a !== null && b === null) return -1;
      if (a !== b) return (a - b) * direction;
    } else if (meta.kind === "positionRank") {
      const rankA = Number(String(a).replace(/\D/g, ""));
      const rankB = Number(String(b).replace(/\D/g, ""));
      if (rankA !== rankB) return (rankA - rankB) * direction;
    } else {
      const compared = String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base", numeric: true });
      if (compared) return compared * direction;
    }
    return Number(left.overall_rank) - Number(right.overall_rank);
  });
}

function formatValue(column, value) {
  if (value === null || value === undefined || value === "-") return "—";
  if (column.kind === "number" && column.key !== "overall_rank") return Number(value).toFixed(1);
  return String(value);
}

function renderHead() {
  const headings = document.createElement("tr");
  headings.className = "heading-row";
  const filters = document.createElement("tr");
  filters.className = "filter-row";
  for (const column of columns) {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.style.minWidth = `${column.width}px`;
    heading.style.textAlign = column.key === "player" ? "left" : "center";
    const indicator = state.sortColumn === column.key ? (state.sortAscending ? "▲" : "▼") : "";
    heading.innerHTML = `<button class="sort-button" type="button" data-sort="${column.key}"><span>${column.label}</span><span class="sort-indicator">${indicator}</span></button>`;
    headings.append(heading);

    const filterCell = document.createElement("th");
    filterCell.innerHTML = column.key === "drafted"
      ? `<select data-filter="drafted" aria-label="Filter Drafted"><option value="">All</option><option value="no">Open</option><option value="yes">Drafted</option></select>`
      : `<input data-filter="${column.key}" aria-label="Filter ${column.label}" placeholder="Filter" autocomplete="off">`;
    filters.append(filterCell);
  }
  ui.tableHead.replaceChildren(headings, filters);
}

function tagElement(tag) {
  const safeTag = ["TARGET", "VALUE", "FAIR", "REACH"].includes(tag) ? tag : "FAIR";
  const span = document.createElement("span");
  span.className = `tag tag-${safeTag.toLowerCase()}`;
  span.textContent = safeTag;
  return span;
}

function renderBody(rows) {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const key = playerKey(row);
    const drafted = state.drafted.has(key);
    const tr = document.createElement("tr");
    if (drafted) tr.className = "drafted";
    for (const column of columns) {
      const td = document.createElement("td");
      if (column.className) td.classList.add(column.className);
      if (column.key === "overall_rank") td.classList.add("rank");
      if (column.kind === "number") td.classList.add("numeric");
      if (column.key === "drafted") {
        const button = document.createElement("button");
        button.className = "draft-toggle";
        button.type = "button";
        button.setAttribute("aria-label", `${drafted ? "Undo drafted" : "Mark drafted"}: ${row.player}`);
        button.setAttribute("aria-pressed", String(drafted));
        button.dataset.draftKey = encodeURIComponent(key);
        button.textContent = "✓";
        td.append(button);
      } else if (column.key === "draft_tag") {
        td.append(tagElement(row.draft_tag));
      } else {
        td.textContent = formatValue(column, row[column.key]);
      }
      tr.append(td);
    }
    fragment.append(tr);
  }
  ui.tableBody.replaceChildren(fragment);
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function restoreFilterInputs() {
  ui.tableHead.querySelectorAll("[data-filter]").forEach(control => { control.value = state.filters[control.dataset.filter] || ""; });
}

function updateSortIndicators() {
  ui.tableHead.querySelectorAll("[data-sort]").forEach(button => {
    const indicator = button.querySelector(".sort-indicator");
    indicator.textContent = button.dataset.sort === state.sortColumn ? (state.sortAscending ? "▲" : "▼") : "";
  });
}

function render() {
  if (!state.data) return;
  const allRows = rowsForCurrentBoard();
  state.visibleRows = sortRows(filterRows(allRows));
  updateSortIndicators();
  renderBody(state.visibleRows);
  const draftedCount = allRows.filter(row => state.drafted.has(playerKey(row))).length;
  ui.boardSummary.textContent = `Showing ${state.visibleRows.length} of ${allRows.length} players · ${draftedCount} drafted · click any heading to sort`;
  ui.emptyState.classList.toggle("hidden", state.visibleRows.length !== 0);
  ui.tableShell.setAttribute("aria-busy", "false");
  ui.exportBoard.disabled = false;
  ui.resetDraft.disabled = draftedCount === 0;
}

function applySettingsToControls() {
  ui.teams.value = state.settings.teams;
  ui.quarterbacks.value = state.settings.quarterbacks;
  ui.ppr.value = state.settings.ppr;
  ui.tePremium.value = state.settings.tePremium;
}

function updateSettings() {
  state.settings = { teams: ui.teams.value, quarterbacks: ui.quarterbacks.value, ppr: ui.ppr.value, tePremium: ui.tePremium.value };
  state.sortColumn = "overall_rank";
  state.sortAscending = true;
  saveJson(SETTINGS_KEY, state.settings);
  render();
}

function clearFilters() {
  state.search = "";
  state.position = "ALL";
  state.filters = {};
  ui.search.value = "";
  ui.tableHead.querySelectorAll("[data-filter]").forEach(control => { control.value = ""; });
  ui.positionFilters.querySelectorAll(".position").forEach(button => button.classList.toggle("active", button.dataset.position === "ALL"));
  render();
}

function toggleDrafted(key) {
  if (state.drafted.has(key)) state.drafted.delete(key);
  else state.drafted.add(key);
  saveJson(DRAFTED_KEY, [...state.drafted].sort());
  render();
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportVisibleBoard() {
  const exportColumns = columns.filter(column => column.key !== "drafted");
  const lines = [exportColumns.map(column => csvCell(column.label)).join(",")];
  for (const row of state.visibleRows) lines.push(exportColumns.map(column => csvCell(row[column.key])).join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ProjectFootMoneyball-${rankingSlug()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  [ui.teams, ui.quarterbacks, ui.ppr, ui.tePremium].forEach(control => control.addEventListener("change", updateSettings));
  ui.search.addEventListener("input", event => { state.search = event.target.value; render(); });
  ui.positionFilters.addEventListener("click", event => {
    const button = event.target.closest("[data-position]");
    if (!button) return;
    state.position = button.dataset.position;
    ui.positionFilters.querySelectorAll(".position").forEach(item => item.classList.toggle("active", item === button));
    render();
  });
  ui.tableHead.addEventListener("click", event => {
    const button = event.target.closest("[data-sort]");
    if (!button) return;
    if (state.sortColumn === button.dataset.sort) state.sortAscending = !state.sortAscending;
    else { state.sortColumn = button.dataset.sort; state.sortAscending = true; }
    render();
  });
  const updateHeaderFilter = event => {
    if (!event.target.matches("[data-filter]")) return;
    state.filters[event.target.dataset.filter] = event.target.value;
    render();
  };
  ui.tableHead.addEventListener("input", updateHeaderFilter);
  ui.tableHead.addEventListener("change", updateHeaderFilter);
  ui.tableBody.addEventListener("click", event => {
    const button = event.target.closest("[data-draft-key]");
    if (button) toggleDrafted(decodeURIComponent(button.dataset.draftKey));
  });
  ui.clearFilters.addEventListener("click", clearFilters);
  ui.emptyClear.addEventListener("click", clearFilters);
  ui.exportBoard.addEventListener("click", exportVisibleBoard);
  ui.resetDraft.addEventListener("click", () => ui.resetDialog.showModal());
  ui.resetDialog.addEventListener("close", () => {
    if (ui.resetDialog.returnValue !== "confirm") return;
    state.drafted.clear();
    saveJson(DRAFTED_KEY, []);
    render();
  });
}

async function loadRankings() {
  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Rankings request failed (${response.status})`);
    const data = await response.json();
    if (!data.boards || !data.columns) throw new Error("The rankings file is incomplete");
    state.data = data;
    ui.sourceStatus.textContent = `${data.projection_season} board · ADP updated ${formatDate(data.adp_updated)}`;
    ui.boardHeading.textContent = `${data.projection_season} player rankings`;
    ui.loadingState.classList.add("hidden");
    renderHead();
    restoreFilterInputs();
    render();
  } catch (error) {
    ui.loadingState.innerHTML = `<strong>The rankings could not load.</strong><span>${error.message}</span><button class="button secondary" type="button" id="retry-load">Try again</button>`;
    document.querySelector("#retry-load").addEventListener("click", () => location.reload());
    ui.sourceStatus.textContent = "Rankings unavailable";
  }
}

applySettingsToControls();
bindEvents();
loadRankings();
