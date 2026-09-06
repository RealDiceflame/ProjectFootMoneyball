import { defaultWeek, filterOddsRows, flattenGames, formatLine, formatPrice } from "./odds-board.mjs";

const DATA_URL = "./data/nfl_odds.json";

const ui = {
  status: document.querySelector("#odds-status"),
  summary: document.querySelector("#odds-summary"),
  week: document.querySelector("#odds-week"),
  provider: document.querySelector("#odds-provider"),
  search: document.querySelector("#odds-search"),
  markets: document.querySelector("#odds-markets"),
  clear: document.querySelector("#odds-clear"),
  body: document.querySelector("#odds-body"),
  loading: document.querySelector("#odds-loading"),
  empty: document.querySelector("#odds-empty"),
  shell: document.querySelector("#odds-table-shell"),
  connection: document.querySelector("#sportsbook-connection"),
};

const state = { payload: null, rows: [], week: null, market: "ALL", provider: "ALL", search: "" };

function formatKickoff(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "TBD";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function providerKind(row) {
  return { sportsbook: "Sportsbook", exchange: "Exchange", reference: "Consensus" }[row.provider_kind] || "Source";
}

function selectionName(row) {
  if (row.selection === row.away) return row.away_name;
  if (row.selection === row.home) return row.home_name;
  return row.selection;
}

function createCell(text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderRows(rows) {
  const fragment = document.createDocumentFragment();
  rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.className = `odds-row source-${row.provider_kind}${row.is_best ? " best-odds" : ""}`;
    tr.append(createCell(formatKickoff(row.kickoff), "odds-kickoff"));

    const matchup = document.createElement("td");
    matchup.className = "odds-matchup";
    const teams = document.createElement("strong");
    teams.textContent = row.matchup;
    const full = document.createElement("span");
    full.textContent = `${row.away_name} at ${row.home_name}`;
    matchup.append(teams, full);
    tr.append(matchup);

    tr.append(createCell(row.market, "odds-market"));
    tr.append(createCell(selectionName(row), "odds-selection"));
    tr.append(createCell(formatLine(row), "numeric odds-number"));

    const price = document.createElement("td");
    price.className = "numeric odds-price";
    const value = document.createElement("strong");
    value.textContent = formatPrice(row);
    price.append(value);
    if (row.is_best) {
      const badge = document.createElement("span");
      badge.className = "best-badge";
      badge.textContent = "Best";
      price.append(badge);
    }
    tr.append(price);

    const provider = document.createElement("td");
    provider.className = "odds-provider";
    const link = document.createElement("a");
    link.href = row.provider_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = row.provider;
    const kind = document.createElement("span");
    kind.textContent = providerKind(row);
    provider.append(link, kind);
    tr.append(provider);
    fragment.append(tr);
  });
  ui.body.replaceChildren(fragment);
}

function currentRows() {
  return filterOddsRows(state.rows, state);
}

function render() {
  const rows = currentRows().sort((left, right) =>
    String(left.kickoff).localeCompare(String(right.kickoff))
    || left.matchup.localeCompare(right.matchup)
    || left.market.localeCompare(right.market)
    || left.selection.localeCompare(right.selection)
    || Number(right.is_best) - Number(left.is_best)
    || left.provider.localeCompare(right.provider)
  );
  renderRows(rows);
  const games = new Set(rows.map(row => row.game_id)).size;
  const providers = new Set(rows.map(row => row.provider_key)).size;
  ui.summary.textContent = `${games} games · ${rows.length} available lines · ${providers} sources`;
  ui.empty.classList.toggle("hidden", rows.length !== 0);
}

function populateControls() {
  ui.week.replaceChildren(...state.payload.weeks.map(week => new Option(`Week ${week}`, String(week))));
  if (state.week !== null) ui.week.value = String(state.week);
  const providers = [...new Map(state.rows.map(row => [row.provider_key, row.provider])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1]));
  ui.provider.replaceChildren(new Option("All sources", "ALL"), ...providers.map(([key, name]) => new Option(name, key)));
}

function clearFilters() {
  state.market = "ALL";
  state.provider = "ALL";
  state.search = "";
  ui.provider.value = "ALL";
  ui.search.value = "";
  ui.markets.querySelectorAll("[data-market]").forEach(button => button.classList.toggle("active", button.dataset.market === "ALL"));
  render();
}

async function load() {
  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Odds request failed (${response.status})`);
    state.payload = await response.json();
    state.rows = flattenGames(state.payload.games);
    state.week = defaultWeek(state.payload.weeks);
    populateControls();
    render();
    const generated = new Date(state.payload.generated_at);
    ui.status.textContent = Number.isNaN(generated.getTime())
      ? "Weekly markets loaded"
      : `Updated ${generated.toLocaleString()}`;
    ui.connection.classList.toggle("connected", state.payload.has_sportsbooks);
    ui.connection.querySelector("strong").textContent = state.payload.has_sportsbooks
      ? "Live sportsbook comparison connected"
      : "Sportsbook comparison awaiting a licensed feed";
    ui.connection.querySelector("span").textContent = state.payload.has_sportsbooks
      ? "Best-line badges compare the licensed sportsbook prices currently available."
      : "The schedule, consensus reference, and public Kalshi contracts are live. Direct sportsbook pages are not scraped.";
    ui.loading.classList.add("hidden");
    ui.shell.setAttribute("aria-busy", "false");
  } catch (error) {
    ui.loading.innerHTML = `<strong>Could not load weekly odds.</strong><span>${error.message}</span>`;
  }
}

ui.week.addEventListener("change", event => { state.week = Number(event.target.value); render(); });
ui.provider.addEventListener("change", event => { state.provider = event.target.value; render(); });
ui.search.addEventListener("input", event => { state.search = event.target.value; render(); });
ui.markets.addEventListener("click", event => {
  const button = event.target.closest("[data-market]");
  if (!button) return;
  state.market = button.dataset.market;
  ui.markets.querySelectorAll("[data-market]").forEach(item => item.classList.toggle("active", item === button));
  render();
});
ui.clear.addEventListener("click", clearFilters);

load();
