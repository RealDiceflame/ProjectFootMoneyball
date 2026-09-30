const menus = [
  ["Stats", [[null, [["Game results", "stats.html"], ["League leaders", "stats.html?view=leaders"]]]]],
  ["Fantasy", [[null, [["Player rankings", "rankings.html"], ["Kickers & D/ST", "special-teams.html"], ["Player values", "values.html"]]]]],
  ["Labs", [
    ["Projection Lab", [["Player age & scoring", "projection.html"], ["Draft capital map", "projection.html#round-map-heading"]]],
    ["Simulation Lab", [["Head-to-head matchup", "survivor.html#matchup-heading"], ["Team game forecasts", "league.html#team-games-heading"], ["League, playoffs & Super Bowl", "league.html"], ["Survivor planner", "survivor.html#rules-heading"]]],
  ]],
  ["Betting", [[null, [["Weekly odds", "odds.html"]]]]],
];
const nav = document.querySelector(".topnav"), page = location.pathname.split("/").pop() || "index.html";
const mainContent = document.querySelector("main");
if (mainContent && !document.querySelector(".home-skip, .site-skip")) {
  if (!mainContent.id) mainContent.id = "main-content";
  mainContent.tabIndex = -1;
  const skip = document.createElement("a");
  skip.className = "site-skip";
  skip.href = `#${mainContent.id}`;
  skip.textContent = "Skip to content";
  document.body.prepend(skip);
}
if (nav) {
  nav.classList.add("lab-navigation");
  const hover = matchMedia("(any-hover: hover) and (any-pointer: fine)");
  const mobile = matchMedia("(max-width: 1024px)");
  const menuButton = document.createElement("button"), panel = document.createElement("div");
  menuButton.type = "button"; menuButton.className = "site-nav-toggle";
  menuButton.setAttribute("aria-controls", "site-nav-links");
  panel.id = "site-nav-links"; panel.className = "site-nav-links";
  let keyboardNavigation = false;
  const setMobileOpen = open => {
    nav.classList.toggle("mobile-menu-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.textContent = open ? "Close menu" : "Menu";
  };
  setMobileOpen(false);
  const closeTimers = new Map();
  const cancelClose = group => { clearTimeout(closeTimers.get(group)); closeTimers.delete(group); };
  const close = group => { cancelClose(group); group.open = false; };
  const hasKeyboardFocus = group => group.contains(document.activeElement) && document.activeElement.matches(":focus-visible");
  // Native details keep click, tap, Enter and Space working without a custom menu role.
  const groups = menus.map(([name, sections], menuIndex) => {
    const details = document.createElement("details"), summary = document.createElement("summary"), list = document.createElement("div");
    summary.textContent = name; list.className = "lab-nav-menu";
    for (const [sectionName, links] of sections) {
      const section = document.createElement("div"); section.className = "lab-nav-section";
      if (sectionName) {
        const heading = document.createElement("h2");
        heading.id = `nav-${menuIndex}-${list.children.length}`; heading.textContent = sectionName;
        section.setAttribute("role", "group"); section.setAttribute("aria-labelledby", heading.id); section.append(heading);
      }
      for (const [label, url] of links) {
        const link = document.createElement("a"); link.textContent = label; link.href = url;
        const target = new URL(url, location.href);
        if ((target.pathname.split("/").pop() || "index.html") === page) {
          details.classList.add("current-lab");
          if (!url.includes("#") && (page !== "stats.html" || target.searchParams.get("view") === new URLSearchParams(location.search).get("view"))) link.setAttribute("aria-current", "page");
        }
        section.append(link);
      }
      list.append(section);
    }
    details.append(summary, list);
    const open = () => { groups.forEach(other => { if (other !== details) close(other); }); cancelClose(details); details.open = true; };
    details.addEventListener("pointerenter", event => {
      if (mobile.matches || !hover.matches || event.pointerType !== "mouse") return;
      // A mouse passing over another tab must not hide a keyboard-focused link.
      if (groups.some(other => other !== details && hasKeyboardFocus(other))) return;
      open();
    });
    details.addEventListener("pointerleave", event => {
      if (mobile.matches || event.pointerType !== "mouse") return;
      cancelClose(details);
      closeTimers.set(details, setTimeout(() => {
        if (!hasKeyboardFocus(details)) close(details);
      }, 220));
    });
    details.addEventListener("focusin", () => cancelClose(details));
    details.addEventListener("toggle", () => { if (details.open) groups.forEach(other => { if (other !== details) close(other); }); });
    return details;
  });
  const home = document.createElement("a");
  home.href = "./"; home.textContent = "Home"; home.className = "home-nav-link";
  if (page === "index.html") home.setAttribute("aria-current", "page");
  panel.append(home, ...groups);
  nav.replaceChildren(menuButton, panel);
  const closeAll = () => { groups.forEach(close); setMobileOpen(false); };
  menuButton.addEventListener("click", () => {
    const open = menuButton.getAttribute("aria-expanded") !== "true";
    groups.forEach(close); setMobileOpen(open);
  });
  // Touch browsers can blur a summary before activating the tapped link. Only
  // keyboard focus changes dismiss a group; pointer interactions finish on click.
  let outsideTap = null;
  document.addEventListener("pointerdown", event => {
    keyboardNavigation = false;
    outsideTap = event.pointerType === "touch" && !nav.contains(event.target)
      ? {id: event.pointerId, x: event.clientX, y: event.clientY} : null;
  }, true);
  document.addEventListener("pointercancel", () => { outsideTap = null; }, true);
  document.addEventListener("pointerup", event => {
    const start = outsideTap; outsideTap = null;
    // Safari may not send click for plain text. Dismiss after a completed tap,
    // not during a scroll or before an outside link/control gets its own click.
    if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
    if (!nav.contains(event.target) && !event.target.closest("a, button, input, select, textarea, summary, label, [tabindex], [role='button'], [role='link'], [contenteditable]")) closeAll();
  }, true);
  document.addEventListener("keydown", () => { keyboardNavigation = true; }, true);
  document.addEventListener("focusin", event => {
    if (!keyboardNavigation) return;
    groups.forEach(group => { if (!group.contains(event.target)) close(group); });
    if (!nav.contains(event.target)) setMobileOpen(false);
  });
  document.addEventListener("click", event => {
    if (!nav.contains(event.target)) closeAll();
    else if (event.target.closest("a") && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) closeAll();
  });
  nav.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const active = groups.find(group => group.open);
    if (active) {
      event.preventDefault(); close(active); active.querySelector("summary").focus();
    } else if (mobile.matches && menuButton.getAttribute("aria-expanded") === "true") {
      event.preventDefault(); closeAll(); menuButton.focus();
    }
  });
  mobile.addEventListener("change", () => {
    const focused = document.activeElement;
    closeAll();
    // Do not leave keyboard focus inside a now-hidden panel or on a hidden button.
    if (mobile.matches && panel.contains(focused)) menuButton.focus();
    else if (!mobile.matches && (focused === menuButton || panel.contains(focused))) home.focus();
  });
}

function refreshDate(value) {
  if (!value) return "unknown";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? date.toLocaleDateString() : date.toLocaleString();
}

function sourceHealthText(source = {}) {
  const labels = {
    success: "check completed", manual: "manual import", historical: "historical archive",
    not_configured: "not configured", not_needed: "not needed for this run",
    no_upcoming_markets: "no upcoming markets", fallback: "backup feed in use",
    cached: "saved data retained after a failed refresh", failed: "refresh failed",
    partial_failure: "some sources need attention", stale: "older data retained",
    behind: "latest report is behind the expected week", unavailable: "unavailable",
    unknown: "freshness unknown", saved: "saved snapshot reused",
  };
  let text = labels[source.status] || "freshness unknown";
  if (source.actual_period === "ALL") text = source.status === "cached"
    ? "saved season-aggregate ADP retained; recent drafts unavailable"
    : "season-aggregate ADP; recent drafts unavailable";
  else if (source.reason_code === "no_recent_drafts") text = source.status === "cached"
    ? "no recent qualifying drafts; keeping the previous ADP snapshot"
    : "no recent qualifying drafts; no ADP snapshot available";
  if (source.status === "manual") text += "; updated only when a snapshot is imported";
  else if (source.status === "historical") text += "; completed-season data, no live update expected";
  else if (source.status === "not_configured") text += "; no provider request was made";
  else if (source.status === "no_upcoming_markets") text += "; request succeeded with no matching markets";
  else if (source.status === "fallback" && source.actual_period !== "ALL") text += source.selected_provider ? `; ${source.selected_provider}` : "; primary feed was not used";
  if (source.execution_status === "success" && !["success", "historical"].includes(source.status)) text += "; refresh job completed";
  if (source.execution_status === "failed") text += "; refresh job failed";
  if (source.data_updated_at) text += `; ${source.timestamp_kind === "snapshot" || source.status === "manual" ? "snapshot captured" : source.timestamp_kind === "mixed" ? "latest available data timestamp" : "source data dated"} ${refreshDate(source.data_updated_at)}`;
  if (source.last_success && !["manual", "historical", "not_needed", "not_configured"].includes(source.status)) text += `; last successful check ${refreshDate(source.last_success)}`;
  if (source.expected_week != null) text += `; expected ${source.season ? `${source.season} ` : ""}week ${source.expected_week}${source.latest_report_week != null ? `, latest report ${source.latest_report_season ? `${source.latest_report_season} ` : ""}week ${source.latest_report_week}` : ", no report week available"}`;
  if (source.pending_count > 0) text += `; ${source.pending_count} kickoff forecasts not yet published`;
  if (source.failed_count > 0) text += `; ${source.failed_count} forecast requests failed`;
  if (source.retained_count > 0) text += `; ${source.retained_count} saved kickoff forecasts retained`;
  return `${text}.`;
}

function sourceLabel(name) {
  return ({rankings: "Player rankings", news: "Player news", headlines: "League headlines", history: "Player history", draft_capital: "Draft capital archive", odds: "Weekly odds", teams: "Team forecasts", stats: "Season statistics", primary_sportsbook: "The Odds API", sportsbook_backup: "SportsGameOdds", sportsbooks: "Sportsbook comparison", exchange: "Kalshi", prediction_markets: "Polymarket", schedule: "Schedule", weather: "Weather", injuries: "Injury reports"})[name] || name.replaceAll("_", " ");
}

const footer = document.querySelector("footer");
if (footer && footer.dataset.compact !== "true") {
  const status = document.createElement("details"), title = document.createElement("summary"), info = document.createElement("div");
  status.className = "site-refresh-status"; title.textContent = "Data refresh: every 6 hours (Eastern time)"; status.append(title, info); footer.append(status);
  const check = async () => {
    try {
      const response = await fetch("data/update_status.json", {cache: "no-store"}); if (!response.ok) throw new Error("No refresh status");
      const data = await response.json(), completed = Date.parse(data.completed_at);
      if (!Number.isFinite(completed)) throw new Error("Invalid refresh status");
      const stale = Date.now() - completed > 7 * 3600000;
      const jobFailed = data.execution_status === "partial_failure" || data.execution_status === "failed";
      title.textContent = `Data refresh: ${jobFailed ? "some refresh jobs failed" : data.status === "success" ? "last run completed" : "some sources need attention"}${stale ? " · overdue" : ""}`;
      info.replaceChildren();
      const note = document.createElement("p"); note.textContent = `Scheduled at midnight, 6am, noon and 6pm Eastern. Last attempt: ${refreshDate(data.completed_at)}. Open data pages check for published updates automatically and keep your selections. A completed job can still contain older provider data; manual imports and historical archives follow their own update rules.`; info.append(note);
      for (const [name, source] of Object.entries(data.sources || {})) {
        const row = document.createElement("p"); row.textContent = `${sourceLabel(name)}: ${sourceHealthText(source)}`; info.append(row);
        const providers = Object.entries(source.providers || {});
        if (providers.length) {
          const list = document.createElement("ul");
          for (const [provider, health] of providers) {
            const item = document.createElement("li"); item.textContent = `${sourceLabel(provider)}: ${sourceHealthText(health)}`; list.append(item);
          }
          info.append(list);
        }
      }
    } catch {
      title.textContent = "Data refresh: status unavailable";
      info.textContent = "Refresh status is unavailable. Use the timestamps displayed in each lab; missing status does not mean the data is current. Update checks continue automatically.";
    }
  };
  check(); setInterval(check, 10 * 60 * 1000);
}
