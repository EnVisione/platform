import { monthsAfter, inactivityMonths } from "../shared/privacy.js";
import { randomUUID } from "node:crypto";
import { AuthError } from "./discord.js";
import { listFilters, matchesText } from "./list-filters.js";
import { permissions, communityRankNames } from "./roles.js";
import {
  staffPermissionCatalog,
  permissionDependencies,
  protectedFounderPermissions,
  ticketPermissionScope,
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
  const ticketRole = config.tickets?.staffRoleId;
  if (ticketRole)
    roles.push({
      id: ticketRole,
      name: "Tickets",
      label: "Tickets",
      ticket: true,
    });
  const staffPermissions = staffPermissionCatalog(
    config.mail?.identities,
    Boolean(ticketRole),
  );
  const editorPermissions = ticketRole
    ? staffPermissions.map((permission) => ({
        ...permission,
        roleIds: roles
          .filter((role) =>
            role.ticket
              ? ticketPermissionScope(permission.key) === "tickets"
              : ticketPermissionScope(permission.key) !== "tickets",
          )
          .map((role) => role.id),
        requires: permission.requires.filter((key) =>
          ticketPermissionScope(permission.key) === "rank"
            ? ticketPermissionScope(key) !== "tickets"
            : true,
        ),
      }))
    : staffPermissions;
  const keys = staffPermissions.map((permission) => permission.key);
  const managers = ["Founder", "Manager"];
  const admins = [...managers, "Admin"];
  const reviewers = [...admins, "Sr Moderator", "Moderator", "Jr Moderator"];
  const editableCategory = (key) =>
    Boolean(ticketRole && /^tickets\.category\.(billing|staff)\./.test(key));
  let state = store.get("role-permissions", "current") ?? {
    revision: 0,
    overrides: {},
    ticketVisibilityVersion: 1,
    ticketTakeoverVersion: 1,
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
        if (key === "bot.view" || key === "bot.edit")
          enabled = [...admins, "Sr Moderator", "Moderator"].includes(
            role.name,
          );
        if (key === "accounts.view" || key.startsWith("mail."))
          enabled = admins.includes(role.name);
        if (key.startsWith("tickets.") || key === "logs.view")
          enabled = [...reviewers, "Helper"].includes(role.name);
        if (key === "tickets.view" || key === "logs.view") enabled = true;
        if (key === "players.view")
          enabled = [...reviewers, "Helper"].includes(role.name);
        if (
          [
            "moderation.view",
            "moderation.warn",
            "moderation.notes",
            "staffnotes.view",
            "staffnotes.create",
            "staffnotes.clear",
          ].includes(key)
        )
          enabled = [...reviewers, "Helper"].includes(role.name);
        if (
          ["moderation.mute", "moderation.freeze", "moderation.kick"].includes(
            key,
          )
        )
          enabled = reviewers.includes(role.name);
        if (
          [
            "moderation.ban",
            "moderation.revoke",
            "moderation.appeals",
          ].includes(key)
        )
          enabled = [...admins, "Sr Moderator", "Moderator"].includes(
            role.name,
          );
        if (["moderation.ip", "moderation.ipban"].includes(key))
          enabled = admins.includes(role.name);
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
          if (
            ["support", "reports"].includes(category) &&
            key.endsWith(".view")
          )
            enabled = true;
        }
        if (key.startsWith("mail.inbox.partners@drakora.org."))
          enabled = managers.includes(role.name);
        if (key === "tickets.takeover" || key.endsWith(".takeover"))
          enabled = enabled && communityRankNames.includes(role.name);
        if (key === "tickets.macros.manage")
          enabled = admins.includes(role.name);
        if (key === "tickets.rating.override")
          enabled = managers.includes(role.name);
        if (ticketRole) {
          if (role.ticket)
            enabled =
              key === "dashboard.view" ||
              ticketPermissionScope(key) === "tickets";
          else if (ticketPermissionScope(key) === "tickets") enabled = false;
          else if (/^tickets\.category\.(billing|staff)\./.test(key))
            enabled = managers.includes(role.name);
        }
        return [key, enabled];
      }),
    );
  if (!state.ticketVisibilityVersion) {
    const overrides = { ...state.overrides };
    for (const role of roles.filter((role) => role.id && overrides[role.id]))
      overrides[role.id] = {
        ...overrides[role.id],
        "tickets.view": true,
        "logs.view": true,
        "tickets.category.support.view": true,
        "tickets.category.reports.view": true,
      };
    const next = {
      ...state,
      overrides,
      ticketVisibilityVersion: 1,
      revision: state.revision + 1,
      updatedAt: Date.now(),
      updatedBy: { id: "system", name: "System" },
    };
    store.transaction(() => {
      store.set("role-permissions", "current", next, Number.MAX_SAFE_INTEGER);
      audit(next.updatedBy, "permissions", {
        revision: next.revision,
        reason: "Support and report visibility updated for all staff",
      });
    });
    state = next;
  }
  const deletion = (key) =>
    key === "tickets.delete" ||
    (key.startsWith("tickets.category.") && key.endsWith(".delete"));
  const takeover = (key) =>
    key === "tickets.takeover" ||
    (key.startsWith("tickets.category.") && key.endsWith(".takeover"));
  const adminOnly = (key) =>
    deletion(key) || ["moderation.ip", "moderation.ipban"].includes(key);
  const restricted = (key, role) =>
    (key === "tickets.rating.override" && !managers.includes(role.name)) ||
    (!ticketRole &&
      key.startsWith("tickets.category.billing.") &&
      role.name !== "Founder") ||
    ((key.startsWith("tickets.category.partnership.") ||
      (!ticketRole && key.startsWith("tickets.category.staff.")) ||
      key.startsWith("mail.inbox.partners@drakora.org.")) &&
      !managers.includes(role.name));
  if (!state.ticketTakeoverVersion) {
    const overrides = structuredClone(state.overrides);
    for (const role of roles.filter(
      (role) =>
        role.id &&
        !admins.includes(role.name) &&
        communityRankNames.includes(role.name),
    )) {
      if (!overrides[role.id]) continue;
      const previous = { ...defaults(role), ...overrides[role.id] };
      for (const key of keys.filter(takeover))
        overrides[role.id][key] = Boolean(
          previous[key.replace(/takeover$/, "claim")],
        );
    }
    state = {
      ...state,
      overrides,
      ticketTakeoverVersion: 1,
      revision: state.revision + 1,
      updatedAt: Date.now(),
      updatedBy: { id: "system", name: "System" },
    };
    store.transaction(() => {
      store.set("role-permissions", "current", state, Number.MAX_SAFE_INTEGER);
      audit(state.updatedBy, "permissions", {
        revision: state.revision,
        reason: "Rank based ticket takeovers and Manager approval enabled",
      });
    });
  }
  if (ticketRole && state.ticketRoleVersion !== 1) {
    const overrides = structuredClone(state.overrides);
    for (const role of roles.filter((role) => role.id && !role.ticket)) {
      overrides[role.id] = { ...overrides[role.id] };
      for (const key of keys) {
        if (ticketPermissionScope(key) === "tickets")
          overrides[role.id][key] = false;
        if (/^tickets\.category\.(billing|staff)\./.test(key))
          overrides[role.id][key] = managers.includes(role.name);
      }
    }
    state = {
      ...state,
      overrides,
      ticketRoleVersion: 1,
      revision: state.revision + 1,
      updatedAt: Date.now(),
      updatedBy: { id: "system", name: "System" },
    };
    store.transaction(() => {
      store.set("role-permissions", "current", state, Number.MAX_SAFE_INTEGER);
      audit(state.updatedBy, "permissions", {
        revision: state.revision,
        reason:
          "General ticket access moved to the main-server Tickets role; billing and staff reports default to Manager and Founder",
      });
    });
  }
  const rank = (user) => {
    const index = communityRankNames.findIndex((name) =>
      roles.some(
        (role) =>
          role.name === name && role.id && user.roles?.includes(role.id),
      ),
    );
    return index < 0 ? null : index;
  };
  const values = (role) =>
    Object.fromEntries(
      Object.entries({ ...defaults(role), ...state.overrides[role.id] }).map(
        ([key, value]) => [
          key,
          key === "dashboard.view" ||
            (value &&
              (!ticketRole ||
                (role.ticket
                  ? ticketPermissionScope(key) === "tickets"
                  : ticketPermissionScope(key) !== "tickets")) &&
              !restricted(key, role) &&
              (!takeover(key) ||
                ticketRole ||
                communityRankNames.includes(role.name)) &&
              (!adminOnly(key) || role.ticket || admins.includes(role.name))),
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
    const base = permissions(config, user.roles, user.staffMember);
    const assigned = roles.filter(
      (role) => role.id && !role.ticket && user.roles?.includes(role.id),
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
    if (!isAdmin(user)) {
      granted["moderation.ip"] = false;
      granted["moderation.ipban"] = false;
    }
    if (isFounder(user))
      for (const key of protectedFounderPermissions) granted[key] = true;
    if (ticketRole) {
      const ticketValues = values(roles.find((role) => role.ticket));
      for (const key of keys) {
        const scope = ticketPermissionScope(key);
        if (scope === "tickets")
          granted[key] = user.ticketRole === true && ticketValues[key];
        if (scope === "rank" && user.ticketRole !== true) granted[key] = false;
        if (deletion(key) && !isAdmin(user)) granted[key] = false;
      }
    }
    granted["dashboard.view"] = base.dashboard;
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
      permissions: editorPermissions,
      ticketRole: ticketRole
        ? { id: ticketRole, guildId: config.tickets.guildId }
        : null,
      roles: roles.map((role) => ({
        ...role,
        permissions: permissionDependencies(values(role), editorPermissions),
        editable: Boolean(
          role.id &&
          (role.name !== "Founder" || isFounder(current) || ticketRole),
        ),
        locked: [
          "dashboard.view",
          ...(ticketRole
            ? keys.filter((key) =>
                role.ticket
                  ? ticketPermissionScope(key) !== "tickets"
                  : ticketPermissionScope(key) === "tickets",
              )
            : []),
          ...keys.filter((key) => restricted(key, role)),
          ...(ticketRole && role.name === "Founder" && !isFounder(current)
            ? keys.filter((key) => !editableCategory(key))
            : []),
          ...(!role.ticket && !admins.includes(role.name)
            ? keys.filter(adminOnly)
            : []),
          ...(!ticketRole && !isFounder(current)
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
      const previous = permissionDependencies(values(role), editorPermissions);
      const permissions = { ...entry.permissions, "dashboard.view": true };
      if (
        ticketRole &&
        keys.some(
          (key) =>
            (role.ticket
              ? ticketPermissionScope(key) !== "tickets"
              : ticketPermissionScope(key) === "tickets") &&
            permissions[key] !== previous[key],
        )
      )
        throw new AuthError("ticket_role_required", 400);
      if (
        role.name === "Founder" &&
        !isFounder(current) &&
        keys.some(
          (key) =>
            !editableCategory(key) && permissions[key] !== previous[key],
        )
      )
        throw new AuthError("founder_role_required");
      if (
        role.name === "Founder" &&
        protectedFounderPermissions.some((key) => !permissions[key])
      )
        throw new AuthError("founder_access_protected", 400);
      if (
        !managers.includes(role.name) &&
        keys.some((key) => key.startsWith("roles.") && permissions[key])
      )
        throw new AuthError("role_management_protected", 400);
      if (
        !role.ticket &&
        !admins.includes(role.name) &&
        keys.some((key) => deletion(key) && permissions[key])
      )
        throw new AuthError("ticket_deletion_protected", 400);
      if (
        !ticketRole &&
        !communityRankNames.includes(role.name) &&
        keys.some((key) => takeover(key) && permissions[key])
      )
        throw new AuthError("ticket_takeover_protected", 400);
      if (
        keys.some(
          (key) =>
            permissions[key] &&
            editorPermissions
              .find((permission) => permission.key === key)
              .requires.some((dependency) => !permissions[dependency]),
        )
      )
        throw new AuthError("role_permission_dependency", 400);
      if (
        !ticketRole &&
        !isFounder(current) &&
        keys.some(
          (key) =>
            key.startsWith("tickets.category.billing.") &&
            permissions[key] !== previous[key],
        )
      )
        throw new AuthError("founder_role_required");
      if (keys.some((key) => permissions[key] && restricted(key, role)))
        throw new AuthError("ticket_category_protected", 400);
      delete permissions["dashboard.view"];
      overrides[role.id] = permissions;
    }
    const next = {
      revision: state.revision + 1,
      ticketVisibilityVersion: 1,
      ticketTakeoverVersion: 1,
      ticketRoleVersion: state.ticketRoleVersion,
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
    rank,
    roles,
    history(user, offset = 0, input = {}) {
      authorize(user, "roles.view");
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new AuthError("invalid_request", 400);
      const { term, withinDate } = listFilters({ ...input, offset });
      const { action = "" } = input;
      if (
        !["", "permissions", "assignment", "application-invite"].includes(
          action,
        )
      )
        throw new AuthError("invalid_list_filters", 400);
      const page = store.page(
        "role-audit",
        25,
        offset,
        (entry) =>
          (!action || entry.action === action) &&
          withinDate(entry.at) &&
          matchesText(term, [
            entry.actor.id,
            entry.actor.name,
            entry.memberId,
            entry.applicationId,
          ]),
      );
      return { ...page, pageSize: 25 };
    },
  };
}
