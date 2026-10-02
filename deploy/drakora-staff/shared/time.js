export function validTimeZone(value) {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value)
  )
    return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

export function timeFormatter(format = "12", timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: format === "24" ? "h23" : "h12",
    ...(timeZone ? { timeZone } : {}),
  });
}

export function zoneLabel(zone) {
  return zone.split("/").at(-1).replaceAll("_", " ");
}
