import {STORAGE_KEY, SLOT_LIMITS, DEFAULT_ROSTER, emptyStore, createLeague, updateLeague, validateStore, parseBackup, importCopies, rosterSummary} from "./fantasy-leagues.mjs?v=20260913-hub1";

const $ = id => document.getElementById(id);
const form = $("league-setup");
let store = emptyStore(), editingId = null, storageBlocked = false, storedText = null;
const field = name => form.elements.namedItem(name);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const reportError = error => { $("hub-error").textContent = error.message; $("hub-error").hidden = false; $("hub-status").textContent = ""; };
const reportSuccess = text => { $("hub-error").hidden = true; $("hub-status").textContent = text; };

function persist(next) {
  if (storageBlocked) throw new Error("Saved data could not be read. This page will not overwrite it. Enable browser storage or use a different browser profile to try the prototype.");
  // Prevent another open tab's changes from being silently overwritten.
  if (localStorage.getItem(STORAGE_KEY) !== storedText) throw new Error("Another tab changed your league setups. Reload this page before saving; unsaved form edits will not be kept.");
  const validated = validateStore(next), serialized = JSON.stringify(validated);
  try { localStorage.setItem(STORAGE_KEY, serialized); }
  catch { throw new Error("Your browser could not save this change. Check storage permissions or space. Existing setups have not been changed."); }
  storedText = serialized; store = validated; renderSaved();
}

function settings() {
  return {
    name: field("name").value, season: Number(field("season").value), team_count: Number(field("team_count").value),
    scoring: Object.fromEntries(["ppr", "te_premium", "passing_td"].map(key => [key, Number(field(key).value)])),
    roster: Object.fromEntries(Object.keys(SLOT_LIMITS).map(slot => [slot, Number(field(`slot_${slot}`).value)])),
  };
}

function updateRosterSummary() {
  const {starters, bench, reserve, total} = rosterSummary(settings().roster);
  $("roster-summary").textContent = `${starters} starters · ${bench} bench · ${reserve} reserve · ${total} total slots per team`;
}

function resetForm(focus = false) {
  editingId = null; form.reset(); field("team_count").disabled = false;
  $("team-names").hidden = true; $("team-name-fields").replaceChildren();
  $("setup-heading").textContent = "Create a league setup"; $("save-league").textContent = "Create local setup"; $("cancel-edit").hidden = true;
  updateRosterSummary();
  if (focus) $("setup-heading").focus();
}

function editLeague(league) {
  editingId = league.id;
  for (const key of ["name", "season", "team_count"]) field(key).value = league[key];
  for (const [key, value] of Object.entries(league.scoring)) field(key).value = value;
  for (const [slot, value] of Object.entries(league.roster)) field(`slot_${slot}`).value = value;
  field("team_count").disabled = true;
  $("team-name-fields").replaceChildren(...league.teams.map((team, index) => {
    const label = node("label", `Team ${index + 1}`), input = node("input");
    input.name = `team_${team.id}`; input.value = team.name; input.required = true; input.maxLength = 50; label.append(input); return label;
  }));
  $("team-names").hidden = false; $("cancel-edit").hidden = false;
  $("setup-heading").textContent = `Edit ${league.name}`; $("save-league").textContent = "Save local changes";
  updateRosterSummary(); $("setup-heading").focus();
}

function renderSaved() {
  $("export-leagues").disabled = !store.leagues.length;
  $("saved-leagues").replaceChildren(...store.leagues.map(league => {
    const card = node("article"), totals = rosterSummary(league.roster);
    card.append(node("p", `${league.season} · OutlierBaseline · setup only`, "fantasy-tag"), node("h3", league.name));
    card.append(node("p", `${league.team_count} teams · ${league.scoring.ppr} PPR · +${league.scoring.te_premium} TE reception bonus · ${league.scoring.passing_td}-point passing TDs`));
    card.append(node("p", `${totals.starters} starters · ${league.roster.QB} QB${league.roster.SUPERFLEX ? " + superflex" : ""} · ${totals.bench} bench · ${totals.reserve} reserve`));
    const actions = node("div", undefined, "fantasy-actions"), edit = node("button", "Edit setup & teams", "button secondary"), remove = node("button", "Delete setup", "button secondary");
    edit.type = remove.type = "button"; edit.addEventListener("click", () => editLeague(league));
    remove.addEventListener("click", () => {
      if (!confirm(`Delete the local setup “${league.name}”? Export a backup first if you want to keep it. This cannot be undone without a backup.`)) return;
      try { persist({...store, leagues: store.leagues.filter(item => item.id !== league.id)}); if (editingId === league.id) resetForm(); reportSuccess("Local setup deleted. Other leagues and your draft board are unchanged."); }
      catch (error) { reportError(error); }
    });
    actions.append(edit, remove); card.append(actions); return card;
  }));
  if (!store.leagues.length) $("saved-leagues").append(node("p", "No saved setups yet. Create your first league below. No account or payment is required for this local preview."));
}

for (const [slot, [min, max]] of Object.entries(SLOT_LIMITS)) {
  const names = {SUPERFLEX: "Superflex", DST: "Team defense", BN: "Bench", IR: "Injured reserve"};
  const label = node("label", names[slot] || slot), input = node("input");
  input.name = `slot_${slot}`; input.type = "number"; input.min = min; input.max = max; input.required = true; input.defaultValue = DEFAULT_ROSTER[slot];
  label.append(input); $("roster-fields").append(label);
}
field("season").defaultValue = new Date().getFullYear();
try { storedText = localStorage.getItem(STORAGE_KEY); if (storedText !== null) store = parseBackup(storedText); }
catch { storageBlocked = true; reportError(new Error("Your saved league data is unavailable or incompatible. It has not been erased or overwritten. Check browser storage access; keep any existing backup before trying another browser profile.")); }
renderSaved(); updateRosterSummary();

form.addEventListener("input", updateRosterSummary);
form.addEventListener("submit", event => {
  event.preventDefault();
  try {
    const values = settings(), existing = store.leagues.find(league => league.id === editingId);
    const saved = existing ? updateLeague(existing, {...values, teams: existing.teams.map(team => ({...team, name: field(`team_${team.id}`).value}))}) : createLeague(values);
    persist({...store, leagues: existing ? store.leagues.map(league => league.id === saved.id ? saved : league) : [...store.leagues, saved]});
    editLeague(saved); reportSuccess(`“${saved.name}” saved in this browser. You can now edit the team names. Export a backup before clearing browser data.`);
  } catch (error) { reportError(error); }
});
$("new-league").addEventListener("click", () => resetForm(true));
$("cancel-edit").addEventListener("click", () => resetForm(true));
$("export-leagues").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(store, null, 2)], {type: "application/json"}), url = URL.createObjectURL(blob), link = node("a");
  link.href = url; link.download = `outlierbaseline-league-setups-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  reportSuccess("Backup download started. This file contains local setups and team names, not a shared league or invitation.");
});
$("import-leagues").addEventListener("click", () => $("backup-file").click());
$("backup-file").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error("Choose a league-setup JSON backup smaller than 1 MB.");
    const incoming = parseBackup(await file.text());
    persist(importCopies(store, incoming)); reportSuccess(`${incoming.leagues.length} league setup(s) imported as independent local copies. Existing setups were kept.`);
  } catch (error) { reportError(error); }
  finally { event.target.value = ""; }
});
