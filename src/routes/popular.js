const LIMIT = 10;

// GET /popular: the most used identifiers, by router redirects and metapage visits combined.
//   ?period=week      "day", "week" (default) or "month"; the current calendar period
// Each entry links to both the identifier (which the router redirects) and its metapage,
// with its name and redirect target read live from the dataset and the same stats the entry endpoint returns.
// `redirect` is the documentation URL the router currently sends visitors to, or null when it sends them
// to the metapage instead (directories, pending entries, entries without a URL).
module.exports = function popular({ dataset, stats }) {
  return (req, res) => {
    const period = req.query.period ?? "week";
    if (!stats.PERIODS.includes(period))
      return res.status(400).json({ error: `Expected period of ${stats.PERIODS.join(", ")}` });

    const entries = stats.top(period, LIMIT).map(({ key, total, stats }) => ({
      key,
      hwidx: `https://hwidx.org/${key}`,
      metapage: `https://m.hwidx.org/${key}`,
      ...describe(dataset, key),
      total,
      stats,
    }));

    return res.json({ period, entries });
  };
};

// Entries carry their own name, organisations their org name, and devices take their latest version's
function describe(dataset, key) {
  const segs = key.split("/");
  try {
    const found = dataset.lookup(segs);
    if (found === null)
      return { name: null, redirect: null };

    if (found.type === "entry") {
      const { name, url, status } = found.data;
      const pending = typeof status === "string" && status.toLowerCase() === "pending";
      return { name: name ?? null, redirect: !pending && typeof url === "string" && url !== "" ? url : null };
    }

    const org = found.data.org;
    if (segs.length === 1 && org)
      return { name: typeof org === "string" ? org : org.name ?? null, redirect: null };
    return { name: dataset.latestName(segs), redirect: null };
  } catch {
    return { name: null, redirect: null };
  }
}
