const menus = [
  ["Fantasy", [["Player rankings", "./"], ["Kickers & D/ST", "special-teams.html"]]],
  ["Projection Lab", [["Player age & scoring", "projection.html"], ["Draft capital map", "projection.html#round-map-heading"]]],
  ["Simulation Lab", [["Head-to-head matchup", "survivor.html#matchup-heading"], ["Team game forecasts", "league.html#team-games-heading"], ["League, playoffs & Super Bowl", "league.html"], ["Survivor planner", "survivor.html#rules-heading"]]],
  ["Betting", [["Weekly odds", "odds.html"]]],
];
const nav = document.querySelector(".topnav"), page = location.pathname.split("/").pop() || "index.html";
if (nav) {
  nav.classList.add("lab-navigation");
  const groups = menus.map(([name, links]) => {
    const details = document.createElement("details"), summary = document.createElement("summary"), list = document.createElement("div");
    summary.textContent = name; list.className = "lab-nav-menu";
    for (const [label, url] of links) {
      const link = document.createElement("a"); link.textContent = label; link.href = url;
      if ((url === "./" ? "index.html" : url.split("#")[0]) === page) { details.classList.add("current-lab"); if (!url.includes("#")) link.setAttribute("aria-current", "page"); }
      link.addEventListener("click", () => { details.open = false; }); list.append(link);
    }
    details.append(summary, list);
    details.addEventListener("toggle", () => { if (details.open) for (const other of nav.querySelectorAll("details")) if (other !== details) other.open = false; });
    return details;
  });
  nav.replaceChildren(...groups);
  document.addEventListener("click", event => { if (!nav.contains(event.target)) groups.forEach(group => { group.open = false; }); });
  nav.addEventListener("keydown", event => { if (event.key === "Escape") { const active = groups.find(group => group.open); if (active) { active.open = false; active.querySelector("summary").focus(); } } });
}

const footer = document.querySelector("footer");
if (footer) {
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
