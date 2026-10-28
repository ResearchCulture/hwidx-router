const fs = require("fs");
const path = require("path");

// Usage counters for the router: how often each identifier was redirected to its documentation
// ("redirects") and how often the router sent visitors to its metapage instead ("metapage").
//
// Counts are kept for the current day (midnight to midnight), week (Monday to Sunday) and month,
// in the server's local time (set TZ to change it), and reset when each period rolls over.
// They are held in memory and saved to <cacheRoot>/stats.json, so restarts keep them.
// Only identifiers that exist in the dataset are ever counted, so the table stays bounded.

const FORMAT = 1;
const KINDS = ["redirects", "metapage"];
const PERIODS = ["day", "week", "month"];
const MIN_ELAPSED = 0.25; // fraction of a period the projections always assume has passed

// Start and end (exclusive) of the period containing `now`, in local time
function bounds(period, now) {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (period) {
    case "day":
      return [new Date(y, m, d), new Date(y, m, d + 1)];
    case "week": {
      const monday = d - ((now.getDay() + 6) % 7);
      return [new Date(y, m, monday), new Date(y, m, monday + 7)];
    }
    case "month":
      return [new Date(y, m, 1), new Date(y, m + 1, 1)];
  }
}

function emptyCounts() {
  return Object.fromEntries(KINDS.map((kind) => [kind, Object.fromEntries(PERIODS.map((period) => [period, 0]))]));
}

module.exports = function createStats({ cacheRoot, saveIntervalMs }) {
  const file = path.join(cacheRoot, "stats.json");
  let starts = {}; // period -> start time (ms) the counts belong to
  let counts = new Map(); // key -> { redirects: { day, week, month }, metapage: { ... } }
  let dirty = false;

  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.format === FORMAT) {
      starts = saved.starts;
      counts = new Map(Object.entries(saved.counts));
      console.log(`Loaded usage stats from ${file} (${counts.size} identifiers)`);
    }
  } catch {
    // No saved stats yet; start from zero
  }

  // Zero any period that has rolled over since the counts were taken, and forget identifiers left at zero
  function roll(now = new Date()) {
    const rolled = PERIODS.filter((period) => starts[period] !== bounds(period, now)[0].getTime());
    if (rolled.length === 0)
      return;

    for (const period of rolled)
      starts[period] = bounds(period, now)[0].getTime();

    for (const [key, entry] of counts) {
      for (const kind of KINDS)
        for (const period of rolled)
          entry[kind][period] = 0;

      if (KINDS.every((kind) => entry[kind].month === 0 && entry[kind].week === 0))
        counts.delete(key);
    }
    dirty = true;
  }

  function record(key, kind) {
    roll();
    const entry = counts.get(key) ?? emptyCounts();
    for (const period of PERIODS)
      entry[kind][period] += 1;
    counts.set(key, entry);
    dirty = true;
  }

  // Each period's count so far, plus a straight-line projection of where it will end up. Kept conservative:
  // the rate is never taken over less than a quarter of the period, so a few early visits can't project wildly
  // (1 visit at 00:30 projects to 4 for the day, not 48), and rounds down rather than up.
  function describe(entry, now) {
    return Object.fromEntries(KINDS.map((kind) => [kind, Object.fromEntries(PERIODS.map((period) => {
      const [start, end] = bounds(period, now);
      const elapsed = Math.max((now - start) / (end - start), MIN_ELAPSED);
      const count = entry?.[kind][period] ?? 0;
      return [period, {
        count,
        projected: Math.max(count, Math.floor(count / elapsed)),
        since: start.toISOString(),
        resets: end.toISOString(),
      }];
    }))]));
  }

  function of(key) {
    const now = new Date();
    roll(now);
    return describe(counts.get(key), now);
  }

  // The `limit` identifiers with the most redirects and metapage visits combined in the given period
  function top(period, limit) {
    const now = new Date();
    roll(now);
    const total = (entry) => KINDS.reduce((sum, kind) => sum + entry[kind][period], 0);
    return [...counts]
      .filter(([, entry]) => total(entry) > 0)
      .sort(([a, x], [b, y]) => total(y) - total(x) || a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, limit)
      .map(([key, entry]) => ({ key, total: total(entry), stats: describe(entry, now) }));
  }

  // Written to a temporary file and renamed, so a crash mid-write never leaves a broken stats.json
  function save() {
    if (!dirty)
      return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, starts, counts: Object.fromEntries(counts) }));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (err) {
      console.error(`Could not save usage stats to ${file}: ${err.message}`);
    }
  }

  roll();
  if (saveIntervalMs > 0)
    setInterval(save, saveIntervalMs).unref();

  return {
    redirect: (key) => record(key, "redirects"),
    metapage: (key) => record(key, "metapage"),
    of,
    top,
    save,
    PERIODS,
  };
};
