import test from "node:test";
import assert from "node:assert/strict";
import { listFilters } from "../server/list-filters.js";

test("date filters include the full last UTC day and reject ambiguous or invalid input", () => {
  const { withinDate } = listFilters({ from: "2026-09-30", to: "2026-10-01" });
  assert.equal(withinDate(Date.parse("2026-09-29T23:59:59.999Z")), false);
  assert.equal(withinDate(Date.parse("2026-09-30T00:00:00Z")), true);
  assert.equal(withinDate(Date.parse("2026-10-01T23:59:59.999Z")), true);
  assert.equal(withinDate(Date.parse("2026-10-02T00:00:00Z")), false);
  for (const input of [
    { from: "2026-02-30" },
    { to: "10/03/2026" },
    { from: ["2026-10-03"] },
    { from: "2026-10-03", to: "2026-10-02" },
    { offset: 1.5 },
    { offset: 100001 },
    { query: [] },
    { query: "x\0" },
  ])
    assert.throws(() => listFilters(input), {
      code: "invalid_list_filters",
      status: 400,
    });
});
