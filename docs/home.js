import {injuryFeed, filterInjuries, snapshotFreshness} from "./home-data.mjs?v=20260913-home1";
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
let injuries = [], shown = 8;

function renderInjuries() {
  const rows = filterInjuries(injuries, $("injury-search").value, $("injury-filter").value);
  $("injury-count").textContent = `${rows.length} matching reports`;
  $("home-injury-list").replaceChildren(...rows.slice(0, shown).map(row => {
    const card = el("article", undefined, "home-injury"), body = el("div");
    body.append(el("span", `${row.team} · ${row.pos} · ${row.reportLabel}`, "home-small"), el("h3", row.player), el("p", row.injury), el("p", row.status));
    if (row.practice && row.practice !== row.status) body.append(el("p", `Practice: ${row.practice}`));
    if (row.url) { const source = el("a", "Team injury source ↗"); source.href = row.url; source.target = "_blank"; source.rel = "noopener noreferrer"; body.append(source); }
    const badge = el("span", row.risk ? "RISK" : "REPORTED", `home-badge${row.risk ? " home-risk" : ""}`);
    card.append(body, badge); return card;
  }));
  if (!rows.length) $("home-injury-list").append(el("p", injuries.length ? "No reports match these filters." : "No injury entries are available in this snapshot. Missing reports do not mean players are healthy.", "home-small"));
  $("injury-more").hidden = rows.length <= shown;
}

async function loadInjuries() {
  try {
    const response = await fetch("data/player_news.json", {cache: "no-store"});
    if (!response.ok) throw new Error("Injury snapshot could not be loaded.");
    const bundle = await response.json(); injuries = injuryFeed(bundle);
    const freshness = snapshotFreshness(bundle.generated_at);
    $("injury-freshness").textContent = `Saved snapshot: ${freshness.label}. ${freshness.stale ? "This snapshot is older than the six-hour schedule or its date is unavailable. Verify availability with the source." : "Report weeks below describe the source coverage; this is not a live feed."}`;
    $("injury-freshness").classList.toggle("stale", freshness.stale);
    renderInjuries();
  } catch {
    for (const id of ["injury-search", "injury-filter", "injury-more"]) $(id).disabled = true;
    $("injury-count").textContent = "Reports unavailable";
    $("injury-freshness").textContent = "The injury snapshot is unavailable. No current injury status can be inferred. Rankings and the other tools remain available.";
    $("injury-freshness").classList.add("stale");
    $("home-injury-list").replaceChildren();
  }
}
$("injury-search").addEventListener("input", () => { shown = 8; renderInjuries(); });
$("injury-filter").addEventListener("change", () => { shown = 8; renderInjuries(); });
$("injury-more").addEventListener("click", () => { shown += 8; renderInjuries(); });

// No social scripts, frames, or requests are loaded until the visitor opts in.
$("load-x-feed").addEventListener("click", async () => {
  $("load-x-feed").disabled = true; $("social-status").textContent = "Requesting the official X feed…";
  const target = $("x-feed"), link = el("a", "View posts from @NFL on X");
  link.className = "twitter-timeline"; link.href = "https://x.com/NFL"; link.target = "_blank"; link.rel = "noopener noreferrer";
  link.dataset.theme = "dark"; link.dataset.height = "560"; link.dataset.dnt = "true"; target.replaceChildren(link);
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script"), timeout = setTimeout(() => reject(new Error("timeout")), 12000);
      script.src = "https://platform.x.com/widgets.js"; script.async = true; script.charset = "utf-8";
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = () => { clearTimeout(timeout); reject(new Error("blocked")); };
      document.head.append(script);
    });
    $("social-status").textContent = "X content requested. If the feed is unavailable or asks you to sign in, use “Open NFL on X” below. This is not a live play-by-play feed.";
  } catch {
    $("social-status").textContent = "The embedded feed could not load. You can still watch clips above or open NFL on X directly.";
  }
});
loadInjuries();
