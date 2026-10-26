const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// On-disk column store of the index, used by the catalog and search, rebuilt whenever the dataset changes.
//
//   <cacheRoot>/current           name of the live generation directory (swapped atomically)
//   <cacheRoot>/v3-<hash>/
//     manifest.json               format, dataset fingerprint, build time, row count
//     keys.txt                    one identifier per line, newest first
//     names.txt                   the matching lower-cased names, for search
//     orgs.txt                    the matching lower-cased organisation and group names, for search
//     summaries.jsonl             the matching listing entries (with their current-version flag), exactly as the API returns them
//
// Line N of every column is the same entry, so a search scans the small key, name and org columns
// and only parses the summaries for the page it returns. No YAML is parsed unless the dataset changed.

const FORMAT = 3;
const COLUMNS = { keys: "keys.txt", names: "names.txt", orgs: "orgs.txt", summaries: "summaries.jsonl" };
const GENERATION = /^v\d+-[0-9a-f]+$/;

function normaliseName(name) {
  return typeof name === "string" ? name.toLowerCase().replace(/\s+/g, " ").trim() : "";
}

// org and group are usually { name, url }, but a plain string is accepted too
function displayName(value) {
  return typeof value === "string" ? value : value?.name;
}

// Organisation and group names joined by a space, so no single search term can match across the two
function orgText(summary) {
  return normaliseName([displayName(summary.org), displayName(summary.group)].filter(Boolean).join(" "));
}

module.exports = function createIndexCache({ configRoot, cacheRoot, buildSummaries, checkIntervalMs }) {
  let current = null; // { fingerprint, keys, names, orgs, summaries }

  // Cheap change detection: path, size and mtime of every YAML file (index.yml included), without parsing any
  function fingerprint() {
    const hash = crypto.createHash("sha256");
    const walk = (dir) => {
      const dirents = fs.readdirSync(path.join(configRoot, dir), { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const dirent of dirents) {
        if (dirent.name.startsWith("."))
          continue;

        const rel = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          walk(rel);
        } else if (dirent.isFile() && dirent.name.endsWith(".yml")) {
          const stat = fs.statSync(path.join(configRoot, rel));
          hash.update(`${rel}\0${stat.size}\0${stat.mtimeMs}\n`);
        }
      }
    };
    walk("");
    return hash.digest("hex");
  }

  function readColumn(dir, file) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    return text === "" ? [] : text.split("\n");
  }

  // The generation on disk, if it was built from this exact dataset
  function load(fp) {
    const generation = fs.readFileSync(path.join(cacheRoot, "current"), "utf8").trim();
    if (!GENERATION.test(generation))
      return null;

    const dir = path.join(cacheRoot, generation);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    if (manifest.format !== FORMAT || manifest.fingerprint !== fp)
      return null;

    const snapshot = { fingerprint: fp };
    for (const column of Object.keys(COLUMNS))
      snapshot[column] = readColumn(dir, COLUMNS[column]);

    const intact = Object.keys(COLUMNS).every((column) => snapshot[column].length === manifest.count);
    return intact ? snapshot : null;
  }

  function write(snapshot) {
    const generation = `v${FORMAT}-${snapshot.fingerprint.slice(0, 16)}`;
    const dir = path.join(cacheRoot, generation);

    // Clear any half-written leftover of this generation, then write the manifest last
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const column of Object.keys(COLUMNS))
      fs.writeFileSync(path.join(dir, COLUMNS[column]), snapshot[column].join("\n"));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      format: FORMAT,
      fingerprint: snapshot.fingerprint,
      built_at: new Date().toISOString(),
      count: snapshot.keys.length,
    }, null, 2));

    // Point readers at the new generation in one rename, then drop the superseded ones
    const pointer = path.join(cacheRoot, `current.${process.pid}.tmp`);
    fs.writeFileSync(pointer, generation);
    fs.renameSync(pointer, path.join(cacheRoot, "current"));

    for (const name of fs.readdirSync(cacheRoot)) {
      if (GENERATION.test(name) && name !== generation)
        fs.rmSync(path.join(cacheRoot, name), { recursive: true, force: true });
    }
  }

  function refresh() {
    const fp = fingerprint();
    if (current !== null && current.fingerprint === fp)
      return;

    // On startup, reuse what a previous run left on the cache volume
    if (current === null) {
      try {
        const loaded = load(fp);
        if (loaded !== null) {
          current = loaded;
          console.log(`Loaded index cache from ${cacheRoot} (${loaded.keys.length} entries)`);
          return;
        }
      } catch {
        // No usable cache on disk yet; build one below
      }
    }

    const started = Date.now();
    const summaries = buildSummaries();
    current = {
      fingerprint: fp,
      keys: summaries.map((summary) => summary.key),
      names: summaries.map((summary) => normaliseName(summary.name)),
      orgs: summaries.map(orgText),
      summaries: summaries.map((summary) => JSON.stringify(summary)),
    };
    console.log(`Rebuilt index cache (${summaries.length} entries) in ${Date.now() - started} ms`);

    try {
      write(current);
    } catch (err) {
      console.error(`Could not write index cache to ${cacheRoot}, keeping it in memory only: ${err.message}`);
    }
  }

  function safeRefresh() {
    try {
      refresh();
    } catch (err) {
      console.error("Index cache refresh failed:", err);
    }
  }

  safeRefresh();
  if (checkIntervalMs > 0)
    setInterval(safeRefresh, checkIntervalMs).unref();

  return {
    // The current snapshot, or null if the index has never been built
    snapshot: () => current,
  };
};
