// Optional reporting of router and API usage to Simple Analytics, as server-side events
// (https://docs.simpleanalytics.com/events/server-side). Off unless SA_HOSTNAME is set to a website
// registered in the Simple Analytics dashboard.
//
// Events sent:
//   hwidx_redirect  the router sent a visitor on to an identifier's documentation
//   hwidx_metapage  the router sent a visitor to the metapage instead (metadata.reason says why)
//   hwidx_api       a /api/v1 request from outside the site's own pages (metadata: endpoint, method, status)
//
// Best effort, and never in a request's path: the post is started on a later turn of the event loop,
// after the redirect or API response has gone out. At most maxInFlight posts (SA_MAX_IN_FLIGHT) run at once; while that
// many are outstanding, new events are simply dropped, so a slow or unreachable Simple Analytics can
// never build up memory or sockets. No IP addresses or query strings are sent.

const ENDPOINT = "https://queue.simpleanalyticscdn.com/events";
const DEFAULT_MAX_IN_FLIGHT = 16;

// maxInFlight is a plain integer of at least 1; parsing and validating it is the caller's job
module.exports = function createAnalytics({ hostname, maxInFlight = DEFAULT_MAX_IN_FLIGHT, timeoutMs = 3000, debug = false }) {
  const enabled = Boolean(hostname);
  if (enabled)
    console.log(`Reporting router and API usage to Simple Analytics as ${hostname} (at most ${maxInFlight} posts in flight)`);

  let inFlight = 0;
  let dropped = 0;

  function send(req, event, path, metadata) {
    if (!enabled)
      return;

    // Too many posts outstanding: forget this one
    if (inFlight >= maxInFlight) {
      dropped += 1;
      return;
    }

    const body = {
      type: "event",
      hostname,
      event,
      path,
      metadata,
      // Lets Simple Analytics work out the browser/device and filter out bots
      ua: req.get("user-agent") || "unknown",
    };

    // Counted now so the limit holds, but only started once the current handler has sent its response
    inFlight += 1;
    setImmediate(() => post(body));
  }

  function post(body) {
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": body.ua },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((res) => {
        if (debug && !res.ok)
          console.log(`Simple Analytics rejected ${body.event} for ${body.path}: HTTP ${res.status}`);
      })
      .catch((err) => {
        if (debug)
          console.log(`Could not send ${body.event} for ${body.path} to Simple Analytics: ${err.message}`);
      })
      .finally(() => {
        inFlight -= 1;
        if (debug && dropped > 0 && inFlight === 0) {
          console.log(`Dropped ${dropped} Simple Analytics events while ${maxInFlight} were in flight`);
          dropped = 0;
        }
      });
  }

  return {
    redirect: (req, route) => send(req, "hwidx_redirect", `/${route}`, { key: route }),
    metapage: (req, route, reason = "metapage") => send(req, "hwidx_metapage", `/${route}`, { key: route, reason }),

    // Middleware for /api/v1: reports each request once its response is finished, so the status is known
    // (including 429s from the rate limiter, as long as this sits ahead of it). `skip` leaves out the
    // site's own calls, which its page views already cover.
    api: ({ skip = () => false } = {}) => (req, res, next) => {
      if (enabled && !skip(req)) {
        res.on("finish", () => {
          // First path segment only: "catalog", "search", "popular", or "entry" for identifier lookups
          const first = req.path.split("/").filter(Boolean)[0] ?? "";
          const endpoint = ["catalog", "search", "popular"].includes(first) ? first : "entry";
          send(req, "hwidx_api", `/api/v1${req.path}`, { endpoint, method: req.method, status: res.statusCode });
        });
      }
      next();
    },
  };
};
