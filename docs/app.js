import {
  applyPersonalAdp,
  buildPersonalAdp,
  inspectAdpText,
  recalculateMarketMetrics,
} from "./adp-import.mjs";
import { historyAnalytics, historyRows, historyWindow } from "./player-history.mjs?v=20260909-history10";
import { mergeSpecialTeams, specialTeamRows } from "./live-board.mjs";
import { applyProjectionModel } from "./projection-model.mjs?v=20260909-history10";

const DATA_URL = "./data/rankings.json";
const INTEL_URL = "./data/player_intel.json";
const NEWS_URL = "./data/player_news.json";
const HISTORY_URL = "./data/player_history.json";
const SPECIAL_TEAMS_URL = "./data/special_teams.json";
const DRAFTED_KEY = "project-foot-moneyball:drafted:v1";
const SETTINGS_KEY = "project-foot-moneyball:settings:v1";
const PERSONAL_ADP_KEY = "outlierbaseline:personal-adp:v1";
const MAX_ADP_FILE_BYTES = 5 * 1024 * 1024;

const columns = [
  { key: "drafted", label: "Drafted", width: 62, kind: "drafted", description: "Show available players or players already marked as drafted" },
  { key: "overall_rank", label: "Rank", width: 62, kind: "number", description: "Overall rank for the selected league format; try <25 or 10..30" },
  { key: "player", label: "Player", width: 260, kind: "text", className: "player", description: "Type any part of a player's name; rookie and current-injury labels appear beneath it" },
  { key: "team", label: "Team", width: 96, kind: "category", description: "Choose a current or previous team" },
  { key: "pos", label: "Pos", width: 58, kind: "category", description: "Filter by QB, RB, WR, TE, K, or DST; separate choices with commas" },
  { key: "age", label: "Age", width: 58, kind: "number", description: "Player age on September 1 of the projection season" },
  { key: "position_rank", label: "Pos Rank", width: 78, kind: "positionRank", description: "Position-specific rank, such as QB5 or WR12" },
  { key: "projected_ppg", label: "Proj PPG", width: 82, kind: "number", description: "Age-adjusted fantasy points per game from the OutlierBaseline season model" },
  { key: "projected_points", label: "Season Proj.", width: 94, kind: "number", description: "Projected fantasy points using age-adjusted scoring and expected games played" },
  { key: "vorp", label: "VORP", width: 78, kind: "number", description: "Projected points above the position's replacement player" },
  {
    key: "market_value",
    label: "Market +/-",
    width: 92,
    kind: "number",
    description: "Projected points above or below the same-position market expectation at this ADP",
  },
  { key: "adp", label: "ADP", width: 70, kind: "number", description: "Equal-weight consensus of every available Yahoo, Sleeper, and MFL value for this player" },
  { key: "source_count", label: "Sources", width: 68, kind: "number", description: "Number of ADP sources that have a value for this player" },
  { key: "adp_stddev", label: "ADP SD", width: 76, kind: "number", description: "Standard deviation across available ADP sources; higher means more disagreement" },
  { key: "volatility", label: "Volatility", width: 84, kind: "number", description: "0–100 index combining season-to-season fantasy scoring variation (70%) and relative ADP disagreement (30%)" },
  { key: "value_vs_adp", label: "ADP Value", width: 78, kind: "number", description: "Composite ADP minus this board's rank; positive means the board ranks the player earlier" },
  { key: "Yahoo", label: "Yahoo", width: 70, kind: "number", description: "Yahoo ADP from the last authorized snapshot; its date is shown above the board" },
  { key: "Sleeper", label: "Sleeper", width: 74, kind: "number", description: "Half-PPR ADP pulled directly from Sleeper" },
  { key: "MFL", label: "MFL", width: 68, kind: "number", description: "Recent 12-team PPR redraft ADP from MyFantasyLeague" },
  { key: "draft_tag", label: "Draft Tag", width: 94, kind: "category", description: "RISK and NEW TEAM come from current news; market tags appear when at least one ADP source has a value" },
];

const ui = {
  teams: document.querySelector("#teams"),
  quarterbacks: document.querySelector("#quarterbacks"),
  ppr: document.querySelector("#ppr"),
  tePremium: document.querySelector("#te-premium"),
  kickers: document.querySelector("#kickers"),
  defenses: document.querySelector("#defenses"),
  sourceStatus: document.querySelector("#source-status"),
  boardHeading: document.querySelector("#board-heading"),
  boardSummary: document.querySelector("#board-summary"),
  adpModeTitle: document.querySelector("#adp-mode-title"),
  adpModeDetail: document.querySelector("#adp-mode-detail"),
  importAdp: document.querySelector("#import-adp"),
  resetAdp: document.querySelector("#reset-adp"),
  adpDialog: document.querySelector("#adp-dialog"),
  adpForm: document.querySelector("#adp-form"),
  adpClose: document.querySelector("#adp-close"),
  adpCancel: document.querySelector("#adp-cancel"),
  adpFile: document.querySelector("#adp-file"),
  adpColumn: document.querySelector("#adp-column"),
  adpDate: document.querySelector("#adp-date"),
  adpImportStatus: document.querySelector("#adp-import-status"),
  applyAdp: document.querySelector("#apply-adp"),
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
  intelDialog: document.querySelector("#intel-dialog"),
  intelPhoto: document.querySelector("#intel-photo"),
  intelTitle: document.querySelector("#intel-title"),
  intelMeta: document.querySelector("#intel-meta"),
  intelBody: document.querySelector("#intel-body"),
};

const savedDrafted = loadJson(DRAFTED_KEY, []);
const defaultSettings = { teams: "12", quarterbacks: "2QB", ppr: "Half PPR", tePremium: "+0.5", kickers: "Off", defenses: "Off" };
const state = {
  data: null,
  intel: { generated_at: null, report_count: 0, reports: {} },
  news: { generated_at: null, player_count: 0, reports: {} },
  history: { generated_at: null, player_count: 0, columns: [], players: {} },
  specialTeams: { columns: [], rows: [] },
  settings: { ...defaultSettings, ...loadJson(SETTINGS_KEY, {}) },
  drafted: new Set(Array.isArray(savedDrafted) ? savedDrafted : []),
  search: "",
  position: "ALL",
  filters: {},
  sortColumn: "overall_rank",
  sortAscending: true,
  visibleRows: [],
  personalAdp: loadJson(PERSONAL_ADP_KEY, null),
  personalAdpMatches: 0,
  pendingAdp: null,
  defaultSourceStatus: "",
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

function personalAdpIsActive() {
  return Boolean(state.personalAdp?.entries?.length);
}

function playerKey(row) {
  const listedTeam = row.listed_team || row.team;
  return `${String(row.player).trim().toLocaleLowerCase()}|${String(listedTeam).trim().toUpperCase()}`;
}

function effectiveDraftTag(row, news) {
  if (news?.signal === "risk") return "RISK";
  if (news?.only_team_change) return "NEW TEAM";
  return row.draft_tag;
}

function rowsForCurrentBoard() {
  const arrays = state.data.boards[rankingSlug()];
  if (!arrays) throw new Error(`Rankings are missing for ${rankingSlug()}`);
  let rows = arrays.map(values => {
    const row = Object.fromEntries(state.data.columns.map((column, index) => [column, values[index]]));
    row.listed_team = String(row.team || "").toUpperCase();
    const news = state.news.reports?.[playerKey(row)];
    row.current_team = String(news?.current_team || row.listed_team).toUpperCase();
    row.injury = news?.injury || null;
    row.is_rookie = row.is_rookie === true || String(row.is_rookie).toLocaleLowerCase() === "true";
    return row;
  });
  if (personalAdpIsActive()) {
    const applied = applyPersonalAdp(rows, state.personalAdp);
    rows = recalculateMarketMetrics(applied.rows);
    state.personalAdpMatches = applied.matched;
  } else {
    state.personalAdpMatches = 0;
  }
  const modeled = applyProjectionModel(
    rows,
    state.history,
    state.news,
    state.settings,
    state.data.projection_season,
  ).rows;
  const players = modeled.map(row => {
    const news = state.news.reports?.[playerKey(row)];
    row.market_draft_tag = row.market_draft_tag || row.draft_tag;
    row.draft_tag = effectiveDraftTag(row, news);
    row.volatility = historyAnalytics(historyRows(state.history, row), row, state.settings).volatility_score;
    return row;
  });
  return mergeSpecialTeams(players, specialTeamRows(state.specialTeams, state.settings));
}

function teamDisplay(row) {
  return row.current_team !== row.listed_team
    ? `${row.listed_team} → ${row.current_team}`
    : row.current_team;
}

function selectableTeams() {
  const teams = new Set();
  for (const row of rowsForCurrentBoard()) {
    if (row.listed_team) teams.add(row.listed_team);
    if (row.current_team) teams.add(row.current_team);
  }
  return [...teams].sort();
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
    if (search && ![row.player, row.listed_team, row.current_team, row.pos].some(value => String(value).toLocaleLowerCase().includes(search))) return false;
    if (state.position !== "ALL" && row.pos !== state.position) return false;
    return columns.every(column => {
      const query = state.filters[column.key] || "";
      if (column.key === "drafted") return !query || (query === "yes" ? drafted : !drafted);
      if (column.key === "team") {
        const wanted = query.trim().toUpperCase();
        return !wanted || row.listed_team === wanted || row.current_team === wanted;
      }
      return matchesFilter(row[column.key], query, column.kind);
    });
  });
}

function sortRows(rows) {
  const meta = columns.find(column => column.key === state.sortColumn);
  const direction = state.sortAscending ? 1 : -1;
  return [...rows].sort((left, right) => {
    let a = meta.key === "drafted" ? state.drafted.has(playerKey(left)) : meta.key === "team" ? left.current_team : left[meta.key];
    let b = meta.key === "drafted" ? state.drafted.has(playerKey(right)) : meta.key === "team" ? right.current_team : right[meta.key];
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
  if (["age", "source_count", "volatility"].includes(column.key)) return String(Math.round(Number(value)));
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
    if (column.description) heading.title = column.description;
    const indicator = state.sortColumn === column.key ? (state.sortAscending ? "▲" : "▼") : "";
    heading.innerHTML = `<button class="sort-button" type="button" data-sort="${column.key}"><span>${column.label}</span><span class="sort-indicator">${indicator}</span></button>`;
    headings.append(heading);

    const filterCell = document.createElement("th");
    if (column.key === "drafted") {
      filterCell.innerHTML = `<select data-filter="drafted" aria-label="Filter Drafted"><option value="">All</option><option value="no">Open</option><option value="yes">Drafted</option></select>`;
    } else if (column.key === "team") {
      const select = document.createElement("select");
      select.dataset.filter = "team";
      select.setAttribute("aria-label", "Filter current or previous team");
      select.append(new Option("All teams", ""));
      selectableTeams().forEach(team => select.append(new Option(team, team)));
      filterCell.append(select);
    } else {
      filterCell.innerHTML = `<input data-filter="${column.key}" aria-label="Filter ${column.label}" placeholder="Filter" autocomplete="off">`;
    }
    const filterControl = filterCell.querySelector("[data-filter]");
    if (filterControl && column.description) filterControl.title = column.description;
    filters.append(filterCell);
  }
  ui.tableHead.replaceChildren(headings, filters);
}

function tagElement(tag) {
  const safeTag = ["TARGET", "VALUE", "FAIR", "REACH", "RISK", "NEW TEAM", "MARKET", "NO MARKET"].includes(tag) ? tag : "NO MARKET";
  const span = document.createElement("span");
  span.className = `tag tag-${safeTag.toLowerCase().replace(" ", "-")}`;
  span.textContent = safeTag;
  span.title = {
    "RISK": "Current player news contains a risk signal",
    "NEW TEAM": "Current roster data shows a team change with no other material update",
    "TARGET": "Market +/- is at least +50 points",
    "VALUE": "Market +/- is +25 to +49.9 points",
    "FAIR": "Market +/- is between -19.9 and +24.9 points",
    "REACH": "Market +/- is -20 points or worse",
    "MARKET": "Kicker or D/ST is placed by current market ADP until a projection model is available",
    "NO MARKET": "No ADP source matching these league settings is loaded",
  }[safeTag];
  return span;
}

function statusBadge(text, className, description) {
  const badge = document.createElement("span");
  badge.className = `player-status ${className}`;
  badge.textContent = text;
  if (description) badge.title = description;
  return badge;
}

function injuryText(injury) {
  const names = Array.isArray(injury?.injuries) ? injury.injuries.filter(Boolean) : [];
  const name = names.length ? names.join(" / ") : String(injury?.name || "Injury").trim();
  const status = String(injury?.status || "").trim();
  const label = injury?.label === "STATUS" ? "STATUS" : "INJ";
  return status ? `${label} · ${name} · ${status}` : `${label} · ${name}`;
}

function playerInitials(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || "")
    .join("") || "?";
}

function createPlayerPhoto(name, rawUrl, size = "small") {
  const frame = document.createElement("span");
  frame.className = `player-photo player-photo-${size}`;
  frame.setAttribute("aria-hidden", "true");
  const fallback = document.createElement("span");
  fallback.className = "player-photo-fallback";
  fallback.textContent = playerInitials(name);
  frame.append(fallback);
  const url = safeSourceUrl(rawUrl);
  if (url) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => image.remove());
    frame.append(image);
  }
  return frame;
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
      } else if (column.key === "player") {
        if (row.is_special_teams) {
          const entry = document.createElement("span");
          entry.className = "special-team-entry";
          const labels = document.createElement("span");
          labels.className = "player-labels";
          const name = document.createElement("strong");
          name.className = "player-name";
          name.textContent = row.player;
          const hint = document.createElement("small");
          hint.textContent = "Market ADP · projections coming later";
          labels.append(name, hint);
          entry.append(createPlayerPhoto(row.player, null), labels);
          td.append(entry);
          tr.append(td);
          continue;
        }
        const reportAvailable = Boolean(state.intel.reports?.[key]);
        const playerNews = state.news.reports?.[key];
        const newsAvailable = Boolean(playerNews?.events?.length);
        const historyAvailable = historyRows(state.history, row).length > 0;
        const button = document.createElement("button");
        button.className = "player-intel-button";
        button.type = "button";
        button.dataset.intelKey = encodeURIComponent(key);
        button.setAttribute("aria-label", `Open player profile for ${row.player}`);
        const name = document.createElement("span");
        name.className = "player-name";
        name.textContent = row.player;
        const hint = document.createElement("span");
        hint.className = reportAvailable || newsAvailable || historyAvailable ? "intel-hint available" : "intel-hint";
        hint.textContent = reportAvailable ? "AI report ready" : newsAvailable ? "News ready" : historyAvailable ? "Stats ready" : "Player intel";
        const labels = document.createElement("span");
        labels.className = "player-labels";
        const nameLine = document.createElement("span");
        nameLine.className = "player-name-line";
        nameLine.append(name, hint);
        labels.append(nameLine);
        const statuses = document.createElement("span");
        statuses.className = "player-statuses";
        if (row.is_rookie) {
          statuses.append(statusBadge("ROOKIE", "status-rookie", `${row.player} is in the ${state.data.projection_season} rookie class`));
        }
        if (row.injury) {
          const injuryNames = Array.isArray(row.injury.injuries) && row.injury.injuries.length
            ? row.injury.injuries.join(", ")
            : row.injury.name || "availability update";
          const description = [
            `Current injuries: ${injuryNames}`,
            row.injury.report_status ? `game status ${row.injury.report_status}` : "",
            row.injury.practice_status ? `practice ${row.injury.practice_status}` : "",
            row.injury.week ? `week ${row.injury.week}` : "",
            row.injury.return_date ? `listed return ${row.injury.return_date}` : "",
          ].filter(Boolean).join(" · ");
          statuses.append(statusBadge(
            injuryText(row.injury),
            row.injury.severity === "risk" ? "status-injury-risk" : "status-injury",
            description,
          ));
        }
        if (statuses.children.length) labels.append(statuses);
        button.append(createPlayerPhoto(row.player, playerNews?.headshot_url), labels);
        td.append(button);
      } else if (column.key === "team") {
        td.className = "team-cell";
        if (row.current_team !== row.listed_team) {
          td.title = `Previously ${row.listed_team}; now ${row.current_team}`;
          const previous = document.createElement("span");
          previous.className = "team-previous";
          previous.textContent = row.listed_team;
          const arrow = document.createElement("span");
          arrow.className = "team-arrow";
          arrow.setAttribute("aria-hidden", "true");
          arrow.textContent = "→";
          const current = document.createElement("strong");
          current.className = "team-current";
          current.textContent = row.current_team;
          td.append(previous, arrow, current);
        } else {
          td.textContent = row.current_team;
        }
      } else if (column.key === "market_value") {
        const marketValue = numeric(row.market_value);
        const marketExpected = numeric(row.market_expected_points);
        td.textContent = marketValue === null ? "—" : `${marketValue > 0 ? "+" : ""}${marketValue.toFixed(1)}`;
        if (marketValue !== null) td.classList.add(marketValue > 0 ? "market-positive" : marketValue < 0 ? "market-negative" : "market-neutral");
        if (marketExpected !== null) {
          td.title = `${Number(row.projected_points).toFixed(1)} projected − ${marketExpected.toFixed(1)} market expected`;
        }
      } else {
        td.textContent = formatValue(column, row[column.key]);
        if (row._personalAdp && (column.key === "adp" || column.key === state.personalAdp?.provider)) {
          td.classList.add("personal-adp-value");
          td.title = `${state.personalAdp.column} from ${state.personalAdp.fileName}`;
        }
      }
      tr.append(td);
    }
    fragment.append(tr);
  }
  ui.tableBody.replaceChildren(fragment);
}

function addIntelSection(container, title, value) {
  const section = document.createElement("section");
  section.className = "intel-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  const values = Array.isArray(value) ? value : [value];
  const useful = values.filter(item => String(item || "").trim());
  if (useful.length > 1) {
    const list = document.createElement("ul");
    useful.forEach(item => {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    });
    section.append(list);
  } else {
    const paragraph = document.createElement("p");
    paragraph.textContent = useful[0] || "No material change found.";
    section.append(paragraph);
  }
  container.append(section);
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
  }).format(date);
}

function appendNewsTimeline(container, news) {
  if (!news?.events?.length) return;
  const timeline = document.createElement("section");
  timeline.className = "news-timeline";
  const headingRow = document.createElement("div");
  headingRow.className = "news-heading";
  const heading = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Source-linked player feed";
  const title = document.createElement("h3");
  title.textContent = "Recent articles and factual updates";
  heading.append(eyebrow, title);
  const signal = document.createElement("span");
  const safeSignal = ["stable", "watch", "risk"].includes(news.signal) ? news.signal : "watch";
  signal.className = `news-signal signal-${safeSignal}`;
  signal.textContent = safeSignal;
  headingRow.append(heading, signal);
  timeline.append(headingRow);

  const list = document.createElement("div");
  list.className = "news-list";
  for (const event of news.events) {
    const article = document.createElement("article");
    article.className = `news-event severity-${["info", "watch", "risk", "stable"].includes(event.severity) ? event.severity : "info"}`;
    const meta = document.createElement("div");
    meta.className = "news-meta";
    const category = document.createElement("span");
    category.textContent = event.category || "Update";
    const eventDate = document.createElement("time");
    eventDate.textContent = event.date || "Current";
    meta.append(category, eventDate);
    const eventTitle = document.createElement("h4");
    eventTitle.textContent = event.title || "Player update";
    const detail = document.createElement("p");
    detail.textContent = event.detail || "";
    article.append(meta, eventTitle, detail);
    const href = safeSourceUrl(event.source?.url);
    if (href) {
      const source = document.createElement("a");
      source.href = href;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = event.source?.title || "View source";
      article.append(source);
    }
    list.append(article);
  }
  timeline.append(list);
  const attribution = document.createElement("p");
  attribution.className = "news-attribution";
  attribution.append(document.createTextNode(
    `Source feed updated ${formatTimestamp(state.news.generated_at)}. These are factual data signals, not editorial reporting or guarantees of playing time.`
  ));
  const attributionHref = safeSourceUrl(state.news.attribution_url);
  if (attributionHref) {
    const attributionLink = document.createElement("a");
    attributionLink.href = attributionHref;
    attributionLink.target = "_blank";
    attributionLink.rel = "noopener noreferrer";
    attributionLink.textContent = "nflverse data source";
    attribution.append(document.createTextNode(" Data compiled from the "), attributionLink, document.createTextNode("."));
  }
  const newsHref = safeSourceUrl(state.news.news_attribution_url);
  if (newsHref) {
    const newsLink = document.createElement("a");
    newsLink.href = newsHref;
    newsLink.target = "_blank";
    newsLink.rel = "noopener noreferrer";
    newsLink.textContent = "ESPN NFL News";
    attribution.append(document.createTextNode(" Matched headlines are attributed to and link back to "), newsLink, document.createTextNode("."));
  }
  timeline.append(attribution);
  container.append(timeline);
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function svgNode(name, attributes = {}, text = null) {
  const node = document.createElementNS(SVG_NAMESPACE, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text !== null) node.textContent = text;
  return node;
}

function chartTooltip(node, text) {
  node.append(svgNode("title", {}, text));
  return node;
}

function formatMetric(value, suffix = "") {
  return Number.isFinite(value) ? `${Number(value).toFixed(1)}${suffix}` : "—";
}

function volatilityMetric(label, value, detail, className = "") {
  const card = document.createElement("div");
  card.className = `volatility-metric ${className}`.trim();
  const name = document.createElement("span");
  name.textContent = label;
  const number = document.createElement("strong");
  number.textContent = value;
  const context = document.createElement("small");
  context.textContent = detail;
  card.append(name, number, context);
  return card;
}

function renderVolatilitySummary(analytics, player) {
  const panel = document.createElement("section");
  panel.className = "volatility-panel";
  const heading = document.createElement("div");
  heading.className = "volatility-heading";
  const title = document.createElement("h4");
  title.textContent = "Volatility snapshot";
  const basis = document.createElement("span");
  basis.textContent = analytics.basis.length === 2
    ? "History + market"
    : analytics.basis[0] === "history" ? "History only" : analytics.basis[0] === "market" ? "Market only" : "Insufficient data";
  heading.append(title, basis);

  const metrics = document.createElement("div");
  metrics.className = "volatility-metrics";
  const score = Number.isFinite(analytics.volatility_score) ? `${analytics.volatility_score}` : "—";
  metrics.append(
    volatilityMetric("Volatility index", score, Number.isFinite(analytics.volatility_score) ? `${analytics.volatility_label} · out of 100` : "Not enough data", "primary"),
    volatilityMetric(
      "Player scoring SD",
      formatMetric(analytics.player_stddev, " FPTS/G"),
      analytics.player_cv === null
        ? "Needs at least two NFL seasons"
        : `${formatMetric(analytics.player_cv * 100, "%")} of historical scoring average`,
    ),
    volatilityMetric(
      "Market ADP SD",
      formatMetric(analytics.market_stddev, " picks"),
      analytics.market_cv === null
        ? "Needs at least two ADP sources"
        : `${Number(player.source_count)} sources · ${formatMetric(analytics.market_cv * 100, "%")} of consensus ADP`,
    ),
  );
  const note = document.createElement("p");
  note.textContent = "The index is 70% season-to-season scoring variation and 30% relative ADP disagreement. If one component is unavailable, the available component sets the score.";
  panel.append(heading, metrics, note);
  return panel;
}

function renderProjectionSummary(player) {
  const projectedPpg = numeric(player.projected_ppg);
  const projectedPoints = numeric(player.projected_points);
  if (projectedPpg === null || projectedPoints === null) return null;
  const panel = document.createElement("section");
  panel.className = "projection-summary-panel";
  const heading = document.createElement("div");
  heading.className = "volatility-heading";
  const title = document.createElement("h4");
  title.textContent = "OutlierBaseline season projection";
  const badge = document.createElement("span");
  badge.textContent = player.projection_source === "age_curve" ? "Age Curve v1" : player.is_rookie ? "Rookie market" : "Recent form";
  heading.append(title, badge);

  const metrics = document.createElement("div");
  metrics.className = "projection-summary-metrics";
  const ageAdjustment = numeric(player.age_adjustment_pct);
  const expectedGames = numeric(player.projection_expected_games);
  const projectionRange = numeric(player.projection_low) !== null && numeric(player.projection_high) !== null
    ? `${Number(player.projection_low).toFixed(0)}–${Number(player.projection_high).toFixed(0)}`
    : "—";
  metrics.append(
    volatilityMetric("Projected PPG", projectedPpg.toFixed(1), "Age-adjusted scoring rate", "primary"),
    volatilityMetric("Season points", projectedPoints.toFixed(1), expectedGames === null ? "Full-season estimate" : `${expectedGames.toFixed(1)} expected games`),
    volatilityMetric("Projection range", projectionRange, "Model estimate ± one standard deviation"),
    volatilityMetric("Age", numeric(player.age) === null ? "—" : String(Math.round(player.age)), ageAdjustment === null ? "Age unavailable" : `${ageAdjustment >= 0 ? "+" : ""}${ageAdjustment.toFixed(1)}% position-age adjustment`),
  );
  const footer = document.createElement("div");
  footer.className = "projection-summary-footer";
  const explanation = document.createElement("p");
  explanation.textContent = player.projection_source === "age_curve"
    ? "Recent seasons establish the player's scoring level. Same-position year-over-year results adjust it for age, then expected games convert the rate into a season total."
    : player.is_rookie
      ? "No NFL season history is available, so the current rookie market projection remains the baseline."
      : "Age data is unavailable, so this estimate uses recent scoring form and expected games without an age adjustment.";
  const link = document.createElement("a");
  const query = new URLSearchParams({
    player: player.player,
    pos: player.pos,
    teams: state.settings.teams,
    quarterbacks: state.settings.quarterbacks,
    ppr: state.settings.ppr,
    tePremium: state.settings.tePremium,
  });
  link.href = `projection.html?${query}`;
  link.textContent = "Open in Projection Lab";
  footer.append(explanation, link);
  panel.append(heading, metrics, footer);
  return panel;
}

function renderSeasonScoringChart(analytics, player) {
  const projection = numeric(player.projected_points);
  const data = [...analytics.seasons]
    .sort((left, right) => Number(left.season) - Number(right.season))
    .map(row => ({ label: String(row.season), value: row.fantasy_points, games: row.games, projection: false }));
  if (projection !== null) {
    data.push({
      label: `${state.data.projection_season} proj.`,
      value: projection,
      games: numeric(player.projection_expected_games) ?? 17,
      projection: true,
    });
  }
  const width = 720;
  const height = 245;
  const margin = { top: 24, right: 24, bottom: 42, left: 52 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maximum = Math.max(1, ...data.map(item => Number(item.value) || 0)) * 1.12;
  const svg = svgNode("svg", {
    class: "history-chart",
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${player.player} fantasy points by season in ${state.settings.ppr}${player.pos === "TE" && state.settings.tePremium === "+0.5" ? " with tight end premium" : ""}`,
  });
  [0, 0.5, 1].forEach(ratio => {
    const y = margin.top + plotHeight - (ratio * plotHeight);
    svg.append(
      svgNode("line", { class: "chart-grid-line", x1: margin.left, x2: width - margin.right, y1: y, y2: y }),
      svgNode("text", { class: "chart-axis-label", x: margin.left - 9, y: y + 4, "text-anchor": "end" }, String(Math.round(maximum * ratio))),
    );
  });
  const step = plotWidth / Math.max(1, data.length);
  const barWidth = Math.min(68, step * 0.58);
  data.forEach((item, index) => {
    const value = Number(item.value) || 0;
    const x = margin.left + (index * step) + ((step - barWidth) / 2);
    const y = margin.top + plotHeight - ((value / maximum) * plotHeight);
    const bar = chartTooltip(svgNode("rect", {
      class: `history-bar${item.projection ? " projection" : ""}`,
      x, y, width: barWidth, height: Math.max(1, margin.top + plotHeight - y), rx: 6,
    }), item.projection
      ? `${item.label}: ${value.toFixed(1)} projected fantasy points in ${Number(item.games).toFixed(1)} expected games`
      : `${item.label}: ${value.toFixed(1)} fantasy points in ${item.games} games`);
    svg.append(
      bar,
      svgNode("text", { class: "chart-value-label", x: x + (barWidth / 2), y: Math.max(14, y - 7), "text-anchor": "middle" }, value.toFixed(1)),
      svgNode("text", { class: `chart-season-label${item.projection ? " projection" : ""}`, x: x + (barWidth / 2), y: height - 15, "text-anchor": "middle" }, item.label),
    );
  });
  const shell = document.createElement("div");
  shell.className = "history-chart-shell";
  shell.append(svg);
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = "Actual regular-season scoring by year, plus the age-adjusted season projection using expected games.";
  figure.append(shell, caption);
  return figure;
}

function renderExpectedRangeChart(analytics, player) {
  const projection = numeric(player.projected_points);
  const modeledLow = numeric(player.projection_low);
  const modeledHigh = numeric(player.projection_high);
  const center = projection ?? analytics.expected_points;
  const expectedLow = modeledLow ?? analytics.expected_low;
  const expectedHigh = modeledHigh ?? analytics.expected_high;
  if (center === null || expectedLow === null || expectedHigh === null) return null;
  const seasonPoints = analytics.seasons.map(row => ({ season: row.season, value: row.fantasy_points })).filter(item => Number.isFinite(item.value));
  const width = 720;
  const height = 155;
  const margin = { left: 52, right: 26 };
  const maximum = Math.max(1, expectedHigh, center, ...seasonPoints.map(item => item.value)) * 1.1;
  const start = margin.left;
  const end = width - margin.right;
  const scale = value => start + ((Math.max(0, value) / maximum) * (end - start));
  const baseline = 80;
  const svg = svgNode("svg", {
    class: "history-chart range-chart",
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${player.player} expected season scoring range from ${expectedLow.toFixed(1)} to ${expectedHigh.toFixed(1)} points, centered at ${center.toFixed(1)}`,
  });
  svg.append(
    svgNode("line", { class: "range-axis", x1: start, x2: end, y1: baseline, y2: baseline }),
    svgNode("rect", { class: "range-band", x: scale(expectedLow), y: baseline - 18, width: Math.max(2, scale(expectedHigh) - scale(expectedLow)), height: 36, rx: 8 }),
    svgNode("line", { class: "range-mean", x1: scale(center), x2: scale(center), y1: baseline - 29, y2: baseline + 29 }),
  );
  seasonPoints.forEach((item, index) => {
    const point = chartTooltip(svgNode("circle", {
      class: "range-season-point",
      cx: scale(item.value), cy: baseline + (((index % 3) - 1) * 11), r: 5,
    }), `${item.season}: ${item.value.toFixed(1)} actual fantasy points`);
    svg.append(point);
  });
  if (projection !== null) {
    const projectionLine = chartTooltip(svgNode("line", {
      class: "range-projection", x1: scale(projection), x2: scale(projection), y1: baseline - 38, y2: baseline + 38,
    }), `${state.data.projection_season} projection: ${projection.toFixed(1)} points`);
    svg.append(projectionLine, svgNode("text", { class: "range-projection-label", x: scale(projection), y: 25, "text-anchor": "middle" }, "Projection"));
  }
  [
    [expectedLow, `Low ${expectedLow.toFixed(1)}`],
    [center, `Projection ${center.toFixed(1)}`],
    [expectedHigh, `High ${expectedHigh.toFixed(1)}`],
  ].forEach(([value, label]) => svg.append(svgNode("text", { class: "range-label", x: scale(value), y: 132, "text-anchor": "middle" }, label)));
  const shell = document.createElement("div");
  shell.className = "history-chart-shell";
  shell.append(svg);
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = "Each dot is an actual season total. The shaded range is the model's season projection ± one standard deviation.";
  figure.append(shell, caption);
  return figure;
}

function appendPlayerHistory(container, player) {
  const analytics = historyAnalytics(historyRows(state.history, player), player, state.settings);
  const rows = analytics.seasons;
  const section = document.createElement("section");
  section.className = "history-section";

  const headingRow = document.createElement("div");
  headingRow.className = "history-heading";
  const heading = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Season history";
  const title = document.createElement("h3");
  title.textContent = "Year-by-year performance";
  heading.append(eyebrow, title);
  const settings = document.createElement("span");
  settings.className = "history-scoring";
  const premium = player.pos === "TE" && state.settings.tePremium === "+0.5" ? " + TE premium" : "";
  const historyCoverage = historyWindow(state.history);
  settings.textContent = `${state.settings.ppr}${premium} · ${historyCoverage.range}`;
  headingRow.append(heading, settings);
  section.append(headingRow);
  const projectionSummary = renderProjectionSummary(player);
  if (projectionSummary) section.append(projectionSummary);
  section.append(renderVolatilitySummary(analytics, player));

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = player.is_rookie
      ? "No NFL regular-season history yet. Rookie projections remain on the draft board."
      : `No matching regular-season history was found in the ${historyWindow(state.history).range} data window.`;
    section.append(empty);
    container.append(section);
    return;
  }

  const charts = document.createElement("div");
  charts.className = "history-charts";
  charts.append(renderSeasonScoringChart(analytics, player));
  const expectedRange = renderExpectedRangeChart(analytics, player);
  if (expectedRange) charts.append(expectedRange);
  section.append(charts);

  const columns = player.pos === "QB"
    ? [
        ["season", "Season"], ["team", "Team"], ["games", "GP"],
        ["completions", "Cmp"], ["attempts", "Att"], ["passing_yards", "Pass Yds"],
        ["passing_tds", "Pass TD"], ["passing_interceptions", "INT"],
        ["rushing_yards", "Rush Yds"], ["rushing_tds", "Rush TD"],
        ["fantasy_points", "FPTS"], ["fantasy_points_per_game", "FPTS/G"],
      ]
    : [
        ["season", "Season"], ["team", "Team"], ["games", "GP"],
        ["carries", "Rush Att"], ["rushing_yards", "Rush Yds"], ["rushing_tds", "Rush TD"],
        ["targets", "Tgt"], ["receptions", "Rec"], ["receiving_yards", "Rec Yds"],
        ["receiving_tds", "Rec TD"], ["fantasy_points", "FPTS"],
        ["fantasy_points_per_game", "FPTS/G"],
      ];
  const wrapper = document.createElement("div");
  wrapper.className = "history-table-shell";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headingCells = document.createElement("tr");
  columns.forEach(([, label]) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headingCells.append(cell);
  });
  head.append(headingCells);
  const body = document.createElement("tbody");
  rows.forEach(row => {
    const tr = document.createElement("tr");
    columns.forEach(([key]) => {
      const cell = document.createElement("td");
      const value = row[key];
      cell.textContent = value === null || value === undefined
        ? "—"
        : ["fantasy_points", "fantasy_points_per_game"].includes(key)
          ? Number(value).toFixed(1)
          : String(value);
      tr.append(cell);
    });
    body.append(tr);
  });
  table.append(head, body);
  wrapper.append(table);
  section.append(wrapper);

  const note = document.createElement("p");
  note.className = "history-note";
  note.append(document.createTextNode(
    "Regular-season totals. Fantasy points recalculate with the league settings selected above. Data: "
  ));
  const href = safeSourceUrl(state.history.attribution_url);
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "nflverse";
    note.append(link, document.createTextNode("."));
  } else {
    note.append(document.createTextNode("nflverse."));
  }
  section.append(note);
  container.append(section);
}

function openIntel(key, row) {
  const report = state.intel.reports?.[key];
  const news = state.news.reports?.[key];
  ui.intelPhoto.replaceChildren(createPlayerPhoto(row.player, news?.headshot_url, "large"));
  ui.intelTitle.textContent = row.player;
  const teamLabel = row.current_team !== row.listed_team
    ? `${row.current_team} · previously ${row.listed_team}`
    : row.current_team;
  const ageLabel = numeric(row.age) === null ? "" : ` · Age ${Math.round(row.age)}`;
  ui.intelMeta.textContent = `${teamLabel} · ${row.pos}${ageLabel} · Overall rank ${row.overall_rank}`;
  const fragment = document.createDocumentFragment();

  if (!report && !news?.events?.length) {
    const notice = document.createElement("div");
    notice.className = "intel-feed-notice";
    const badge = document.createElement("span");
    badge.className = "intel-badge neutral";
    badge.textContent = "History ready";
    const message = document.createElement("p");
    message.textContent = "A current report has not been published yet. Historical regular-season performance appears below.";
    notice.append(badge, message);
    fragment.append(notice);
  } else if (!report) {
    const notice = document.createElement("div");
    notice.className = "intel-feed-notice";
    const badge = document.createElement("span");
    badge.className = "intel-badge neutral";
    badge.textContent = "Source feed active";
    const message = document.createElement("p");
    message.textContent = "The factual timeline is available now. An AI takeaway will appear here after the private AI updater is connected.";
    notice.append(badge, message);
    fragment.append(notice);
  } else {
    const badges = document.createElement("div");
    badges.className = "intel-badges";
    const risk = document.createElement("span");
    risk.className = `intel-badge risk-${report.risk_level || "unknown"}`;
    risk.textContent = `${report.risk_level || "unknown"} risk`;
    const job = document.createElement("span");
    job.className = "intel-badge neutral";
    job.textContent = `Job: ${String(report.job_status || "uncertain").replaceAll("_", " ")}`;
    const direction = document.createElement("span");
    direction.className = `intel-badge value-${report.value_direction || "neutral"}`;
    direction.textContent = `Value: ${report.value_direction || "neutral"}`;
    badges.append(risk, job, direction);

    const headline = document.createElement("h3");
    headline.className = "intel-headline";
    headline.textContent = report.headline || "Current player outlook";
    const summary = document.createElement("p");
    summary.className = "intel-summary";
    summary.textContent = report.summary || "No summary was provided.";
    fragment.append(badges, headline, summary);

    const grid = document.createElement("div");
    grid.className = "intel-grid";
    addIntelSection(grid, "Role and job status", report.role_change);
    addIntelSection(grid, "Who came in", report.arrivals);
    addIntelSection(grid, "Who left", report.departures);
    addIntelSection(grid, "Injuries and availability", report.injuries);
    addIntelSection(grid, "Recent news", report.recent_news);
    addIntelSection(grid, "Fantasy value impact", report.fantasy_impact);
    fragment.append(grid);

    const sources = document.createElement("section");
    sources.className = "intel-sources";
    const sourceHeading = document.createElement("h3");
    sourceHeading.textContent = "Sources";
    sources.append(sourceHeading);
    const sourceList = document.createElement("ul");
    for (const source of report.sources || []) {
      const href = safeSourceUrl(source.url);
      if (!href) continue;
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.title || href;
      li.append(link);
      sourceList.append(li);
    }
    if (sourceList.children.length) sources.append(sourceList);
    else {
      const unavailable = document.createElement("p");
      unavailable.textContent = "No source links were returned. Treat this report as low confidence.";
      sources.append(unavailable);
    }
    fragment.append(sources);

    const note = document.createElement("p");
    note.className = "intel-note";
    note.textContent = `Updated ${formatDate(report.updated_at)} · ${report.confidence || "low"} confidence · AI summaries can miss context, so check the linked reporting before drafting.`;
    fragment.append(note);
  }

  appendPlayerHistory(fragment, row);
  appendNewsTimeline(fragment, news);

  ui.intelBody.replaceChildren(fragment);
  ui.intelDialog.showModal();
}

function formatDate(value) {
  if (!value) return "date unavailable";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function localIsoDate() {
  const now = new Date();
  const local = new Date(now.valueOf() - (now.getTimezoneOffset() * 60_000));
  return local.toISOString().slice(0, 10);
}

function setImportStatus(message, tone = "") {
  ui.adpImportStatus.textContent = message;
  ui.adpImportStatus.classList.toggle("error", tone === "error");
  ui.adpImportStatus.classList.toggle("success", tone === "success");
}

function resetImportForm() {
  state.pendingAdp = null;
  ui.adpForm.reset();
  ui.adpDate.value = localIsoDate();
  ui.adpColumn.replaceChildren(new Option("Choose a file first", ""));
  ui.adpColumn.disabled = true;
  ui.applyAdp.disabled = true;
  setImportStatus("This snapshot will be used across league settings. Players missing from the file keep the default market values.");
}

function openAdpImporter() {
  resetImportForm();
  ui.adpDialog.showModal();
}

async function readAdpFile(file) {
  if (!file) return;
  if (file.size > MAX_ADP_FILE_BYTES) {
    setImportStatus("That file is larger than 5 MB. Choose the smaller ADP export instead.", "error");
    return;
  }
  try {
    const parsed = inspectAdpText(await file.text());
    state.pendingAdp = { parsed, fileName: file.name };
    ui.adpColumn.replaceChildren();
    parsed.candidates.forEach(candidate => {
      ui.adpColumn.append(new Option(`${candidate.header} · ${candidate.numericCount} values`, candidate.header));
    });
    ui.adpColumn.value = parsed.preferredColumn;
    ui.adpColumn.disabled = false;
    ui.applyAdp.disabled = false;
    setImportStatus(`Found ${parsed.rows.length} player rows. ${parsed.preferredColumn} is selected; you can choose another column.`, "success");
  } catch (error) {
    state.pendingAdp = null;
    ui.adpColumn.replaceChildren(new Option("No usable columns found", ""));
    ui.adpColumn.disabled = true;
    ui.applyAdp.disabled = true;
    setImportStatus(error.message, "error");
  }
}

function applyAdpImport(event) {
  event.preventDefault();
  if (!state.pendingAdp || !ui.adpColumn.value) return;
  try {
    const snapshot = buildPersonalAdp(state.pendingAdp.parsed, ui.adpColumn.value, {
      fileName: state.pendingAdp.fileName,
      snapshotDate: ui.adpDate.value || localIsoDate(),
    });
    const previous = state.personalAdp;
    state.personalAdp = snapshot;
    rowsForCurrentBoard();
    if (!state.personalAdpMatches) {
      state.personalAdp = previous;
      throw new Error("No players in this file matched the current board. Include Position when names could be ambiguous.");
    }
    saveJson(PERSONAL_ADP_KEY, snapshot);
    ui.adpDialog.close();
    render();
  } catch (error) {
    setImportStatus(error.message, "error");
  }
}

function resetPersonalAdp() {
  state.personalAdp = null;
  state.personalAdpMatches = 0;
  try {
    localStorage.removeItem(PERSONAL_ADP_KEY);
  } catch {
    // The in-memory reset still works when private browsing blocks storage.
  }
  render();
}

function updateAdpMode() {
  if (personalAdpIsActive()) {
    const provider = state.personalAdp.provider ? ` (${state.personalAdp.provider})` : "";
    ui.adpModeTitle.textContent = `${state.personalAdp.column}${provider}`;
    ui.adpModeDetail.textContent = `${state.personalAdpMatches} players matched · ${formatDate(state.personalAdp.snapshotDate)} · used across league settings · private to this device`;
    ui.importAdp.textContent = "Replace my ADP";
    ui.resetAdp.classList.remove("hidden");
    ui.sourceStatus.textContent = `Personal ${state.personalAdp.column} snapshot · ${state.defaultSourceStatus}`;
  } else {
    ui.adpModeTitle.textContent = "Available-source consensus";
    ui.adpModeDetail.textContent = "Yahoo + Sleeper + MFL when that player has a value; source scoring formats may differ";
    ui.importAdp.textContent = "Import my ADP";
    ui.resetAdp.classList.add("hidden");
    ui.sourceStatus.textContent = state.defaultSourceStatus;
  }
}

function formatAdpStatus(data) {
  const dates = data.adp_sources || {};
  const current = data.adp_updated;
  if (!Object.keys(dates).length) return `ADP ${formatDate(current)}`;
  const label = key => ({ MFL: "MyFantasyLeague" })[key] || key;
  const fresh = Object.entries(dates).filter(([, date]) => date === current).map(([key]) => label(key));
  const older = Object.entries(dates).filter(([, date]) => date !== current);
  const liveText = fresh.length ? `${fresh.join(" + ")} direct` : "direct feeds";
  const olderText = older.length
    ? `; ${older.map(([key, date]) => `${label(key)} ${formatDate(date)}`).join(", ")}`
    : "";
  return `ADP ${formatDate(current)} (${liveText}${olderText})`;
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
  const importText = personalAdpIsActive() ? ` · ${state.personalAdpMatches} personal ADP matches` : "";
  ui.boardSummary.textContent = `Age Curve v1 · showing ${state.visibleRows.length} of ${allRows.length} entries · ${draftedCount} drafted${importText} · click any heading to sort`;
  updateAdpMode();
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
  ui.kickers.value = state.settings.kickers;
  ui.defenses.value = state.settings.defenses;
}

function updateSettings() {
  state.settings = { teams: ui.teams.value, quarterbacks: ui.quarterbacks.value, ppr: ui.ppr.value, tePremium: ui.tePremium.value, kickers: ui.kickers.value, defenses: ui.defenses.value };
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
  for (const row of state.visibleRows) {
    lines.push(exportColumns.map(column => csvCell(column.key === "team" ? teamDisplay(row) : row[column.key])).join(","));
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `OutlierBaseline-${rankingSlug()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  [ui.teams, ui.quarterbacks, ui.ppr, ui.tePremium, ui.kickers, ui.defenses].forEach(control => control.addEventListener("change", updateSettings));
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
    const intelButton = event.target.closest("[data-intel-key]");
    if (intelButton) {
      const key = decodeURIComponent(intelButton.dataset.intelKey);
      const row = rowsForCurrentBoard().find(item => playerKey(item) === key);
      if (row) openIntel(key, row);
      return;
    }
    const button = event.target.closest("[data-draft-key]");
    if (button) toggleDrafted(decodeURIComponent(button.dataset.draftKey));
  });
  ui.clearFilters.addEventListener("click", clearFilters);
  ui.emptyClear.addEventListener("click", clearFilters);
  ui.exportBoard.addEventListener("click", exportVisibleBoard);
  ui.importAdp.addEventListener("click", openAdpImporter);
  ui.resetAdp.addEventListener("click", resetPersonalAdp);
  ui.adpFile.addEventListener("change", event => readAdpFile(event.target.files?.[0]));
  ui.adpForm.addEventListener("submit", applyAdpImport);
  ui.adpClose.addEventListener("click", () => ui.adpDialog.close());
  ui.adpCancel.addEventListener("click", () => ui.adpDialog.close());
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
    const [response, intelResponse, newsResponse, historyResponse, specialTeamsResponse] = await Promise.all([
      fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" }),
      fetch(`${INTEL_URL}?v=${Date.now()}`, { cache: "no-store" }).catch(() => null),
      fetch(`${NEWS_URL}?v=${Date.now()}`, { cache: "no-store" }).catch(() => null),
      fetch(`${HISTORY_URL}?v=${Date.now()}`, { cache: "no-store" }).catch(() => null),
      fetch(`${SPECIAL_TEAMS_URL}?v=${Date.now()}`, { cache: "no-store" }).catch(() => null),
    ]);
    if (!response.ok) throw new Error(`Rankings request failed (${response.status})`);
    const data = await response.json();
    if (!data.boards || !data.columns) throw new Error("The rankings file is incomplete");
    state.data = data;
    if (intelResponse?.ok) {
      const intel = await intelResponse.json();
      if (intel.reports) state.intel = intel;
    }
    if (newsResponse?.ok) {
      const news = await newsResponse.json();
      if (news.reports) state.news = news;
    }
    if (historyResponse?.ok) {
      const history = await historyResponse.json();
      if (history.players && history.columns) state.history = history;
    }
    if (specialTeamsResponse?.ok) {
      const specialTeams = await specialTeamsResponse.json();
      if (specialTeams.rows && specialTeams.columns) state.specialTeams = specialTeams;
    }
    const intelStatus = state.intel.report_count
      ? `${state.intel.report_count} intel reports updated ${formatTimestamp(state.intel.generated_at)}`
      : "intel reports awaiting first update";
    const newsStatus = state.news.player_count
      ? `${state.news.player_count} player news feeds`
      : "news feed awaiting update";
    const historyStatus = state.history.player_count
      ? `${historyWindow(state.history).label} · ${state.history.player_count} player stat histories`
      : "stat history awaiting update";
    state.defaultSourceStatus = `${data.projection_season} Age Curve v1 · ${formatAdpStatus(data)} · ${newsStatus} · ${historyStatus} · ${intelStatus}`;
    ui.sourceStatus.textContent = state.defaultSourceStatus;
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
