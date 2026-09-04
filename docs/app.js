const DATA_URL = "./data/rankings.json";
const INTEL_URL = "./data/player_intel.json";
const NEWS_URL = "./data/player_news.json";
const DRAFTED_KEY = "project-foot-moneyball:drafted:v1";
const SETTINGS_KEY = "project-foot-moneyball:settings:v1";

const columns = [
  { key: "drafted", label: "Drafted", width: 62, kind: "drafted", description: "Show available players or players already marked as drafted" },
  { key: "overall_rank", label: "Rank", width: 62, kind: "number", description: "Overall rank for the selected league format; try <25 or 10..30" },
  { key: "player", label: "Player", width: 260, kind: "text", className: "player", description: "Type any part of a player's name; rookie and current-injury labels appear beneath it" },
  { key: "team", label: "Team", width: 96, kind: "category", description: "Choose a current or previous team" },
  { key: "pos", label: "Pos", width: 58, kind: "category", description: "Filter by QB, RB, WR, or TE; separate choices with commas" },
  { key: "position_rank", label: "Pos Rank", width: 78, kind: "positionRank", description: "Position-specific rank, such as QB5 or WR12" },
  { key: "projected_points", label: "Projected", width: 88, kind: "number", description: "Projected 17-game fantasy points under the selected scoring settings" },
  { key: "vorp", label: "VORP", width: 78, kind: "number", description: "Projected points above the position's replacement player" },
  {
    key: "market_value",
    label: "Market +/-",
    width: 92,
    kind: "number",
    description: "Projected points above or below the same-position market expectation at this ADP",
  },
  { key: "adp", label: "ADP", width: 70, kind: "number", description: "Composite average draft position from Yahoo, Sleeper, and NFL/ESPN" },
  { key: "value_vs_adp", label: "ADP Value", width: 78, kind: "number", description: "Composite ADP minus this board's rank; positive means the board ranks the player earlier" },
  { key: "Yahoo", label: "Yahoo", width: 70, kind: "number", description: "Yahoo average draft position" },
  { key: "Sleeper", label: "Sleeper", width: 74, kind: "number", description: "Sleeper average draft position" },
  { key: "NFL", label: "NFL/ESPN", width: 82, kind: "number", description: "NFL/ESPN average draft position" },
  { key: "draft_tag", label: "Draft Tag", width: 88, kind: "category", description: "RISK and NEW TEAM come from current news; otherwise TARGET is +50, VALUE +25 to +49.9, FAIR -19.9 to +24.9, and REACH -20 or worse" },
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
  intelDialog: document.querySelector("#intel-dialog"),
  intelPhoto: document.querySelector("#intel-photo"),
  intelTitle: document.querySelector("#intel-title"),
  intelMeta: document.querySelector("#intel-meta"),
  intelBody: document.querySelector("#intel-body"),
};

const savedDrafted = loadJson(DRAFTED_KEY, []);
const state = {
  data: null,
  intel: { generated_at: null, report_count: 0, reports: {} },
  news: { generated_at: null, player_count: 0, reports: {} },
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
  return arrays.map(values => {
    const row = Object.fromEntries(state.data.columns.map((column, index) => [column, values[index]]));
    row.listed_team = String(row.team || "").toUpperCase();
    const news = state.news.reports?.[playerKey(row)];
    row.current_team = String(news?.current_team || row.listed_team).toUpperCase();
    row.market_draft_tag = row.draft_tag;
    row.draft_tag = effectiveDraftTag(row, news);
    row.injury = news?.injury || null;
    row.is_rookie = row.is_rookie === true || String(row.is_rookie).toLocaleLowerCase() === "true";
    return row;
  });
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
  const safeTag = ["TARGET", "VALUE", "FAIR", "REACH", "RISK", "NEW TEAM"].includes(tag) ? tag : "FAIR";
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
  const name = String(injury?.name || "Injury").trim();
  const status = String(injury?.status || "").trim();
  return status ? `INJ · ${name} · ${status}` : `INJ · ${name}`;
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
        const reportAvailable = Boolean(state.intel.reports?.[key]);
        const playerNews = state.news.reports?.[key];
        const newsAvailable = Boolean(playerNews?.events?.length);
        const button = document.createElement("button");
        button.className = "player-intel-button";
        button.type = "button";
        button.dataset.intelKey = encodeURIComponent(key);
        button.setAttribute("aria-label", `Open player intel for ${row.player}`);
        const name = document.createElement("span");
        name.className = "player-name";
        name.textContent = row.player;
        const hint = document.createElement("span");
        hint.className = reportAvailable || newsAvailable ? "intel-hint available" : "intel-hint";
        hint.textContent = reportAvailable ? "AI report ready" : newsAvailable ? "News ready" : "Player intel";
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
          const description = [
            `Current injury: ${row.injury.name || "availability update"}`,
            row.injury.report_status ? `game status ${row.injury.report_status}` : "",
            row.injury.practice_status ? `practice ${row.injury.practice_status}` : "",
            row.injury.week ? `week ${row.injury.week}` : "",
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
  eyebrow.textContent = "No-key news feed";
  const title = document.createElement("h3");
  title.textContent = "Latest factual updates";
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
  timeline.append(attribution);
  container.append(timeline);
}

function openIntel(key, row) {
  const report = state.intel.reports?.[key];
  const news = state.news.reports?.[key];
  ui.intelPhoto.replaceChildren(createPlayerPhoto(row.player, news?.headshot_url, "large"));
  ui.intelTitle.textContent = row.player;
  const teamLabel = row.current_team !== row.listed_team
    ? `${row.current_team} · previously ${row.listed_team}`
    : row.current_team;
  ui.intelMeta.textContent = `${teamLabel} · ${row.pos} · Overall rank ${row.overall_rank}`;
  const fragment = document.createDocumentFragment();

  if (!report && !news?.events?.length) {
    const empty = document.createElement("div");
    empty.className = "intel-empty";
    const title = document.createElement("strong");
    title.textContent = "This report has not been published yet.";
    const detail = document.createElement("p");
    detail.textContent = "Player reports are researched from current web sources during the private intel update. The rankings still work normally.";
    empty.append(title, detail);
    fragment.append(empty);
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

  appendNewsTimeline(fragment, news);

  ui.intelBody.replaceChildren(fragment);
  ui.intelDialog.showModal();
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
  for (const row of state.visibleRows) {
    lines.push(exportColumns.map(column => csvCell(column.key === "team" ? teamDisplay(row) : row[column.key])).join(","));
  }
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
    const [response, intelResponse, newsResponse] = await Promise.all([
      fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" }),
      fetch(`${INTEL_URL}?v=${Date.now()}`, { cache: "no-store" }).catch(() => null),
      fetch(`${NEWS_URL}?v=${Date.now()}`, { cache: "no-store" }).catch(() => null),
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
    const intelStatus = state.intel.report_count
      ? `${state.intel.report_count} intel reports updated ${formatTimestamp(state.intel.generated_at)}`
      : "intel reports awaiting first update";
    const newsStatus = state.news.player_count
      ? `${state.news.player_count} player news feeds`
      : "news feed awaiting update";
    ui.sourceStatus.textContent = `${data.projection_season} board · ADP ${formatDate(data.adp_updated)} · ${newsStatus} · ${intelStatus}`;
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
