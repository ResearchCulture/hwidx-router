const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 120 * 1000;

// Keeps the data folder as a clone of the upstream dataset repository: clones it on first start,
// then fetches and hard-resets to the branch head periodically. Full clones rather than shallow ones,
// as the dataset is small and shallow fetches fail on filesystems with unstable stat data (some bind mounts).
// The folder belongs to the router, so any local edits in it are discarded on sync.
module.exports = function createDataSync({ dataRoot, repo, branch, intervalMs }) {
  let running = false;

  // The data folder is the router's own, so trust it explicitly: bind mounts can report other
  // owners for files the router created (e.g. Docker Desktop on macOS), which git would refuse
  const trust = ["-c", `safe.directory=${path.resolve(dataRoot)}`];

  async function git(...args) {
    const { stdout } = await run("git", [...trust, ...args], { cwd: dataRoot, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  }

  async function sync() {
    if (!fs.existsSync(path.join(dataRoot, ".git"))) {
      if (fs.readdirSync(dataRoot).length > 0) {
        console.error(`Data sync: ${dataRoot} has files but is not a git clone, leaving it alone`);
        return;
      }

      console.log(`Data sync: cloning ${repo} (${branch}) into ${dataRoot}...`);
      await git("clone", "--quiet", "--branch", branch, repo, ".");
      console.log(`Data sync: cloned at ${await git("rev-parse", "--short", "HEAD")}`);
      return;
    }

    const before = await git("rev-parse", "HEAD");
    await git("fetch", "--quiet", "origin", branch);
    await git("reset", "--quiet", "--hard", "FETCH_HEAD");
    const after = await git("rev-parse", "HEAD");

    if (before !== after)
      console.log(`Data sync: updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
  }

  async function safeSync() {
    if (running)
      return;

    running = true;
    try {
      await sync();
    } catch (err) {
      console.error(`Data sync failed, serving the existing data: ${(err.stderr || err.message).trim()}`);
    } finally {
      running = false;
    }
  }

  // Resolves once the first sync has finished (or failed), so the dataset is in place before it is read
  async function start() {
    if (!repo) {
      console.log("Data sync: DATA_REPO is empty, serving the data folder as-is");
      return;
    }

    try {
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.accessSync(dataRoot, fs.constants.W_OK);
    } catch {
      console.log(`Data sync: ${dataRoot} is not writable (read-only mount?), serving it as-is`);
      return;
    }

    await safeSync();
    if (intervalMs > 0)
      setInterval(safeSync, intervalMs).unref();
  }

  return { start };
};
