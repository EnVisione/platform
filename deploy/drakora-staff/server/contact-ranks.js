export function contactRanks(snapshot, findUser) {
  const byAccount = Object.create(null);
  if (!snapshot.connected) return { connected: false, byAccount };

  for (const member of snapshot.members) {
    const account = findUser(member.id)?.hulyAccount;
    if (typeof account === "string" && Array.isArray(member.ranks))
      byAccount[account] = member.ranks;
  }
  return { connected: true, byAccount };
}
