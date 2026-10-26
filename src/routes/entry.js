const { SEGMENT } = require("../lib/dataset");
const { compareVersions } = require("../lib/versions");

// Where a versioned entry (org/device/version) sits among its device's versions, in semver order:
// its position, the neighbouring versions and the current (highest) one
function versionsOf(dataset, segs) {
  const deviceSegs = segs.slice(0, -1);
  const slugs = dataset.listChildren(deviceSegs)
    .filter((child) => child.type === "entry")
    .map((child) => child.slug)
    .sort(compareVersions);

  const at = slugs.indexOf(segs[segs.length - 1]);
  const describe = (slug) => {
    if (slug === undefined)
      return null;
    const key = [...deviceSegs, slug].join("/");
    return { key, slug, name: dataset.lookup(key.split("/"))?.data.name ?? null };
  };

  return {
    count: slugs.length,
    position: at + 1,
    previous: describe(slugs[at - 1]),
    next: describe(slugs[at + 1]),
    current: describe(slugs[slugs.length - 1]),
  };
}

// GET /<identifier>: one entry or directory, read live from the dataset (never from the cache),
// with cascaded index.yml data. Directories also list their children with display names;
// versioned entries say where they sit among their device's versions.
module.exports = function entry({ dataset }) {
  return (req, res) => {
    const segs = (req.params.path ?? []).filter(Boolean).map((s) => s.toLowerCase());
    if (!segs.every((s) => SEGMENT.test(s)))
      return res.status(400).json({ error: "Invalid identifier" });

    const key = segs.join("/");

    try {
      const found = dataset.lookup(segs);
      if (found === null)
        return res.status(404).json({ error: "Not found", key });

      const record = {
        key,
        type: found.type,
        hwidx: `https://hwidx.org/${key}`,
        parent: segs.length > 1 ? segs.slice(0, -1).join("/") : null,
        data: found.data,
      };

      if (found.type === "entry" && segs.length >= 3)
        record.versions = versionsOf(dataset, segs);

      if (found.type === "directory") {
        record.children = dataset.listChildren(segs).map(({ slug, type }) => {
          const childSegs = [...segs, slug];
          const name = type === "entry" ? dataset.lookup(childSegs).data.name ?? null : dataset.latestName(childSegs);
          return { slug, key: childSegs.join("/"), type, name };
        });
      }

      return res.json(record);
    } catch (err) {
      console.error(`Error resolving API request for ${key}:`, err);
      return res.status(500).json({ error: "Internal error", key });
    }
  };
};
