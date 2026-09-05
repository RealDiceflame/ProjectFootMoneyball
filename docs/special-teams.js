const DATA_URL = "./data/special_teams.json";
const DRAFTED_KEY = "project-foot-moneyball:drafted:v1";

const columns = [
  { key: "drafted", label: "Drafted", width: 70, kind: "drafted" },
  { key: "overall_rank", label: "Rank", width: 62, kind: "number" },
  { key: "player", label: "Kicker / Defense", width: 220, kind: "text" },
  { key: "team", label: "Team", width: 70, kind: "text" },
  { key: "pos", label: "Pos", width: 60, kind: "text" },
  { key: "position_rank", label: "Pos Rank", width: 82, kind: "text" },
  { key: "adp", label: "ADP", width: 76, kind: "number" },
  { key: "adp_stddev", label: "ADP SD", width: 82, kind: "number" },
  { key: "source_count", label: "Sources", width: 74, kind: "number" },
  { key: "Sleeper", label: "Sleeper", width: 80, kind: "number" },
  { key: "NFL", label: "ESPN", width: 80, kind: "number" },
  { key: "MFL", label: "MFL", width: 78, kind: "number" },
];

const ui = {
  status: document.querySelector("#special-status"),
  summary: document.querySelector("#special-summary"),
  search: document.querySelector("#special-search"),
  positions: document.querySelector("#special-positions"),
  clear: document.querySelector("#special-clear"),
  export: document.querySelector("#special-export"),
  shell: document.querySelector("#special-table-shell"),
  head: document.querySelector("#special-head"),
  body: document.querySelector("#special-body"),
  loading: document.querySelector("#special-loading"),
  empty: document.querySelector("#special-empty"),
};

function loadDrafted() {
  try {
    const values = JSON.parse(localStorage.getItem(DRAFTED_KEY));
    return new Set(Array.isArray(values) ? values : []);
  } catch {
    return new Set();
  }
}

const state = {
  data: null,
  rows: [],
  visible: [],
  drafted: loadDrafted(),
  search: "",
  position: "ALL",
  filters: {},
  sortColumn: "adp",
  sortAscending: true,
};

function playerKey(row) {
  return `${String(row.player).trim().toLocaleLowerCase()}|${String(row.team).trim().toUpperCase()}`;
}

function numeric(value) {
  const number = Number(value);
  return value === null || value === "" || !Number.isFinite(number) ? null : number;
}

function matchesFilter(value, rawQuery, kind) {
  const query = String(rawQuery || "").trim();
  if (!query) return true;
  const text = value === null || value === undefined ? "" : String(value);
  if (kind === "number") {
    const number = numeric(value);
    const comparison = query.match(/^(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?)$/);
    if (comparison && number !== null) {
      const wanted = Number(comparison[2]);
      return { ">": number > wanted, ">=": number >= wanted, "<": number < wanted, "<=": number <= wanted, "=": number === wanted }[comparison[1]];
    }
    const range = query.match(/^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/);
    if (range && number !== null) {
      const [low, high] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
      return number >= low && number <= high;
    }
  }
  return text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function filteredRows() {
  const search = state.search.trim().toLocaleLowerCase();
  return state.rows.filter(row => {
    if (search && ![row.player, row.team, row.pos].some(value => String(value).toLocaleLowerCase().includes(search))) return false;
    if (state.position !== "ALL" && row.pos !== state.position) return false;
    return columns.every(column => {
      const query = state.filters[column.key] || "";
      if (column.key === "drafted") {
        const drafted = state.drafted.has(playerKey(row));
        return !query || (query === "yes" ? drafted : !drafted);
      }
      return matchesFilter(row[column.key], query, column.kind);
    });
  });
}

function sortedRows(rows) {
  const meta = columns.find(column => column.key === state.sortColumn);
  const direction = state.sortAscending ? 1 : -1;
  return [...rows].sort((left, right) => {
    let a = meta.key === "drafted" ? Number(state.drafted.has(playerKey(left))) : left[meta.key];
    let b = meta.key === "drafted" ? Number(state.drafted.has(playerKey(right))) : right[meta.key];
    if (meta.kind === "number" || meta.kind === "drafted") {
      a = numeric(a);
      b = numeric(b);
      if (a === null && b !== null) return 1;
      if (a !== null && b === null) return -1;
      if (a !== b) return (a - b) * direction;
    } else {
      const compared = String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base", numeric: true });
      if (compared) return compared * direction;
    }
    return Number(left.overall_rank) - Number(right.overall_rank);
  });
}

function renderHead() {
  const headings = document.createElement("tr");
  headings.className = "heading-row";
  const filters = document.createElement("tr");
  filters.className = "filter-row";
  columns.forEach(column => {
    const th = document.createElement("th");
    th.style.minWidth = `${column.width}px`;
    const button = document.createElement("button");
    button.className = "sort-button";
    button.type = "button";
    button.dataset.sort = column.key;
    const label = document.createElement("span");
    label.textContent = column.label;
    const indicator = document.createElement("span");
    indicator.className = "sort-indicator";
    button.append(label, indicator);
    th.append(button);
    headings.append(th);

    const filterCell = document.createElement("th");
    if (column.key === "drafted") {
      const select = document.createElement("select");
      select.dataset.filter = column.key;
      select.append(new Option("All", ""), new Option("Open", "no"), new Option("Drafted", "yes"));
      filterCell.append(select);
    } else {
      const input = document.createElement("input");
      input.dataset.filter = column.key;
      input.placeholder = "Filter";
      input.setAttribute("aria-label", `Filter ${column.label}`);
      filterCell.append(input);
    }
    filters.append(filterCell);
  });
  ui.head.replaceChildren(headings, filters);
}

function displayValue(column, value) {
  if (value === null || value === undefined) return "—";
  if (column.key === "source_count") return String(Math.trunc(Number(value)));
  if (column.kind === "number" && column.key !== "overall_rank") return Number(value).toFixed(1);
  if (column.key === "pos" && value === "DST") return "D/ST";
  return String(value);
}

function renderBody() {
  const fragment = document.createDocumentFragment();
  state.visible.forEach(row => {
    const key = playerKey(row);
    const drafted = state.drafted.has(key);
    const tr = document.createElement("tr");
    if (drafted) tr.className = "drafted";
    columns.forEach(column => {
      const td = document.createElement("td");
      if (column.kind === "number") td.className = "numeric";
      if (column.key === "player") td.className = "player";
      if (column.key === "overall_rank") td.className = "rank";
      if (column.key === "drafted") {
        const button = document.createElement("button");
        button.className = "draft-toggle";
        button.type = "button";
        button.dataset.draftKey = encodeURIComponent(key);
        button.setAttribute("aria-pressed", String(drafted));
        button.setAttribute("aria-label", `${drafted ? "Undo drafted" : "Mark drafted"}: ${row.player}`);
        button.textContent = "✓";
        td.append(button);
      } else {
        td.textContent = displayValue(column, row[column.key]);
      }
      tr.append(td);
    });
    fragment.append(tr);
  });
  ui.body.replaceChildren(fragment);
}

function render() {
  state.visible = sortedRows(filteredRows());
  renderBody();
  ui.head.querySelectorAll("[data-sort]").forEach(button => {
    button.querySelector(".sort-indicator").textContent = button.dataset.sort === state.sortColumn
      ? (state.sortAscending ? "▲" : "▼") : "";
  });
  const drafted = state.rows.filter(row => state.drafted.has(playerKey(row))).length;
  ui.summary.textContent = `Showing ${state.visible.length} of ${state.rows.length} entries · ${drafted} drafted · click a heading to sort`;
  ui.empty.classList.toggle("hidden", state.visible.length !== 0);
}

function clearFilters() {
  state.search = "";
  state.position = "ALL";
  state.filters = {};
  ui.search.value = "";
  ui.head.querySelectorAll("[data-filter]").forEach(control => { control.value = ""; });
  ui.positions.querySelectorAll(".position").forEach(button => button.classList.toggle("active", button.dataset.position === "ALL"));
  render();
}

function toggleDrafted(key) {
  if (state.drafted.has(key)) state.drafted.delete(key);
  else state.drafted.add(key);
  try { localStorage.setItem(DRAFTED_KEY, JSON.stringify([...state.drafted].sort())); } catch { /* in-memory still works */ }
  render();
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportRows() {
  const selected = columns.filter(column => column.key !== "drafted");
  const lines = [selected.map(column => csvCell(column.label)).join(",")];
  state.visible.forEach(row => lines.push(selected.map(column => csvCell(row[column.key])).join(",")));
  const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "OutlierBaseline-kickers-defense-market.csv";
  link.click();
  URL.revokeObjectURL(url);
}

async function load() {
  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`K/DST request failed (${response.status})`);
    state.data = await response.json();
    state.rows = state.data.rows.map(values => Object.fromEntries(state.data.columns.map((column, index) => [column, values[index]])));
    const dates = Object.entries(state.data.source_dates || {}).map(([source, date]) => `${source === "NFL" ? "ESPN" : source} ${date}`);
    ui.status.textContent = dates.length ? dates.join(" · ") : "K/DST market loaded";
    renderHead();
    render();
    ui.loading.classList.add("hidden");
    ui.shell.setAttribute("aria-busy", "false");
    ui.export.disabled = false;
  } catch (error) {
    ui.loading.innerHTML = `<strong>Could not load the K/DST market.</strong><span>${error.message}</span>`;
  }
}

ui.search.addEventListener("input", event => { state.search = event.target.value; render(); });
ui.positions.addEventListener("click", event => {
  const button = event.target.closest("[data-position]");
  if (!button) return;
  state.position = button.dataset.position;
  ui.positions.querySelectorAll(".position").forEach(item => item.classList.toggle("active", item === button));
  render();
});
ui.head.addEventListener("input", event => {
  if (!event.target.matches("[data-filter]")) return;
  state.filters[event.target.dataset.filter] = event.target.value;
  render();
});
ui.head.addEventListener("change", event => {
  if (!event.target.matches("[data-filter]")) return;
  state.filters[event.target.dataset.filter] = event.target.value;
  render();
});
ui.head.addEventListener("click", event => {
  const button = event.target.closest("[data-sort]");
  if (!button) return;
  if (state.sortColumn === button.dataset.sort) state.sortAscending = !state.sortAscending;
  else { state.sortColumn = button.dataset.sort; state.sortAscending = true; }
  render();
});
ui.body.addEventListener("click", event => {
  const button = event.target.closest("[data-draft-key]");
  if (button) toggleDrafted(decodeURIComponent(button.dataset.draftKey));
});
ui.clear.addEventListener("click", clearFilters);
ui.export.addEventListener("click", exportRows);

load();
