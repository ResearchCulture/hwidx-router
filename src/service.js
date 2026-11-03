const fs = require("fs");
const path = require("path");
const morgan = require("morgan");
const express = require("express");
const rateLimit = require("express-rate-limit");
const yaml = require("yaml");
const createApi = require("./api");
const createDataSync = require("./lib/data-sync");
const createStats = require("./lib/stats");
const createLinkCheck = require("./lib/link-check");
const { SEGMENT } = require("./lib/dataset");

console.log("Starting hwidx-router service...");

const app = express();
const PORT = process.env.PORT || 8080;
const CONFIG_ROOT = process.env.CONFIG_ROOT || "config";
const DEBUG = process.env.DEBUG || false;
const CACHE_ROOT = process.env.CACHE_ROOT || "cache";
const CACHE_CHECK_INTERVAL = parseInt(process.env.CACHE_CHECK_INTERVAL || "30", 10); // seconds; 0 disables
const DATA_REPO = process.env.DATA_REPO ?? "https://github.com/ResearchCulture/hwidx.git"; // empty disables syncing
const DATA_BRANCH = process.env.DATA_BRANCH || "main";
const DATA_SYNC_INTERVAL = parseInt(process.env.DATA_SYNC_INTERVAL || "300", 10); // seconds; 0 clones but never pulls
const API_RATE_LIMIT = parseInt(process.env.API_RATE_LIMIT || "300", 10); // API requests per IP per 15 minutes from outside the site; 0 removes the limit
const SITE_HOSTS = (process.env.SITE_HOSTS || "hwidx.org,m.hwidx.org").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean); // hosts whose pages count as hwidx.org's own traffic
const STATS_SAVE_INTERVAL = parseInt(process.env.STATS_SAVE_INTERVAL || "60", 10); // seconds; 0 saves only on shutdown
const LINK_CHECK_HOURS = parseFloat(process.env.LINK_CHECK_HOURS || "24"); // how long a link check stays fresh; 0 disables
const LINK_CHECK_TIMEOUT = parseInt(process.env.LINK_CHECK_TIMEOUT || "5", 10); // seconds to wait for a target to answer

// Per-identifier counts of redirects and metapage visits, kept alongside the index cache
const stats = createStats({ cacheRoot: CACHE_ROOT, saveIntervalMs: STATS_SAVE_INTERVAL * 1000 });

// Redirect targets are rechecked once their last check is stale, and visitors are sent to the metapage while one is down
const linkCheck = createLinkCheck({ cacheRoot: CACHE_ROOT, maxAgeMs: LINK_CHECK_HOURS * 3600 * 1000, timeoutMs: LINK_CHECK_TIMEOUT * 1000, debug: DEBUG });

// Only count well-formed identifiers, so paths like /1/.. that happen to resolve on disk never reach the stats
function countable(route) {
    return route.split("/").every((seg) => SEGMENT.test(seg));
}

// Requests arrive via the front proxy and the website's nginx (both on private docker networks),
// so take the client address from X-Forwarded-For, otherwise every visitor shares one rate limit bucket
app.set("trust proxy", "loopback, linklocal, uniquelocal");

// Configure request logging via 'morgan'
app.use( morgan("tiny") );

// Whether an API request comes from the site's own pages (the metapages, search and catalog fetching their data),
// as opposed to someone using the API directly. Browsers state this themselves: Sec-Fetch-Site can't be set by
// page scripts, and Origin/Referer name the page making the request. A script outside a browser can send
// these headers too, so this keeps the site's own visitors out of the limit rather than being a security boundary.
function fromSite(req) {
    if (req.get("sec-fetch-site") === "same-origin")
        return true;

    for (const header of ["origin", "referer"]) {
        try {
            if (SITE_HOSTS.includes(new URL(req.get(header)).hostname))
                return true;
        } catch {
            // Header missing or not a URL
        }
    }
    return false;
}

// Dataset API for the m.hwidx.org metapages and anyone else. The site's own pages (every metapage view is
// one or more API calls) are never limited; everyone else gets API_RATE_LIMIT per IP. This sits ahead of
// the general limiter below, which covers the redirects.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: API_RATE_LIMIT,
    skip: (req) => API_RATE_LIMIT <= 0 || fromSite(req),
    message: { error: "Rate limit exceeded, try again later" },
    standardHeaders: true,
    legacyHeaders: false,
});

// The API is mounted here so it stays ahead of the routes below, but is only filled in
// by start() once the dataset is in place, since building it reads the dataset
const apiRoutes = express.Router();
app.use("/api/v1", apiLimiter, apiRoutes);

// Basic rate limiting to prevent abuse
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(limiter);
//app.use(morgan('combined'));
//app.use(bodyParser.json());
//app.use(cors());

// Note that this may need additional work to be safe in production
function sanitizeInput(input) {
    if( input === null || input === undefined || input === "" )
        return null;
    
    return `${input}`.toLowerCase().replaceAll(/[/\\]/g, '');
}

// Health check (must be registered before the /:prefix route)
app.get( "/status", (req, res) => {
    return res.status(200).send('OK');
});

// Root requests go to the main site
app.get("/", (req, res) => {
  return res.redirect(302, "https://m.hwidx.org/");
});

// Prefix/Org level requests
app.get("/:prefix",async (req, res, next) => {
  const org = sanitizeInput(req.params.prefix);

  // Minimally we need an org to route _anything_
  if (org === null)
    return res.sendStatus(400);

  const thisPath = `https://hwidx.org/${org}`;
  const webPath = `https://m.hwidx.org/${org}`;
  const dataPath = path.join(CONFIG_ROOT, `${org}`);

  if (!fs.existsSync(dataPath)) {
    if (DEBUG)
      console.log(
        `Cannot route request for hwidx://${org} -> ??? (file not found: ${dataPath})`
      );
    return res.sendStatus(404);
  }

  if (countable(org))
    stats.metapage(org);
  return res.redirect(302, webPath);

});

// Unversioned device level requests (or legacy loookups)
app.get("/:prefix/:suffix", async (req, res, next) => {
  const org = sanitizeInput(req.params.prefix);
  const suffix = sanitizeInput(req.params.suffix);

  return await handleRequest(req, res, org, suffix, null);
});

// Versioned device level requests
app.get("/:prefix/:suffix/:version", async (req, res, next) => {
  const org = sanitizeInput(req.params.prefix);
  const suffix = sanitizeInput(req.params.suffix);
  const version = sanitizeInput(req.params.version);

  return await handleRequest(req, res, org, suffix, version);
});

async function handleRequest(req, res, org, suffix, version) {

  // Require at least two components, otherwise bail immediately
  if (org === null || suffix === null)
    return res.sendStatus(400);

  const route = ( version ? `${org}/${suffix}/${version}` : `${org}/${suffix}` );
  const thisPath = `https://hwidx.org/${route}`;
  const webPath = `https://m.hwidx.org/${route}`;
  const dataPath = path.join(CONFIG_ROOT, `${route}.yml`);

  if (!fs.existsSync(dataPath)) {
    if (DEBUG)
      console.log(
        `Cannot route request for hwidx://${route} -> ??? (file not found: ${dataPath})`
      );
    
    // Check to see if we might have metapages for this path...
    if( fs.existsSync(path.join(CONFIG_ROOT, `${route}`)) && fs.lstatSync(path.join(CONFIG_ROOT, `${route}`)).isDirectory() ) {
      if (DEBUG)
        console.log(
          `May have a metapage for hwidx://${route} routing to -> ${webPath}`
        );
      if (countable(route))
        stats.metapage(route);
      return res.redirect(302, `${webPath}`);
    }
    return res.sendStatus(404);
  }

  try {
    const data = yaml.parse(fs.readFileSync(dataPath, "utf8"));
    if (data === null || data === undefined) return res.sendStatus(500);

    if( data.status && data.status.toLowerCase() == "pending" ) {
      if (countable(route))
        stats.metapage(route);
      return res.redirect(302, webPath);
    }

    const redirect = data.url || null;
    if (redirect !== null && !(await linkCheck.resolves(route, redirect))) {
      if (DEBUG)
        console.log(`Target for hwidx://${route} -> ${redirect} is not resolving, routing to -> ${webPath}`);
      if (countable(route))
        stats.metapage(route);
      return res.redirect(302, `${webPath}?reason=link-down`); // the metapage explains why the visitor is here
    }

    if (redirect !== null) {
      if (DEBUG)
        console.log(
          `Routing request for hwidx://${route} -> ${dataPath} -> ${redirect}`
        );
      if (countable(route))
        stats.redirect(route);
      return res.redirect(302, redirect);
    }

    if (DEBUG)
      console.log(
        `Routing request for hwidx://${route} -> ${dataPath} -> ${webPath}`
      );
    if (countable(route))
      stats.metapage(route);
    return res.redirect(302, webPath);
  } catch (err) {
    console.error(`Error reading file at ${dataPath}:`, err);
    return res.sendStatus(500);
  }
}

app.use(async function(req, res){
    return res.status(404).send('Not Found');
});

let server = null;

// Clone or update the dataset first, so nothing is served from an empty data folder on first start
async function start() {
  await createDataSync({
    dataRoot: CONFIG_ROOT,
    repo: DATA_REPO,
    branch: DATA_BRANCH,
    intervalMs: DATA_SYNC_INTERVAL * 1000,
  }).start();

  apiRoutes.use(createApi(CONFIG_ROOT, {
    cacheRoot: CACHE_ROOT,
    linkCheckHours: LINK_CHECK_HOURS,
    checkIntervalMs: CACHE_CHECK_INTERVAL * 1000,
    stats,
  }));

  server = app.listen(PORT, () => {
    console.log(`hwidx-router service is running on port ${PORT}`);
  });
}

start();

function gracefulClose() {
  console.log("hwidx-router stopping...");
  server?.close();
  stats.save();
  linkCheck.save();

  console.log("hwidx-router stopped");
  process.exit( 0 );
}

process.on("SIGINT", gracefulClose);
process.on("SIGTERM", gracefulClose);


