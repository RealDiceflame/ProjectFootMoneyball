import test from "node:test";
import assert from "node:assert/strict";
import {columnarDraftRows, migrateDraftedKeys, toggleDraftedKey, validDraftAliases} from "../docs/draft-identity.mjs";

const player = (player, team, player_id, pos = "RB") => ({player, team, player_id, pos});

test("stable player IDs carry drafted marks across team/name changes and repeated league formats", () => {
  const old = player("Example Runner", "BUF", "1"), moved = player("Example Runner", "KC", "1");
  const migrated = migrateDraftedKeys(new Set(["example runner|BUF", "another player|NE"]), [old, old], [moved, moved]);
  assert.deepEqual([...migrated.drafted].sort(), ["another player|NE", "example runner|BUF", "example runner|KC"]);
  const renamed = migrateDraftedKeys(migrated.drafted, [moved], [player("Example Runner Jr.", "KC", "1")], migrated.aliases);
  assert.ok(renamed.drafted.has("example runner jr.|KC"));
  const undone = toggleDraftedKey(renamed.drafted, "example runner jr.|KC", renamed.aliases);
  assert.deepEqual([...undone], ["another player|NE"]);
  assert.equal(migrateDraftedKeys(undone, [moved], [old], renamed.aliases).drafted.has("example runner|BUF"), false, "an old format cannot resurrect an undone pick");
});

test("ID-less players migrate only when their exact name and position are unique in both snapshots", () => {
  const old = player("Example Kicker", "BUF", undefined, "K"), moved = player("Example Kicker", "KC", undefined, "K");
  assert.ok(migrateDraftedKeys(new Set(["example kicker|BUF"]), [old, old], [moved, moved]).drafted.has("example kicker|KC"));
  for (const [before, after] of [
    [[old, player("Example Kicker", "NE", undefined, "K")], [moved]],
    [[old], [moved, player("Example Kicker", "NE", undefined, "K")]],
    [[old], [player("Example Kicker", "KC", undefined, "RB")]],
  ]) assert.equal(migrateDraftedKeys(new Set(["example kicker|BUF"]), before, after).drafted.has("example kicker|KC"), false);
});

test("same-name players with different IDs never inherit one another's pick", () => {
  const old = player("Same Name", "BUF", "1"), different = player("Same Name", "KC", "2");
  assert.equal(migrateDraftedKeys(new Set(["same name|BUF"]), [old], [different]).drafted.has("same name|KC"), false);
  const migrated = migrateDraftedKeys(new Set(["same name|BUF"]), [old, different], [player("Same Name", "NE", "1"), different]);
  assert.ok(migrated.drafted.has("same name|NE"));
  assert.equal(migrated.drafted.has("same name|KC"), false);
});

test("persisted alias groups preserve existing storage and allow a complete undo after reload", () => {
  const aliases = JSON.parse(JSON.stringify([["example|BUF", "example|KC"], ["example|KC", "example|NE"]]));
  const migrated = migrateDraftedKeys(new Set(["example|BUF"]), [], [player("Example", "NE", "1")], aliases);
  assert.deepEqual([...migrated.drafted].sort(), ["example|BUF", "example|KC", "example|NE"]);
  assert.equal(toggleDraftedKey(migrated.drafted, "example|NE", aliases).size, 0);
  assert.deepEqual(validDraftAliases([null, "bad", ["bad"], ["a|BUF", 12]]), []);
});

test("columnar snapshots include every league format without depending on the active filter", () => {
  const bundle = {columns: ["player", "team", "pos", "player_id"], boards: {first: [["Example", "BUF", "RB", "1"]], second: [["Example", "KC", "RB", "1"]]}};
  assert.equal(columnarDraftRows(bundle).length, 2);
  assert.deepEqual(columnarDraftRows(null), []);
  const migrated = migrateDraftedKeys(new Set(["example|BUF"]), columnarDraftRows(bundle), columnarDraftRows(bundle));
  assert.ok(migrated.drafted.has("example|KC"));
});
