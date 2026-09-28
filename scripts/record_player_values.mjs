import {readFile, mkdir, writeFile, rename} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {MODEL_VERSION, buildValueBoard} from '../docs/player-values.mjs';

export const SNAPSHOT_COLUMNS = ['player_id', 'ros_index', 'dynasty_index', 'ros_points', 'dynasty_points',
  'projected_ppg', 'appearances', 'available_games', 'ros_surplus', 'dynasty_surplus'];

async function atomicJson(path, payload) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(payload) + '\n', 'utf8');
  await rename(temporary, path);
}

export async function recordPlayerValues(root, {now = Date.now()} = {}) {
  const bundles = {}, evidence = {};
  for (const [key, filename] of Object.entries({rankings: 'rankings.json', history: 'player_history.json', news: 'player_news.json', inputs: 'player_value_inputs.json'})) {
    const content = await readFile(resolve(root, 'docs/data', filename), 'utf8');
    bundles[key] = JSON.parse(content);
    const generated = Date.parse(bundles[key].generated_at);
    if (bundles[key].generated_at && (!Number.isFinite(generated) || generated > now + 300000))
      throw new Error(`Invalid or future-dated ${key} snapshot; history was not recorded.`);
    evidence[key] = {path: filename, generated_at: bundles[key].generated_at || null,
      sha256: createHash('sha256').update(content).digest('hex')};
  }
  if (!bundles.inputs.rows?.length || !bundles.inputs.games?.length) throw new Error('No archived value observations; previous snapshots retained.');
  if (!Number.isFinite(Date.parse(bundles.inputs.generated_at))) throw new Error('A dated current-season input snapshot is required.');
  if (Date.parse(bundles.inputs.generated_at) > now + 300000) throw new Error('Future-dated inputs cannot create a value snapshot.');
  for (const game of bundles.inputs.games) {
    if (game.source_updated_at && Date.parse(game.source_updated_at) > now + 300000)
      throw new Error('Future-dated archived game evidence; history was not recorded.');
  }
  const folder = resolve(root, 'docs/data/player_values'), manifestPath = resolve(folder, 'index.json');
  let previous = {schema_version: 1, snapshots: []};
  try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous.schema_version !== 1 || !Array.isArray(previous.snapshots)) throw new Error('Invalid value-history manifest; refusing to replace it.');
  const asOf = new Date(now).toISOString(), date = asOf.slice(0, 10), filename = `${date}.json`;
  if (previous.snapshots.some(item => Date.parse(item.as_of) > now)) throw new Error('Refusing to rewrite history with a backdated snapshot.');
  const payload = {schema_version: 1, model_version: MODEL_VERSION, season: bundles.inputs.season,
    date, as_of: asOf, cadence: 'Latest captured calculation per UTC date; not reconstructed historical consensus.',
    evidence, coverage: bundles.inputs.coverage, formats: {}};
  for (const quarterbacks of ['1QB', '2QB']) for (const ppr of ['Standard', 'Half PPR', 'Full PPR']) for (const tePremium of ['None', '+0.5']) {
    const board = buildValueBoard(bundles, {quarterbacks, ppr, tePremium}, {now});
    if (!board.rows.some(row => row.ros_index !== null)) throw new Error('No rated players; previous value snapshots retained.');
    payload.formats[board.format_key] = {settings: board.settings, replacement: board.replacement,
      columns: SNAPSHOT_COLUMNS, rows: board.rows.map(row => SNAPSHOT_COLUMNS.map(key => row[key] ?? null))};
  }
  const snapshots = previous.snapshots.filter(item => item.date !== date);
  snapshots.push({date, as_of: asOf, path: filename, season: payload.season, model_version: MODEL_VERSION});
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  // Publish the completed file before pointing the manifest at it. Older dates
  // are retained, even across a new model version, rather than silently refitted.
  await atomicJson(resolve(folder, filename), payload);
  await atomicJson(manifestPath, {schema_version: 1, model_version: MODEL_VERSION, updated_at: asOf, snapshots});
  return {date, players: Object.values(payload.formats)[0].rows.length, formats: Object.keys(payload.formats).length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  recordPlayerValues(root).then(result => console.log(JSON.stringify(result))).catch(error => {console.error(error.message); process.exitCode = 1;});
}
