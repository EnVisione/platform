import { isAbsolute } from "node:path";

const scopes = new Set(["network", "rh", "prom2"]);
const snowflake = (id) => typeof id === "string" && /^\d{1,20}$/.test(id);
export function validateMinecraftBridge(config) {
  const value = config.minecraftBridge;
  if (value === undefined) return;
  if (
    !value ||
    typeof value.enabled !== "boolean" ||
    (value.rankSyncEnabled !== undefined &&
      typeof value.rankSyncEnabled !== "boolean")
  )
    throw new Error("Configure Minecraft bridge enablement explicitly");
  if (!value.enabled) return;
  if (
    !config.office ||
    !config.roleSync ||
    !config.storefront ||
    !isAbsolute(value.proxyKeysFile ?? "") ||
    !snowflake(value.linkedRoleId)
  )
    throw new Error(
      "Configure a private proxy key file and a dedicated Linked role before enabling Minecraft linking",
    );
  const protectedIds = new Set([
    config.tickets?.staffRoleId,
    ...config.roleSync.roles.flatMap((role) => [role.staffId, role.mainId]),
  ]);
  if (protectedIds.has(value.linkedRoleId))
    throw new Error(
      "The Linked role must be independent from staff and access roles",
    );
  const staff = value.staffMappings ?? [],
    shop = value.storeMappings ?? [];
  if (
    !Array.isArray(staff) ||
    !Array.isArray(shop) ||
    staff.length > 30 ||
    shop.length > 12
  )
    throw new Error("Configure bounded Minecraft rank mappings");
  const staffRanks = new Map(
    config.ranks.map((r) => [r.id, r.name.toLowerCase().replaceAll(" ", "")]),
  );
  const mapped = new Set(config.roleSync.roles.map((r) => r.staffId));
  const seen = new Set();
  for (const item of staff) {
    const key = `${item.roleId}:${item.scope}`;
    if (
      !mapped.has(item.roleId) ||
      !scopes.has(item.scope) ||
      item.rank !== staffRanks.get(item.roleId) ||
      seen.has(key)
    )
      throw new Error(
        "Map each Minecraft staff scope to its existing configured staff rank",
      );
    seen.add(key);
  }
  const storeIds = new Set([value.linkedRoleId]);
  seen.clear();
  for (const item of shop) {
    const key = `${item.rank}:${item.scope}`;
    const names =
      item.scope === "network"
        ? ["archwyrm", "archdrake", "archwyvern", "archdragon"]
        : ["wyrm", "drake", "wyvern", "dragon"];
    if (
      !snowflake(item.roleId) ||
      protectedIds.has(item.roleId) ||
      !scopes.has(item.scope) ||
      !names.includes(item.rank) ||
      seen.has(key) ||
      storeIds.has(item.roleId)
    )
      throw new Error(
        "Map distinct cosmetic store roles for each rank and scope",
      );
    seen.add(key);
    storeIds.add(item.roleId);
  }
  if (
    value.rankSyncEnabled &&
    (!staff.length ||
      [...mapped].some((id) => !staff.some((item) => item.roleId === id)) ||
      shop.length !== 12)
  )
    throw new Error(
      "Confirm complete staff scopes and all twelve store roles before enabling rank synchronization",
    );
}
