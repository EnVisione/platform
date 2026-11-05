export const validRating = (value) =>
  Number.isInteger(value) && value >= 1 && value <= 5;

export function effectiveRating(record) {
  const value = record.ratingOverride
    ? record.ratingOverride.value
    : record.rating;
  return validRating(value) ? value : null;
}
