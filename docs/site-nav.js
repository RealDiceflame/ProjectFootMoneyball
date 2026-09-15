const menus = [
  ["Stats", [[null, [["Game results", "stats.html"], ["League leaders", "stats.html?view=leaders"]]]]],
  ["Fantasy", [[null, [["Player rankings", "rankings.html"], ["Kickers & D/ST", "special-teams.html"], ["My leagues · prototype", "fantasy.html"]]]]],
  ["Labs", [
    ["Projection Lab", [["Player age & scoring", "projection.html"], ["Draft capital map", "projection.html#round-map-heading"]]],
    ["Simulation Lab", [["Head-to-head matchup", "survivor.html#matchup-heading"], ["Team game forecasts", "league.html#team-games-heading"], ["League, playoffs & Super Bowl", "league.html"], ["Survivor planner", "survivor.html#rules-heading"]]],
  ]],
  ["Betting", [[null, [["Weekly odds", "odds.html"]]]]],
];
const nav = document.querySelector(".topnav"), page = location.pathname.split("/").pop() || "index.html";
if (nav) {
  nav.classList.add("lab-navigation");
  const hover = matchMedia("(any-hover: hover) and (any-pointer: fine)");
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
        link.addEventListener("click", () => close(details)); section.append(link);
      }
      list.append(section);
    }
    details.append(summary, list);
    const open = () => { groups.forEach(other => { if (other !== details) close(other); }); cancelClose(details); details.open = true; };
    details.addEventListener("pointerenter", event => {
      if (!hover.matches || event.pointerType !== "mouse") return;
      // A mouse passing over another tab must not hide a keyboard-focused link.
      if (groups.some(other => other !== details && hasKeyboardFocus(other))) return;
      open();
    });
    details.addEventListener("pointerleave", event => {
      if (event.pointerType !== "mouse") return;
      cancelClose(details);
      closeTimers.set(details, setTimeout(() => {
        if (!hasKeyboardFocus(details)) close(details);
      }, 220));
    });
    details.addEventListener("focusin", () => cancelClose(details));
    details.addEventListener("focusout", event => { if (!details.contains(event.relatedTarget)) close(details); });
    details.addEventListener("toggle", () => { if (details.open) groups.forEach(other => { if (other !== details) close(other); }); });
    return details;
  });
  const home = document.createElement("a");
  home.href = "./"; home.textContent = "Home"; home.className = "home-nav-link";
  if (page === "index.html") home.setAttribute("aria-current", "page");
  nav.replaceChildren(home, ...groups);
  document.addEventListener("click", event => { if (!nav.contains(event.target)) groups.forEach(close); });
  nav.addEventListener("keydown", event => { if (event.key === "Escape") { const active = groups.find(group => group.open); if (active) { event.preventDefault(); close(active); active.querySelector("summary").focus(); } } });
}

const footer = document.querySelector("footer");
if (footer && footer.dataset.compact !== "true") {
  const status = document.createElement("details"), title = document.createElement("summary"), info = document.createElement("div");
  status.className = "site-refresh-status"; title.textContent = "Data refresh: every 6 hours (Eastern time)"; status.append(title, info); footer.append(status);
  let initial = null;
  const check = async () => {
    try {
      const response = await fetch("data/update_status.json", {cache: "no-store"}); if (!response.ok) throw new Error("No refresh status");
      const data = await response.json(), completed = Date.parse(data.completed_at);
      if (!Number.isFinite(completed)) throw new Error("Invalid refresh status");
      const stale = Date.now() - completed > 7 * 3600000;
      title.textContent = `Data refresh: ${data.status === "success" ? "last run completed" : "some sources need attention"}${stale ? " · overdue" : ""}${initial && completed > initial ? " · newer snapshots available; reload to use them" : ""}`;
      if (!initial) initial = completed;
      info.replaceChildren();
      const note = document.createElement("p"); note.textContent = `Scheduled at midnight, 6am, noon and 6pm Eastern. Last attempt: ${new Date(completed).toLocaleString()}. Provider outages and scheduling delays can leave older data; Yahoo imports remain manual. Reload to load published snapshots. Your draft selections are not automatically reset.`; info.append(note);
      for (const [name, source] of Object.entries(data.sources || {})) {
        const row = document.createElement("p"); row.textContent = `${name.replaceAll("_", " ")}: ${source.status}; last successful refresh ${source.last_success ? new Date(source.last_success).toLocaleString() : "unknown"}.`; info.append(row);
      }
    } catch { info.textContent = "Refresh status is unavailable. Use the timestamps displayed in each lab; missing status does not mean the data is current."; }
  };
  check(); setInterval(check, 10 * 60 * 1000);
}
