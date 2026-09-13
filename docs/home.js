import {injuryFeed, filterInjuries, snapshotFreshness, titlePlayers, recentHeadlineCards} from "./home-data.mjs?v=20260913-cards1";
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
let injuries = [], shown = 8;

function portrait(player) {
  const wrapper = el("span", undefined, "home-portrait");
  const initials = el("span", player.player.split(/\s+/).slice(0, 2).map(word => word[0]).join(""));
  initials.setAttribute("aria-hidden", "true"); wrapper.append(initials);
  if (player.photoUrl) {
    const photo = el("img"); photo.alt = `${player.player} portrait`;
    photo.width = 56; photo.height = 56; photo.loading = "lazy"; photo.decoding = "async";
    photo.referrerPolicy = "no-referrer";
    photo.addEventListener("error", () => photo.remove(), {once: true});
    photo.src = player.photoUrl; wrapper.append(photo);
  }
  return wrapper;
}

function injuryDetails(body, row) {
  body.append(el("p", `${row.injury} · ${row.status}`, "home-injury-detail"));
  if (row.practice && row.practice !== row.status) body.append(el("p", `Practice: ${row.practice}`));
  if (row.url) {
    const source = el("a", "Team injury source ↗"); source.href = row.url;
    source.target = "_blank"; source.rel = "noopener noreferrer"; body.append(source);
  }
}

function playerSummary(player) {
  const summary = el("div", undefined, "home-player-summary"), body = el("div");
  body.append(el("strong", player.player), el("p", `${player.team} · ${player.pos}`, "home-small"));
  summary.append(portrait(player), body); return summary;
}

function renderSourcePlayers(bundle) {
  for (const card of document.querySelectorAll("#selected-source-cards .home-source-card")) {
    const players = titlePlayers(bundle, card.querySelector(".home-clip strong").textContent);
    card.querySelector(".home-card-players").replaceChildren(...(players.length ? players.map(playerSummary)
      : [el("p", bundle ? "No unambiguous player match in the saved roster." : "Player details unavailable. Open the original story above.", "home-small")]));
  }
  const cards = recentHeadlineCards(bundle);
  $("recent-headline-list").replaceChildren(...cards.map(card => {
    const article = el("article", undefined, "home-source-card"), link = el("a", undefined, "home-clip");
    link.href = card.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    const title = el("div"); title.append(el("small", `${card.source} · ${card.date}`), el("strong", card.title));
    const arrow = el("b", "↗"); arrow.setAttribute("aria-hidden", "true"); link.append(title, arrow);
    const players = el("div", undefined, "home-card-players"); players.append(...card.players.map(playerSummary));
    article.append(link, players); return article;
  }));
  $("recent-headline-status").textContent = cards.length ? "Recent matched headlines from the saved ESPN feed (past 7 days)."
    : bundle ? "No recent full-name player headlines in this saved feed. Source links above remain available."
    : "The saved news feed is unavailable. Source links above remain available.";
}

function renderInjuries() {
  const rows = filterInjuries(injuries, $("injury-search").value, $("injury-filter").value);
  $("injury-count").textContent = `${rows.length} matching report${rows.length === 1 ? "" : "s"}`;
  $("home-injury-list").replaceChildren(...rows.slice(0, shown).map(row => {
    const card = el("article", undefined, "home-injury"), body = el("div"), summary = el("div", undefined, "home-player-summary");
    body.append(el("span", `${row.team} · ${row.pos} · ${row.reportLabel}`, "home-small"), el("h3", row.player));
    injuryDetails(body, row); summary.append(portrait(row), body);
    const badge = el("span", row.risk ? "RISK" : "REPORTED", `home-badge${row.risk ? " home-risk" : ""}`);
    card.append(summary, badge); return card;
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
    renderInjuries(); renderSourcePlayers(bundle);
  } catch {
    for (const id of ["injury-search", "injury-filter", "injury-more"]) $(id).disabled = true;
    $("injury-count").textContent = "Reports unavailable";
    $("injury-freshness").textContent = "The injury snapshot is unavailable. No current injury status can be inferred. Rankings and the other tools remain available.";
    $("injury-freshness").classList.add("stale");
    $("home-injury-list").replaceChildren();
    renderSourcePlayers(null);
  }
}
$("injury-search").addEventListener("input", () => { shown = 8; renderInjuries(); });
$("injury-filter").addEventListener("change", () => { shown = 8; renderInjuries(); });
$("injury-more").addEventListener("click", () => { shown += 8; renderInjuries(); });

// Load the official embed asynchronously so an X outage cannot block the page.
async function loadXFeed() {
  $("social-status").textContent = "Loading the NFL on X…";
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
}
loadInjuries();
loadXFeed();
