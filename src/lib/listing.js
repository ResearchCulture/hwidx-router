// Helpers shared by the paged listing endpoints (catalog and search)

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// Positive integer query parameter, the fallback when absent, or null when invalid
function parseCount(value, fallback) {
  if (value === undefined)
    return fallback;
  return /^[1-9]\d*$/.test(value) ? parseInt(value, 10) : null;
}

// ?page= and ?per_page=, or null when invalid
function parsePaging(query) {
  const page = parseCount(query.page, 1);
  const perPage = parseCount(query.per_page, PAGE_SIZE);
  if (page === null || perPage === null || perPage > MAX_PAGE_SIZE)
    return null;
  return { page, perPage };
}

// One page of items, mapped to entries only for that page
function pageOf(items, { page, perPage }, toEntry) {
  const start = (page - 1) * perPage;
  return {
    count: items.length,
    page,
    per_page: perPage,
    pages: Math.max(1, Math.ceil(items.length / perPage)),
    entries: items.slice(start, start + perPage).map(toEntry),
  };
}

// The index cache snapshot, or null after sending a 503 when the index has never been built
function indexOr503(cache, res) {
  const index = cache.snapshot();
  if (index === null)
    res.status(503).json({ error: "Index not available yet" });
  return index;
}

module.exports = { MAX_PAGE_SIZE, parsePaging, pageOf, indexOr503 };
