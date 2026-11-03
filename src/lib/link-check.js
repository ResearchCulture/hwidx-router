const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Checks that the URLs the router redirects to still resolve.
//
// Each link is probed when a visitor asks for it and its last check is stale (older than `maxAgeMs`, or it has
// never been checked). That visitor waits for the probe, which is kept short by `timeoutMs`; everyone after them
// uses the saved result until it goes stale again. Visitors arriving during a probe share it rather than starting
// another. Links nobody asks for are never probed.
//
// A response is "up" if it is a success or a redirect (anything below 400); it is "down" if it is a 4xx/5xx
// status or the request fails outright (DNS, refused, timeout). A link whose hash changes but is still up keeps
// being redirected to; a link that is down sends visitors to the metapage until a later check finds it up again.
//
// The hash covers the status and the headers that describe the content, not the body, so nothing is downloaded.
// Results are kept in memory and saved to <cacheRoot>/link-check.json, so a restart keeps using them instead of
// probing every link afresh (a "check storm") just as a busy router comes back up.

// Says who we are and where to read about it; the page at this address is hwidx-website/src/link-checker.md
const USER_AGENT = "hwidx-linkcheck/1.0 (+https://m.hwidx.org/link-checker/)";
const FORMAT = 2;
const HASHED_HEADERS = ["content-type", "content-length", "etag", "last-modified", "location"];

module.exports = function createLinkCheck({ cacheRoot, maxAgeMs, timeoutMs, debug = false, fetchFn = fetch, now = Date.now }) {
  const file = path.join(cacheRoot, "link-check.json");
  const links = new Map(); // key -> { url, up, status, hash, checkedAt, pending }
  let dirty = false;

  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.format === FORMAT) {
      for (const [key, link] of Object.entries(saved.links))
        links.set(key, { ...link, pending: null });
      console.log(`Loaded link check state from ${file} (${links.size} links)`);
    }
  } catch {
    // No saved state yet; every link is checked on its first visit
  }

  // Written to a temporary file and renamed, so a crash mid-write never leaves a broken link-check.json
  function save() {
    if (!dirty)
      return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      const plain = Object.fromEntries([...links].map(([key, { url, up, status, hash, checkedAt }]) => [key, { url, up, status, hash, checkedAt }]));
      fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, links: plain }));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (err) {
      console.error(`Could not save link check state to ${file}: ${err.message}`);
    }
  }

  async function probe(url) {
    const response = await fetchFn(url, {
      redirect: "manual", // a redirect is a link that resolves; following it would check someone else's page
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT },
    });
    response.body?.cancel().catch(() => {}); // only the headers are wanted

    const material = [response.status, ...HASHED_HEADERS.map((name) => `${name}=${response.headers.get(name) ?? ""}`)];
    return {
      status: response.status,
      up: response.status < 400,
      hash: crypto.createHash("sha256").update(material.join("\n")).digest("hex"),
    };
  }

  async function check(key, link) {
    let result;
    try {
      result = await probe(link.url);
    } catch (err) {
      result = { status: null, up: false, hash: null, error: err.cause?.code ?? err.name };
    }

    // One line per check: what came back, whether it changed since the last one, and what visitors now get
    const response = result.status ?? `no answer: ${result.error}`;
    const was = link.checkedAt === null ? "first check" : link.up === result.up ? null : `was ${link.up ? "up" : "down"}`;
    const changed = result.hash === null ? "none" : link.checkedAt === null || link.hash === result.hash ? "unchanged" : "changed";
    const action = result.up ? "redirecting to the target" : "routing to the metapage";
    console.log(`Link check hwidx://${key} -> ${link.url}: ${response} (${result.up ? "up" : "down"}${was ? `, ${was}` : ""}; headers ${changed}), ${action}`);

    Object.assign(link, { up: result.up, status: result.status, hash: result.hash, checkedAt: now() });
    dirty = true;
    save();
  }

  // Whether to go ahead and redirect to `url` for `key` (true), or send the visitor to the metapage instead (false).
  // Checks the link first if its last check is stale.
  async function resolves(key, url) {
    if (maxAgeMs <= 0)
      return true;

    let link = links.get(key);
    if (link === undefined || link.url !== url) { // a new entry, or one whose url was edited
      link = { url, up: true, status: null, hash: null, checkedAt: null, pending: null };
      links.set(key, link);
    }

    if (link.pending === null && (link.checkedAt === null || now() - link.checkedAt >= maxAgeMs))
      link.pending = check(key, link).finally(() => { link.pending = null; });

    await link.pending;
    return link.up;
  }

  return { resolves, save };
};

module.exports.USER_AGENT = USER_AGENT;
