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
