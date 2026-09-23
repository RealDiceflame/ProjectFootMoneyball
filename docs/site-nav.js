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
  const mobile = matchMedia("(max-width: 720px)");
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
