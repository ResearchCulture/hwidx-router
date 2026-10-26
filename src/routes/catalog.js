const { MAX_PAGE_SIZE, parsePaging, pageOf, indexOr503 } = require("../lib/listing");

// GET /catalog: paged summary of the entries in the index, for the device catalog.
//   ?page=1           1-based page number (default 1)
//   ?per_page=50      entries per page (default 50, max 100)
//   ?order=desc       "desc" (newest identifiers first, default) or "asc"
module.exports = function catalog({ cache }) {
  return (req, res) => {
    const paging = parsePaging(req.query);
    const order = req.query.order ?? "desc";

    if (paging === null || !["asc", "desc"].includes(order))
      return res.status(400).json({ error: `Expected page >= 1, 1 <= per_page <= ${MAX_PAGE_SIZE}, order of asc or desc` });

    const index = indexOr503(cache, res);
    if (index === null)
      return;

    // Cache rows are already newest first
    const rows = index.keys.map((key, row) => row);
    if (order === "asc")
      rows.reverse();

    // Only the requested page's summaries are parsed
    return res.json({ ...pageOf(rows, paging, (row) => JSON.parse(index.summaries[row])), order });
  };
};
