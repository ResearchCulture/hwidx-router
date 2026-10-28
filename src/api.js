const express = require("express");
const { createDataset } = require("./lib/dataset");
const createIndexCache = require("./lib/index-cache");
const { currentVersionKeys } = require("./lib/versions");
const catalog = require("./routes/catalog");
const search = require("./routes/search");
const popular = require("./routes/popular");
const entry = require("./routes/entry");

// The /api/v1 dataset API: wires the dataset, its index cache and the usage stats into the route handlers
module.exports = function createApi(configRoot, { cacheRoot, checkIntervalMs, stats }) {
  const api = express.Router();
  const dataset = createDataset(configRoot);

  // Catalog and search read from this rather than the YAML files
  const cache = createIndexCache({
    configRoot,
    cacheRoot,
    checkIntervalMs,
    buildSummaries: () => {
      const summaries = dataset.allKeys().flatMap((key) => {
        try {
          return [dataset.summarise(key)];
        } catch (err) {
          console.error(`Leaving ${key} out of the index cache:`, err.message);
          return [];
        }
      });

      // Flag the current (highest semver) version of each device
      const current = currentVersionKeys(summaries.map((summary) => summary.key));
      return summaries.map((summary) => ({ ...summary, current: current.has(summary.key) }));
    },
  });

  // The dataset is public: allow any origin, and let caches hold responses briefly
  api.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=60");
    next();
  });

  // Named endpoints come before the identifier catch-all, which reserves
  // "catalog", "search" and "popular" (the first two already taken by m.hwidx.org pages)
  api.get("/catalog", catalog({ cache }));
  api.get("/search", search({ cache }));
  api.get("/popular", popular({ dataset, stats }));
  api.get("/{*path}", entry({ dataset, stats }));

  return api;
};
