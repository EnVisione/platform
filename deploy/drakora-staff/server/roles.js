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
  if (user.capabilities) return Boolean(user.capabilities["office.host"]);
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
    manager: user.capabilities
      ? Boolean(user.capabilities["accounts.view"])
      : Boolean(hasRank(["Founder", "Manager", "Admin"])),
    approveMinecraftChange: user.capabilities
      ? Boolean(user.capabilities["accounts.minecraft"])
      : Boolean(hasRank(["Founder", "Manager"])),
  };
}

export function applicationReviewAccess(config, user) {
  if (user.capabilities) return Boolean(user.capabilities["applications.view"]);
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
  if (user.capabilities)
    return Boolean(config.mail && user.capabilities["mail.view"]);
  return Boolean(config.mail && managementAccess(config, user).manager);
}

export function applicationDecisionAccess(config, user) {
  if (user.capabilities)
    return Boolean(
      user.capabilities["applications.approve"] ||
      user.capabilities["applications.deny"],
    );
  return Boolean(
    user.permissions.dashboard &&
    config.ranks.some(
      (rank) =>
        ["Founder", "Manager"].includes(rank.name) &&
        user.roles.includes(rank.id),
    ),
  );
}
export function staffCapability(config, user, key) {
  if (user.capabilities) return Boolean(user.capabilities[key]);
  if (key === "applications.comment")
    return applicationReviewAccess(config, user);
  if (key.startsWith("applications."))
    return applicationDecisionAccess(config, user);
  if (key.startsWith("mail.")) return mailAccess(config, user);
  return false;
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
