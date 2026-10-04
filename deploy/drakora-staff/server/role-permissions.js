import { monthsAfter, inactivityMonths } from "../shared/privacy.js";
import { randomUUID } from "node:crypto";
import { AuthError } from "./discord.js";
import { listFilters, matchesText } from "./list-filters.js";
import { permissions } from "./roles.js";
import {
  staffPermissionCatalog,
  permissionDependencies,
  protectedFounderPermissions,
} from "../shared/staff-permissions.js";

export function staffRoleCatalog(config) {
  return [
    ["Founder", "Founder"],
    ["Manager", "Manager"],
    ["Admin", "Admin"],
    ["Sr Moderator", "Sr Mod"],
    ["Moderator", "Mod"],
    ["Jr Moderator", "Jr Mod"],
    ["Helper", "Helper"],
    ["Builder", "Builder", "builder"],
    ["Developer", "Dev", "developer"],
    ["Artist", "Artist", "artist"],
  ].map(([name, label, specialist]) => ({
    id: specialist
      ? (config.applications?.specialistRoles?.[specialist] ??
        config.ranks.find((rank) => rank.name === name)?.id)
      : config.ranks.find((rank) => rank.name === name)?.id,
    name,
    label,
    specialist: Boolean(specialist),
  }));
}

export function rolePermissions(config, store) {
  const roles = staffRoleCatalog(config);
  const staffPermissions = staffPermissionCatalog(config.mail?.identities);
  const keys = staffPermissions.map((permission) => permission.key);
  const managers = ["Founder", "Manager"];
  const admins = [...managers, "Admin"];
  const reviewers = [...admins, "Sr Moderator", "Moderator", "Jr Moderator"];
  let state = store.get("role-permissions", "current") ?? {
    revision: 0,
    overrides: {},
  };
  const defaults = (role) =>
    Object.fromEntries(
      keys.map((key) => {
        let enabled = [
          "dashboard.view",
          "huly.access",
          "office.view",
          "settings.view",
          "settings.minecraft",
        ].includes(key);
        if (key === "office.host")
          enabled = config.office?.hostRoles.includes(role.id) ?? false;
        if (
          key === "applications.view" ||
          key === "applications.comment" ||
          key === "moderation.view"
        )
          enabled = reviewers.includes(role.name);
        if (
          [
            "applications.review",
            "applications.approve",
            "applications.deny",
            "applications.edit",
            "accounts.minecraft",
          ].includes(key) ||
          key.startsWith("roles.")
        )
          enabled = managers.includes(role.name);
        if (key === "accounts.view" || key.startsWith("mail."))
          enabled = admins.includes(role.name);
        if (key.startsWith("tickets.") || key === "logs.view")
          enabled = [...reviewers, "Helper"].includes(role.name);
        if (key.startsWith("tickets.category.")) {
          const category = key.split(".")[2];
          enabled =
            category === "billing"
              ? role.name === "Founder"
              : category === "support"
                ? [...reviewers, "Helper"].includes(role.name)
                : category === "reports"
                  ? reviewers.includes(role.name)
                  : managers.includes(role.name);
        }
        if (key.startsWith("mail.inbox.partners@drakora.org."))
          enabled = managers.includes(role.name);
        if (key === "tickets.takeover" || key.endsWith(".takeover"))
          enabled = enabled && admins.includes(role.name);
        return [key, enabled];
      }),
    );
  const deletion = (key) =>
    key === "tickets.delete" ||
    (key.startsWith("tickets.category.") && key.endsWith(".delete"));
  const takeover = (key) =>
    key === "tickets.takeover" ||
    (key.startsWith("tickets.category.") && key.endsWith(".takeover"));
  const adminOnly = (key) => deletion(key) || takeover(key);
  const values = (role) =>
    Object.fromEntries(
      Object.entries({ ...defaults(role), ...state.overrides[role.id] }).map(
        ([key, value]) => [
          key,
          value && (!adminOnly(key) || admins.includes(role.name)),
        ],
      ),
    );
  const isFounder = (user) =>
    roles.some(
      (role) => role.name === "Founder" && user.roles?.includes(role.id),
    );
  const isManager = (user) =>
    roles.some(
      (role) => managers.includes(role.name) && user.roles?.includes(role.id),
    );
  const isAdmin = (user) =>
    roles.some(
      (role) => admins.includes(role.name) && user.roles?.includes(role.id),
    );
  function apply(user) {
    const base = permissions(config, user.roles);
    const assigned = roles.filter(
      (role) => role.id && user.roles?.includes(role.id),
    );
    const assignedValues = assigned.map(values);
    const fallback = defaults({ name: "Staff", id: null });
    const granted = Object.fromEntries(
      keys.map((key) => [
        key,
        assigned.length
          ? assignedValues.some((permissions) => permissions[key])
          : fallback[key],
      ]),
    );
    if (!isManager(user))
      for (const key of keys.filter((key) => key.startsWith("roles.")))
        granted[key] = false;
    if (isFounder(user))
      for (const key of protectedFounderPermissions) granted[key] = true;
    if (!base.dashboard) granted["dashboard.view"] = false;
    if (!base.todo) granted["huly.access"] = false;
    const capabilities = permissionDependencies(granted, staffPermissions);
    return {
      ...user,
      capabilities,
      policyRevision: state.revision,
      permissions: {
        ...base,
        dashboard: capabilities["dashboard.view"],
        todo: capabilities["huly.access"],
      },
    };
  }
  function authorize(user, key) {
    const current = apply(user);
    if (!isManager(current) || !current.capabilities[key])
      throw new AuthError("role_management_required");
    return current;
  }
  function read(user) {
    const current = authorize(user, "roles.view");
    return {
      revision: state.revision,
      permissions: staffPermissions,
      roles: roles.map((role) => ({
        ...role,
        permissions: permissionDependencies(values(role), staffPermissions),
        editable: Boolean(
          role.id && (role.name !== "Founder" || isFounder(current)),
        ),
        locked: [
          ...(!admins.includes(role.name) ? keys.filter(adminOnly) : []),
          ...(!isFounder(current)
            ? keys.filter((key) => key.startsWith("tickets.category.billing."))
            : []),
          ...(role.name === "Founder"
            ? protectedFounderPermissions
            : !managers.includes(role.name)
              ? keys.filter((key) => key.startsWith("roles."))
              : []),
        ],
      })),
      canEdit: current.capabilities["roles.edit"],
      canAssign: current.capabilities["roles.assign"],
      founder: isFounder(current),
      updatedAt: state.updatedAt,
      updatedBy: state.updatedBy,
    };
  }
  function save(user, input) {
    const current = authorize(user, "roles.edit");
    if (
      !input ||
      !Number.isSafeInteger(input.revision) ||
      !Array.isArray(input.roles) ||
      input.roles.length !== roles.filter((role) => role.id).length
    )
      throw new AuthError("invalid_role_permissions", 400);
    if (input.revision !== state.revision)
      throw new AuthError("role_permissions_changed", 409);
    const overrides = {};
    for (const entry of input.roles) {
      const role = roles.find((role) => role.id && role.id === entry?.id);
      if (
        !role ||
        overrides[role.id] ||
        !entry.permissions ||
        Object.keys(entry.permissions).length !== keys.length ||
        keys.some((key) => typeof entry.permissions[key] !== "boolean")
      )
        throw new AuthError("invalid_role_permissions", 400);
      const previous = permissionDependencies(values(role), staffPermissions);
      if (
        role.name === "Founder" &&
        !isFounder(current) &&
        keys.some((key) => entry.permissions[key] !== previous[key])
      )
        throw new AuthError("founder_role_required");
      if (
        role.name === "Founder" &&
        protectedFounderPermissions.some((key) => !entry.permissions[key])
      )
        throw new AuthError("founder_access_protected", 400);
      if (
        !managers.includes(role.name) &&
        keys.some((key) => key.startsWith("roles.") && entry.permissions[key])
      )
        throw new AuthError("role_management_protected", 400);
      if (
        !admins.includes(role.name) &&
        keys.some((key) => deletion(key) && entry.permissions[key])
      )
        throw new AuthError("ticket_deletion_protected", 400);
      if (
        !admins.includes(role.name) &&
        keys.some((key) => takeover(key) && entry.permissions[key])
      )
        throw new AuthError("ticket_takeover_protected", 400);
      if (
        keys.some(
          (key) =>
            entry.permissions[key] &&
            staffPermissions
              .find((permission) => permission.key === key)
              .requires.some((dependency) => !entry.permissions[dependency]),
        )
      )
        throw new AuthError("role_permission_dependency", 400);
      if (
        !isFounder(current) &&
        keys.some(
          (key) =>
            key.startsWith("tickets.category.billing.") &&
            entry.permissions[key] !== previous[key],
        )
      )
        throw new AuthError("founder_role_required");
      overrides[role.id] = { ...entry.permissions };
    }
    const next = {
      revision: state.revision + 1,
      overrides,
      updatedAt: Date.now(),
      updatedBy: { id: user.id, name: user.name },
    };
    store.transaction(() => {
      store.set("role-permissions", "current", next, Number.MAX_SAFE_INTEGER);
      audit(user, "permissions", { revision: next.revision });
    });
    state = next;
    return { revision: state.revision, saved: true };
  }
  function audit(user, action, detail) {
    const id = `${Date.now()}.${randomUUID()}`;
    store.set(
      "role-audit",
      id,
      {
        id,
        at: Date.now(),
        actor: { id: user.id, name: user.name },
        action,
        ...detail,
      },
      monthsAfter(Date.now(), inactivityMonths),
    );
  }
  return {
    apply,
    authorize,
    read,
    save,
    audit,
    isFounder,
    isManager,
    isAdmin,
    roles,
    history(user, offset = 0, input = {}) {
      authorize(user, "roles.view");
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new AuthError("invalid_request", 400);
      const { term, withinDate } = listFilters({ ...input, offset });
      const { action = "" } = input;
      if (!["", "permissions", "assignment"].includes(action))
        throw new AuthError("invalid_list_filters", 400);
      const page = store.page(
        "role-audit",
        25,
        offset,
        (entry) =>
          (!action || entry.action === action) &&
          withinDate(entry.at) &&
          matchesText(term, [entry.actor.id, entry.actor.name, entry.memberId]),
      );
      return { ...page, pageSize: 25 };
    },
  };
}
