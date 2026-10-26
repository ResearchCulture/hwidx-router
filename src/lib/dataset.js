const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

// A single path segment of an identifier. Leading dots are refused so that
// dotfiles in the dataset (.git, .github, ...) can never be reached.
const SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/;

const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readYaml(p) {
  return yaml.parse(fs.readFileSync(p, "utf8")) ?? {};
}

// Read access to the YAML dataset. Identifiers are handled as arrays of path segments.
function createDataset(configRoot) {
  // Merge every index.yml from the dataset root down to (and including) the given directory
  function cascade(segs) {
    let merged = {};
    for (let i = 0; i <= segs.length; i++) {
      const indexPath = path.join(configRoot, ...segs.slice(0, i), "index.yml");
      if (isFile(indexPath))
        merged = { ...merged, ...readYaml(indexPath) };
    }
    return merged;
  }

  // Resolve an identifier the same way the router does: a .yml entry wins over a directory
  function lookup(segs) {
    if (segs.length > 0) {
      const entryPath = path.join(configRoot, `${segs.join("/")}.yml`);
      if (isFile(entryPath))
        return { type: "entry", data: { ...cascade(segs.slice(0, -1)), ...readYaml(entryPath) } };
    }

    if (isDir(path.join(configRoot, ...segs)))
      return { type: "directory", data: cascade(segs) };

    return null;
  }

  function listChildren(segs) {
    return fs.readdirSync(path.join(configRoot, ...segs), { withFileTypes: true })
      .flatMap((dirent) => {
        if (dirent.isDirectory() && SEGMENT.test(dirent.name))
          return [{ slug: dirent.name, type: "directory" }];

        if (dirent.isFile() && dirent.name.endsWith(".yml") && dirent.name !== "index.yml") {
          const slug = dirent.name.slice(0, -".yml".length);
          if (SEGMENT.test(slug))
            return [{ slug, type: "entry" }];
        }

        return [];
      })
      .sort((a, b) => byVersion(a.slug, b.slug));
  }

  // Every entry beneath a directory, as path segment arrays
  function allEntries(segs) {
    const leaves = [];
    const walk = (dir) => listChildren(dir).forEach((child) =>
      child.type === "entry" ? leaves.push([...dir, child.slug]) : walk([...dir, child.slug])
    );
    walk(segs);
    return leaves;
  }

  // Every entry key, newest identifiers first
  function allKeys() {
    return allEntries([]).map((segs) => segs.join("/")).sort(byVersion).reverse();
  }

  // Name of the highest-versioned entry beneath a directory, used to label devices
  function latestName(segs) {
    const leaves = allEntries(segs);
    const version = (leaf) => leaf.slice(segs.length).join("/");
    leaves.sort((a, b) => byVersion(version(b), version(a)));

    for (const leaf of leaves) {
      const name = lookup(leaf)?.data.name;
      if (name)
        return name;
    }
    return null;
  }

  // The listing form of an entry, shared by the catalog and search
  function summarise(key) {
    const { data } = lookup(key.split("/"));
    return {
      key,
      hwidx: `https://hwidx.org/${key}`,
      name: data.name ?? null,
      org: data.org ?? null,
      group: data.group ?? null,
    };
  }

  return { lookup, listChildren, allKeys, latestName, summarise };
}

module.exports = { SEGMENT, createDataset };
