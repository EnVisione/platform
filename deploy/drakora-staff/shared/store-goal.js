export const storeGoal = Object.freeze({
  id: "new-machine",
  title: "Buy a new Machine",
  targetCents: 250000,
  currency: "USD",
});

export function goalProgress(raisedCents) {
  if (!Number.isSafeInteger(raisedCents) || raisedCents < 0)
    throw new Error("Invalid store goal total");
  return {
    ...storeGoal,
    raisedCents,
    percent:
      raisedCents >= storeGoal.targetCents
        ? 100
        : Math.floor((raisedCents * 100) / storeGoal.targetCents),
  };
}

export function goalAnnouncementBar(goal) {
  const filled = Math.min(
    30,
    Math.floor((goal.raisedCents * 30) / goal.targetCents),
  );
  const active = filled
    ? `<gradient:#72db7e:#f4ce79>${"|".repeat(filled)}</gradient>`
    : "";
  const empty =
    filled < 30 ? `<color:#454a52>${"|".repeat(30 - filled)}</color>` : "";
  return `<color:#aab2c0>[</color>${active}${empty}<color:#aab2c0>] </color><color:#f4ce79>${goal.percent}%</color> of Goal (<color:#f4ce79>${goal.title}</color>)`;
}
