export const DRAFT_ALIASES_KEY = "project-foot-moneyball:drafted-aliases:v1";

const cleanId = value => {
  const id = String(value ?? "").trim();
  return id && !["-", "nan", "none", "null", "undefined"].includes(id.toLowerCase()) ? id : "";
};
const rowKey = row => `${String(row.player).trim().toLowerCase()}|${String(row.listed_team || row.team || "").trim().toUpperCase()}`;
const namePosition = row => `${String(row.player).trim().toLowerCase()}|${String(row.pos || "").trim().toUpperCase()}`;

export function columnarDraftRows(bundle) {
  if (!Array.isArray(bundle?.columns)) return [];
  const rows = bundle.boards ? Object.values(bundle.boards).flat() : bundle.rows || [];
  return rows.map(values => Object.fromEntries(bundle.columns.map((column, index) => [column, values[index]])));
}

export function validDraftAliases(value) {
  return Array.isArray(value) ? value.filter(group => Array.isArray(group) && group.length > 1
    && group.every(key => typeof key === "string" && key.includes("|"))).map(group => [...new Set(group)]) : [];
}

function addAliasGroup(groups, keys) {
  const combined = new Set(keys);
  let size;
  do {
    size = combined.size;
    for (const group of groups) if (group.some(key => combined.has(key))) group.forEach(key => combined.add(key));
  } while (size !== combined.size);
  const remaining = groups.filter(group => !group.some(key => combined.has(key)));
  if (combined.size > 1) remaining.push([...combined].sort());
  return remaining;
}

function indexRows(rows) {
  const byId = new Map(), byName = new Map(), owners = new Map();
  for (const row of rows) {
    if (!row || typeof row.player !== "string" || !row.player.trim() || !row.pos) continue;
    const id = cleanId(row.player_id), key = rowKey(row), name = namePosition(row);
    for (const [map, identity] of [[byName, name], ...(id ? [[byId, id]] : [])]) {
      if (!map.has(identity)) map.set(identity, new Map());
      map.get(identity).set(`${id}|${key}`, {id, key});
    }
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(id ? `id:${id}` : `name:${name}`);
  }
  return {byId, byName, owners};
}

// Keep legacy name|team storage readable by older pages. Only verified transfers
// create aliases; retaining those aliases also lets Undo clear all linked keys.
export function migrateDraftedKeys(drafted, previousRows, nextRows, aliases = []) {
  const before = indexRows(previousRows), after = indexRows(nextRows);
  const next = new Set(drafted);
  let groups = validDraftAliases(aliases).reduce(addAliasGroup, []);
  const link = (oldRows, newRows) => {
    const old = [...oldRows.values()], current = [...newRows.values()];
    if ([...old, ...current].some(row => (before.owners.get(row.key)?.size || 0) > 1 || (after.owners.get(row.key)?.size || 0) > 1)) return;
    const keys = [...new Set([...old, ...current].map(row => row.key))];
    if (keys.length > 1) groups = addAliasGroup(groups, keys);
  };
  for (const [id, oldRows] of before.byId) {
    const newRows = after.byId.get(id);
    if (newRows) link(oldRows, newRows);
  }
  for (const [name, oldRows] of before.byName) {
    const newRows = after.byName.get(name);
    // Repeated formats are deduplicated; two real same-name players stay separate.
    if (oldRows.size !== 1 || newRows?.size !== 1) continue;
    if ([...oldRows.values(), ...newRows.values()].some(row => row.id)) continue;
    link(oldRows, newRows);
  }
  for (const group of groups) if (group.some(key => next.has(key))) group.forEach(key => next.add(key));
  return {drafted: next, aliases: groups};
}

export function toggleDraftedKey(drafted, key, aliases = []) {
  const keys = new Set([key]);
  // Resolve transitively so previously saved groups remain safe across releases.
  let size;
  do {
    size = keys.size;
    for (const group of validDraftAliases(aliases)) if (group.some(alias => keys.has(alias))) group.forEach(alias => keys.add(alias));
  } while (size !== keys.size);
  const next = new Set(drafted), undo = next.has(key);
  for (const alias of keys) { if (undo) next.delete(alias); else next.add(alias); }
  return next;
}
