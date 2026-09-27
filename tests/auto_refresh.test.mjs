import test from "node:test";
import assert from "node:assert/strict";
import {startAutoRefresh, fetchSnapshot} from "../docs/auto-refresh.mjs";

function harness(refresh, extra = {}) {
  let time = 0;
  const listeners = new Map(), intervals = new Set(), timeouts = new Set();
  const documentRef = {hidden: false, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key)};
  const timers = {setInterval: fn => (intervals.add(fn), fn), clearInterval: fn => intervals.delete(fn),
    setTimeout: fn => (timeouts.add(fn), fn), clearTimeout: fn => timeouts.delete(fn)};
  const poller = startAutoRefresh(refresh, {documentRef, windowRef: documentRef, timers, now: () => time, manifestUrl: null, ...extra});
  return {poller, listeners, intervals, timeouts, documentRef, tick: ms => { time += ms; }};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("refresh checks are non-overlapping, throttled, paused when hidden, and removable", async () => {
  let calls = 0, resolve;
  const h = harness(() => { calls++; return new Promise(done => {resolve = done;}); });
  assert.equal(calls, 1);
  h.tick(60000); await h.poller.check(); assert.equal(calls, 1);
  resolve(); await settle();
  h.documentRef.hidden = true; await h.poller.check(); assert.equal(calls, 1);
  h.documentRef.hidden = false; h.listeners.get("visibilitychange")(); assert.equal(calls, 2);
  resolve(); await settle(); await h.poller.check(); assert.equal(calls, 2);
  h.poller.stop(); h.tick(60000); await h.poller.check();
  assert.equal(calls, 2); assert.equal(h.listeners.size, 0); assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0);
});

test("small manifest avoids full downloads; changed revisions and periodic fallback refresh", async () => {
  let revision = "2026-09-27T12:00:00Z", calls = 0, manifests = 0, checks = 0;
  const h = harness(async () => {calls++;}, {onCheck: () => checks++, manifestUrl: "manifest", readManifest: async () => {manifests++; return {completed_at: revision};}});
  await settle(); assert.equal(calls, 1);
  h.tick(60000); await h.poller.check(); assert.equal(calls, 1); assert.equal(manifests, 2);
  assert.equal(checks, 2, "time-sensitive labels recheck even without a new publication");
  revision = "2026-09-27T18:00:00Z"; h.tick(60000); await h.poller.check(); assert.equal(calls, 2);
  h.tick(15 * 60000); await h.poller.check(); assert.equal(calls, 3);
  h.poller.stop();
});

test("failed refresh retries same revision; missing manifest falls back to data", async () => {
  let calls = 0, failures = 0, missing = false;
  const h = harness(async () => {calls++; if (calls === 1) throw new Error("offline");}, {
    manifestUrl: "manifest", readManifest: async () => {if (missing) throw new Error("offline"); return {completed_at: "2026-09-27T12:00:00Z"};}, onError: () => failures++,
  });
  await settle(); assert.equal(failures, 1);
  h.tick(60000); await h.poller.check(); assert.equal(calls, 2);
  missing = true; h.tick(60000); await h.poller.check(); assert.equal(calls, 3);
  h.poller.stop();
});

test("busy pages defer without consuming the attempt and timeouts abort the request", async () => {
  let busy = true, calls = 0, failures = 0;
  const h = harness(signal => new Promise((resolve, reject) => {
    calls++; signal.addEventListener("abort", () => reject(signal.reason));
  }), {canRefresh: () => !busy, onError: () => failures++});
  assert.equal(calls, 0); busy = false;
  const work = h.poller.check(); assert.equal(calls, 1);
  [...h.timeouts][0](); await work; assert.equal(failures, 1);
  h.poller.stop();
});

test("a transient outage retries after the unchanged manifest recovers", async () => {
  let offline = false, calls = 0;
  const h = harness(async () => { calls++; if (offline) throw new Error("offline"); }, {
    manifestUrl: "manifest", readManifest: async () => {
      if (offline) throw new Error("offline");
      return {completed_at: "2026-09-27T12:00:00Z"};
    },
  });
  await settle();
  offline = true; h.tick(60000); await h.poller.check();
  offline = false; h.tick(60000); await h.poller.check();
  assert.equal(calls, 3);
  h.poller.stop();
});

test("snapshot loader bypasses cache and rejects HTTP errors and invalid payloads", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => { assert.equal(options.cache, "no-store"); return {ok: true, json: async () => ({rows: []})}; };
    assert.deepEqual(await fetchSnapshot("local", {validate: data => Array.isArray(data.rows)}), {rows: []});
    await assert.rejects(fetchSnapshot("local", {validate: () => false}), /incomplete/);
    await assert.rejects(fetchSnapshot("local", {validate: () => null}), /incomplete/);
    globalThis.fetch = async () => ({ok: false, status: 503});
    await assert.rejects(fetchSnapshot("local"), /503/);
  } finally { globalThis.fetch = original; }
});
