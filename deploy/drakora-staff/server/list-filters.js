import { AuthError } from "./discord.js";

const day = 86400000;
function dateBoundary(value) {
  if (value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new AuthError("invalid_list_filters", 400);
  const at = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value)
    throw new AuthError("invalid_list_filters", 400);
  return at;
}

export function listFilters(input = {}, maxLength = 100) {
  const { offset = 0, query = "", from = "", to = "" } = input;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000 ||
    typeof query !== "string" ||
    query.length > maxLength ||
    query.includes("\0")
  )
    throw new AuthError("invalid_list_filters", 400);
  const start = dateBoundary(from),
    end = dateBoundary(to);
  if (start !== null && end !== null && start > end)
    throw new AuthError("invalid_list_filters", 400);
  return {
    offset,
    term: query.trim().toLowerCase(),
    withinDate: (at) =>
      (start === null || at >= start) && (end === null || at < end + day),
  };
}

export function matchesText(term, values) {
  return (
    !term ||
    values.some(
      (value) =>
        typeof value === "string" && value.toLowerCase().includes(term),
    )
  );
}
