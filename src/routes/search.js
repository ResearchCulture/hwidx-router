const { MAX_PAGE_SIZE, parsePaging, pageOf, indexOr503 } = require("../lib/listing");

const MAX_QUERY_LENGTH = 200;
const MAX_ORGANISATIONS = 20;
const FIELDS = ["all", "id", "name", "org"];

const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// Accepts the forms people paste: "1/0/0.9", "/1/0/", "hwidx.org/1/0", "https://m.hwidx.org/1/0", "hwidx://1/0"
function normaliseId(text) {
  return text.toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^(m\.)?hwidx\.org(\/|$)/, "")
    .replace(/^\/+|\/+$/g, "");
}

function displayName(value) {
  return typeof value === "string" ? value : value?.name;
}

// One summary per top-level organisation identifier, derived once per cache snapshot:
// its name, the groups registered under it, and how many entries it has
const organisationsBySnapshot = new WeakMap();

function organisationsOf(index) {
  if (!organisationsBySnapshot.has(index)) {
    const byKey = new Map();
    index.summaries.forEach((line, row) => {
      const key = index.keys[row].split("/")[0];
      const { org, group } = JSON.parse(line);
      const entry = byKey.get(key) ?? { key, name: null, groups: new Set(), entries: 0 };
      entry.name ??= displayName(org) ?? null;
      if (displayName(group)) entry.groups.add(displayName(group));
      entry.entries += 1;
      byKey.set(key, entry);
    });

    const organisations = [...byKey.values()]
      .filter((entry) => entry.name)
      .sort((a, b) => byVersion(a.key, b.key))
      .map((entry) => ({
        key: entry.key,
        hwidx: `https://hwidx.org/${entry.key}`,
        name: entry.name,
        groups: [...entry.groups],
        entries: entry.entries,
        // Lower-cased organisation and group names, for matching
        text: [entry.name, ...entry.groups].join(" ").toLowerCase().replace(/\s+/g, " "),
      }));

    organisationsBySnapshot.set(index, organisations);
  }
  return organisationsBySnapshot.get(index);
}

// GET /search: search entries by identifier, name and/or organisation, paged like the catalog.
//   ?q=gamepad        required; an identifier prefix (any pasted hwidx URL form), or words to find
//                     in device names and organisation/group names
//   ?field=all        "all" (default), "id", "name" or "org"
//   ?page=, ?per_page= as for the catalog
// Results rank an exact identifier first, then identifier prefixes, then name matches, then
// organisation matches, each newest first. With field "all", every word must appear in the device's
// name or its organisation/group names, so "lancaster gamepad" works.
// Searches over organisations (field "all" or "org") also return the matching organisations themselves.
module.exports = function search({ cache }) {
  return (req, res) => {
    const paging = parsePaging(req.query);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const field = req.query.field ?? "all";

    if (paging === null || q === "" || q.length > MAX_QUERY_LENGTH || !FIELDS.includes(field))
      return res.status(400).json({ error: `Expected q of 1-${MAX_QUERY_LENGTH} characters, field of ${FIELDS.join(", ")}, page >= 1, 1 <= per_page <= ${MAX_PAGE_SIZE}` });

    const id = normaliseId(q);
    const terms = q.toLowerCase().split(/\s+/);
    const allIn = (text) => terms.every((term) => text.includes(term));

    // 0 = exact identifier, 1 = whole-segment prefix (1/0 -> 1/0/0.9), 2 = partial prefix (1/2 -> 1/21/0.1),
    // 3 = name, 4 = organisation (or name and organisation together). Cached text is already lower-cased.
    function rank(key, name, orgs) {
      if ((field === "all" || field === "id") && id !== "") {
        if (key === id) return 0;
        if (key.startsWith(`${id}/`)) return 1;
        if (key.startsWith(id)) return 2;
      }
      if ((field === "all" || field === "name") && allIn(name))
        return 3;
      if ((field === "org" && allIn(orgs)) || (field === "all" && allIn(`${name} ${orgs}`)))
        return 4;
      return null;
    }

    const index = indexOr503(cache, res);
    if (index === null)
      return;

    // Scan the key, name and org columns; cache rows are already newest first
    const matches = index.keys
      .map((key, row) => ({ row, rank: rank(key, index.names[row], index.orgs[row]) }))
      .filter((match) => match.rank !== null)
      .sort((a, b) => a.rank - b.rank); // stable, so newest-first holds within each rank

    const organisations = field === "all" || field === "org"
      ? organisationsOf(index)
        .filter((organisation) => allIn(organisation.text))
        .slice(0, MAX_ORGANISATIONS)
        .map(({ text, ...organisation }) => organisation)
      : [];

    return res.json({
      ...pageOf(matches, paging, ({ row }) => JSON.parse(index.summaries[row])),
      q,
      field,
      organisations,
    });
  };
};
