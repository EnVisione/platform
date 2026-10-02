export function permissions(config, roleIds = []) {
  const ids = new Set(roleIds);
  const assigned = config.ranks.filter((role) => ids.has(role.id));
  return {
    dashboard: ids.has(config.accessRoles.dashboard),
    todo: ids.has(config.accessRoles.todo),
    dashboardRanks: assigned
      .filter((role) => role.dashboard)
      .map((role) => role.name),
    hulyRanks: assigned.map((role) => role.name),
    hulyRole: assigned[0]?.huly ?? "USER",
  };
}

export function canHost(config, user) {
  return (
    user.permissions.todo &&
    config.office.hostRoles.some((id) => user.roles.includes(id))
  );
}

export function managementAccess(config, user) {
  const ids = new Set(user.roles ?? []);
  const hasRank = (names) =>
    user.permissions.dashboard &&
    config.ranks.some((rank) => names.includes(rank.name) && ids.has(rank.id));
  return {
    founder: Boolean(hasRank(["Founder"])),
    manager: Boolean(hasRank(["Founder", "Manager", "Admin"])),
    approveMinecraftChange: Boolean(hasRank(["Founder", "Manager"])),
  };
}

export function applicationReviewAccess(config, user) {
  return Boolean(
    user.permissions.dashboard &&
    config.ranks.some(
      (rank) =>
        [
          "Founder",
          "Manager",
          "Admin",
          "Sr Moderator",
          "Moderator",
          "Jr Moderator",
        ].includes(rank.name) && user.roles.includes(rank.id),
    ),
  );
}

export function mailAccess(config, user) {
  return Boolean(config.mail && managementAccess(config, user).manager);
}

export function applicationDecisionAccess(config, user) {
  return Boolean(
    user.permissions.dashboard &&
    config.ranks.some(
      (rank) =>
        ["Founder", "Manager"].includes(rank.name) &&
        user.roles.includes(rank.id),
    ),
  );
}
export const communityRankNames = [
  "Founder",
  "Manager",
  "Admin",
  "Sr Moderator",
  "Moderator",
  "Jr Moderator",
  "Helper",
];
