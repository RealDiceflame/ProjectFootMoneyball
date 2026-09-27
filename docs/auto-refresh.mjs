// Visitors poll saved site files, never upstream data providers or secret APIs.
export async function fetchSnapshot(url, {signal, validate} = {}) {
  const response = await fetch(url, {cache: "no-store", signal});
  if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
  const value = await response.json();
  signal?.throwIfAborted();
  if (validate && !validate(value)) throw new Error("Snapshot is incomplete");
  return value;
}

export const snapshotSignature = value => JSON.stringify(value);

export function preserveView(update, containers = []) {
  const active = document.activeElement, pageX = scrollX, pageY = scrollY;
  const positions = containers.map(element => [element, element.scrollTop, element.scrollLeft]);
  const attribute = ["id", "data-draft-key", "data-intel-key", "data-sort", "data-filter"].find(key => active?.hasAttribute(key));
  const value = attribute ? active.getAttribute(attribute) : null;
  update();
  if (attribute && !active.isConnected) {
    const replacement = [...document.querySelectorAll(`[${attribute}]`)].find(element => element.getAttribute(attribute) === value);
    replacement?.focus({preventScroll: true});
  }
  positions.forEach(([element, top, left]) => {element.scrollTop = top; element.scrollLeft = left;});
  window.scrollTo(pageX, pageY);
}

export function startAutoRefresh(refresh, {
  intervalMs = 60000,
  canRefresh = () => true,
  onError = () => {},
  onCheck = () => {},
  manifestUrl = "data/update_status.json",
  maxRefreshAgeMs = 15 * 60000,
  timeoutMs = 15000,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  timers = globalThis,
  now = () => Date.now(),
  readManifest = fetchSnapshot,
} = {}) {
  let stopped = false, inFlight = false, controller;
  let lastAttempt = -Infinity, lastRefresh = -Infinity, revision = null;
  const check = async () => {
    if (stopped || inFlight || documentRef?.hidden || !canRefresh() || now() - lastAttempt < intervalMs) return;
    inFlight = true; lastAttempt = now(); controller = new AbortController();
    const signal = controller.signal;
    const timeout = timers.setTimeout(() => controller.abort(new Error("Update check timed out")), timeoutMs);
    try {
      // Time-sensitive labels may expire without a new file being published.
      onCheck();
      let nextRevision = null;
      if (manifestUrl) {
        try {
          const manifest = await readManifest(manifestUrl, {signal});
          if (!Number.isFinite(Date.parse(manifest?.completed_at))) throw new Error("Update manifest is incomplete");
          nextRevision = manifest.completed_at;
        } catch (error) {
          signal.throwIfAborted();
          // A missing manifest must not stop direct snapshot recovery.
        }
      }
      if (nextRevision && revision === nextRevision && now() - lastRefresh < maxRefreshAgeMs) return;
      await refresh(signal);
      signal.throwIfAborted();
      revision = nextRevision; lastRefresh = now();
    } catch (error) {
      revision = null; // Recover even when the next manifest returns its old version.
      if (!stopped) onError(error);
    } finally {
      timers.clearTimeout(timeout); inFlight = false;
    }
  };
  const resume = () => { void check(); };
  const timer = timers.setInterval(resume, intervalMs);
  documentRef?.addEventListener("visibilitychange", resume);
  windowRef?.addEventListener("online", resume);
  windowRef?.addEventListener("pageshow", resume);
  void check();
  return {check, stop() {
    stopped = true; controller?.abort(); timers.clearInterval(timer);
    documentRef?.removeEventListener("visibilitychange", resume);
    windowRef?.removeEventListener("online", resume);
    windowRef?.removeEventListener("pageshow", resume);
  }};
}
