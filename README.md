# hwidx-router

The router behind [hwidx.org](https://hwidx.org), the Hardware Index: stable, shareable identifiers for hardware artifacts. It turns an identifier such as `hwidx.org/1/0/0.9` into a redirect to that artifact's documentation, and serves the read-only dataset API used by the [m.hwidx.org](https://m.hwidx.org) metapages.

The identifiers themselves live in the separate [hwidx dataset repository](https://github.com/ResearchCulture/hwidx), one YAML file per artifact. The router clones that repository on start and keeps it up to date.

## How routing works

| Request | Result |
| --- | --- |
| `/` | Redirect to `https://m.hwidx.org/` |
| `/<org>` | Redirect to the organisation's metapage (404 if the organisation doesn't exist) |
| `/<org>/<device>` and `/<org>/<device>/<version>` | Redirect to the `url` in the entry's YAML file |
| `/status` | `200 OK`, for health checks |
| `/api/v1/...` | The dataset API (see below) |

An identifier is sent to its metapage (`https://m.hwidx.org/<identifier>`) instead of its documentation when:

- it is a directory rather than an entry (for example a device with several versions),
- the entry's `status` is `pending`,
- the entry has no `url`, or
- its `url` has stopped resolving. The router checks each target (rechecking once the last check is older than `LINK_CHECK_HOURS`) and adds `?reason=link-down`, so the metapage can explain.

Unknown identifiers return 404. Redirects are limited to 100 requests per IP per 15 minutes.

### Dataset entries

The only field the router reads is `url`. Everything else is free-form metadata.

```yaml
# config/1/0/0.9.yml
title: "Example Device Board v1"
url: "https://example.com/docs/example-device"
```

## API

All under `/api/v1`, returning JSON with open CORS and a 60 second cache.

| Endpoint | Description |
| --- | --- |
| `GET /catalog` | Paged list of entries. `page`, `per_page` (default 50, max 100), `order` (`desc` newest first, or `asc`). |
| `GET /search?q=...` | Search by identifier (any pasted hwidx URL form), device name or organisation. `field` is `all`, `id`, `name` or `org`; paged like the catalog. |
| `GET /popular` | Most used identifiers. `period` is `day`, `week` (default) or `month`. |
| `GET /<identifier>` | One entry or directory with its metadata, usage stats, link check result and (for versions) neighbouring versions. |

Requests from outside the site's own pages are limited to `API_RATE_LIMIT` per IP per 15 minutes.

```sh
curl 'https://hwidx.org/api/v1/search?q=gamepad'
curl 'https://hwidx.org/api/v1/1/0/0.9'
```

## Running

### Docker (recommended)

```sh
docker compose up -d
```

[docker-compose.yml](docker-compose.yml) pulls `ghcr.io/researchculture/hwidx-router:latest`, publishes port 8080 and expects an external Docker network named `http` (`docker network create http`). Two folders are mounted:

- `/hwidx/config`: the dataset clone. The compose file mounts `../hwidx` (a sibling checkout) read-only, so point it wherever your dataset lives, or leave it unmounted to let the router clone `DATA_REPO` itself.
- `/hwidx/cache`: the index cache, usage stats and link check state, kept between restarts (`HWIDX_CACHE_PATH`, default `./cache`).

The container starts as root only to fix ownership of those folders, then runs as the unprivileged `node` user ([hwidx-entrypoint.sh](hwidx-entrypoint.sh)).

### Locally

Requires Node.js and git.

```sh
cd src
npm install
node service.js
```

On first start the dataset is cloned into `src/config` (and the cache goes in `src/cache`). Then try `http://localhost:8080/status`.

To work against a local dataset checkout instead of cloning, point the router at it and turn syncing off:

```sh
DATA_REPO= CONFIG_ROOT=../../hwidx DEBUG=1 node service.js
```

## Configuration

Everything is set through environment variables. Whole-number settings that are malformed (or below their minimum) log a warning and use the default.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. |
| `DEBUG` | off | Set to anything to log routing decisions. |
| `CONFIG_ROOT` | `config` | Folder holding the dataset. |
| `CACHE_ROOT` | `cache` | Folder for the index cache, stats and link check state. |
| `DATA_REPO` | the hwidx dataset on GitHub | Git repository to clone into `CONFIG_ROOT`. Set empty to disable syncing. |
| `DATA_BRANCH` | `main` | Branch to follow. |
| `DATA_SYNC_INTERVAL` | `300` | Seconds between pulls. `0` clones but never pulls. Local edits to the clone are discarded. |
| `CACHE_CHECK_INTERVAL` | `30` | Seconds between checks for dataset changes to rebuild the index cache. `0` disables. |
| `API_RATE_LIMIT` | `300` | API requests per IP per 15 minutes from outside the site. `0` removes the limit. |
| `SITE_HOSTS` | `hwidx.org,m.hwidx.org` | Comma-separated hosts whose pages count as the site's own traffic (not limited or reported). |
| `STATS_SAVE_INTERVAL` | `60` | Seconds between saves of the usage stats. `0` saves only on shutdown. |
| `LINK_CHECK_HOURS` | `24` | How long a link check stays fresh. `0` disables checking. |
| `LINK_CHECK_TIMEOUT` | `5` | Seconds to wait for a target to answer. |
| `SA_HOSTNAME` | empty | Simple Analytics website to report usage to. Empty disables reporting. |
| `SA_MAX_IN_FLIGHT` | `16` | Simple Analytics posts outstanding at once (at least 1). Events past this are dropped. |

The router trusts `X-Forwarded-For` from private addresses, so it should sit behind a reverse proxy on a private network. Otherwise every visitor is seen from one address.

## Usage reporting

The router keeps per-identifier counts of redirects and metapage visits (shown in the API and used for `/popular`). If `SA_HOSTNAME` is set it also sends `hwidx_redirect`, `hwidx_metapage` and `hwidx_api` events to [Simple Analytics](https://docs.simpleanalytics.com/events/server-side). This is best effort and never delays a response. No IP addresses or query strings are sent.

## Project layout

```
src/
  service.js        Express app: configuration, routing, rate limits, startup
  api.js            /api/v1 wiring
  routes/           catalog, search, popular and entry handlers
  lib/              dataset access, git sync, index cache, link checks, stats, analytics
hwidx-entrypoint.sh Container entrypoint
Dockerfile
```

A GitHub Actions workflow publishes the image to `ghcr.io` on every push to `main`. There are no automated tests yet.

## License

MIT, see [LICENSE](LICENSE).
