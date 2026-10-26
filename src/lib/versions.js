const coerce = require("semver/functions/coerce");
const compare = require("semver/functions/compare");

// Version slugs as semver, coercing the short forms the index uses ("0.9" -> 0.9.0, "1.2-rc0" -> 1.2.0-rc0).
// Prereleases are kept, so 1.2-rc0 sorts before 1.2 as semver requires.
function parse(slug) {
  return coerce(slug, { includePrerelease: true });
}

// Oldest first. Slugs that aren't versions at all sort before those that are;
// ties (e.g. "1.0" and "1.0.0") fall back to numeric-aware text order.
function compareVersions(a, b) {
  const va = parse(a);
  const vb = parse(b);
  if (va && vb) {
    const order = compare(va, vb);
    if (order !== 0)
      return order;
  } else if (va || vb) {
    return va ? 1 : -1;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

// Keys of the current (highest) version of each device. Only versioned identifiers count,
// i.e. org/device/version or deeper; legacy two-part identifiers have no versions.
function currentVersionKeys(keys) {
  const latest = new Map();
  for (const key of keys) {
    const segs = key.split("/");
    if (segs.length < 3)
      continue;

    const device = segs.slice(0, -1).join("/");
    const slug = segs[segs.length - 1];
    if (!latest.has(device) || compareVersions(slug, latest.get(device)) > 0)
      latest.set(device, slug);
  }
  return new Set([...latest].map(([device, slug]) => `${device}/${slug}`));
}

module.exports = { compareVersions, currentVersionKeys };
