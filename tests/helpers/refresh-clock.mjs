// Install after page.clock.install and before navigation. Observe the poller's
// real watchdog: its finally block clears the timer after fetch, parse and render.
// Never advance another simulated minute while the previous check is in flight.
export async function observeRefreshChecks(page) {
  await page.addInitScript(() => {
    const setTimeout = window.setTimeout.bind(window), clearTimeout = window.clearTimeout.bind(window);
    const checks = window.labRefreshChecks = {started: 0, pending: new Set()};
    window.setTimeout = (callback, delay, ...args) => {
      const id = setTimeout(callback, delay, ...args);
      if (delay === 15000) { checks.started++; checks.pending.add(id); }
      return id;
    };
    window.clearTimeout = id => { checks.pending.delete(id); return clearTimeout(id); };
  });
}
export const completedRefreshChecks = page => page.evaluate(() => window.labRefreshChecks.started);
export const waitForRefreshCheck = (page, after = 0) => page.waitForFunction(previous =>
  window.labRefreshChecks.started > previous && window.labRefreshChecks.pending.size === 0, after);
