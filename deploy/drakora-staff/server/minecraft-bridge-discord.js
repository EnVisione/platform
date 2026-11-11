import { PermissionFlagsBits, Routes } from "discord.js";
import { bridgeFailure } from "./minecraft-bridge.js";

export function minecraftRoleTransport(config, client) {
  const mainId = config.roleSync.guildId;
  const managed = new Set([
    config.minecraftBridge.linkedRoleId,
    ...(config.minecraftBridge.storeMappings ?? []).map((m) => m.roleId),
  ]);
  async function member(guildId, id) {
    try {
      const value = await client.rest.get(Routes.guildMember(guildId, id));
      return {
        id,
        roles: value.roles,
        pending: Boolean(value.pending),
        bot: Boolean(value.user.bot),
        name: value.nick || value.user.global_name || value.user.username,
      };
    } catch (error) {
      if (error.code === 10007) return null;
      throw bridgeFailure("discord_unavailable", 503);
    }
  }
  return {
    member: (id) => member(mainId, id),
    async assertStaff(id) {
      const value = await member(config.guildId, id);
      if (
        !value ||
        value.pending ||
        value.bot
      )
        throw bridgeFailure("staff_admission_required", 403);
      return value;
    },
    async validate(roleIds) {
      const guild = await client.guilds.fetch(mainId);
      await guild.roles.fetch();
      const me = await guild.members.fetchMe({ force: true });
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
        throw bridgeFailure("discord_role_permission_required", 503);
      for (const id of roleIds) {
        const role = guild.roles.cache.get(id);
        if (
          !managed.has(id) ||
          !role ||
          role.managed ||
          role.id === mainId ||
          role.permissions.bitfield !== 0n ||
          !role.editable
        )
          throw bridgeFailure("cosmetic_role_unavailable", 503);
      }
    },
    async change(id, roleId, add) {
      await this.validate([roleId]);
      const route = Routes.guildMemberRole(mainId, id, roleId);
      try {
        if (add)
          await client.rest.put(route, {
            reason: "synchronize linked Minecraft cosmetics",
          });
        else
          await client.rest.delete(route, {
            reason: "synchronize linked Minecraft cosmetics",
          });
      } catch (error) {
        throw Object.assign(bridgeFailure("discord_unavailable", 503), {
          definiteFailure: error.status >= 400 && error.status < 500,
        });
      }
    },
  };
}
