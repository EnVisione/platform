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
  const founder = config.ranks.find((rank) => rank.name === "Founder");
  const admin = config.ranks.find((rank) => rank.name === "Admin");
  return {
    founder: Boolean(
      user.permissions.dashboard && founder && ids.has(founder.id),
    ),
    manager: Boolean(
      user.permissions.dashboard &&
        ((founder && ids.has(founder.id)) || (admin && ids.has(admin.id))),
    ),
  };
}
