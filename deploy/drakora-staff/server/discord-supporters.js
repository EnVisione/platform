import { Routes } from "discord.js";

function linkedBuyers(store) {
  const buyers = new Set();
  for (const [, receipt] of store.entries("supporter-receipt")) {
    if (!receipt.active || receipt.refunded || receipt.disputed ||
        !Number.isSafeInteger(receipt.coins) || receipt.coins <= 0) continue;
    const uuid = receipt.buyerUuid ?? receipt.uuid;
    const owner = uuid && store.get("minecraft-owner", uuid);
    const discordId = owner?.discord?.id;
    if (owner?.memberLinked && discordId &&
        store.get("minecraft-discord-owner", discordId)?.uuid === uuid) {
      buyers.add(discordId);
    }
  }
  return buyers;
}

export function discordSupporters(config, store, client, { roleId, earlyRoleId }) {
  const guildId = config.roleSync.guildId;
  const qualifyingRoles = new Set([
    ...(config.minecraftBridge.storeMappings ?? []).map(({ roleId }) => roleId),
    config.minecraftBridge.plusRoleId,
    earlyRoleId,
  ].filter(Boolean));
  const rest = client.rest;
  let stopped = false;
  let running;

  async function reconcile() {
    const role = (await rest.get(Routes.guildRoles(guildId))).find(({ id }) => id === roleId);
    if (!role || role.managed || role.permissions !== "0" ||
        roleId === guildId || qualifyingRoles.has(roleId)) {
      throw new Error("Supporter role must be a separate cosmetic role.");
    }

    const buyers = linkedBuyers(store);
    function needsRole(member) {
      return buyers.has(member.user.id) || member.roles.some((id) => qualifyingRoles.has(id));
    }

    let after;
    let failures = 0;
    do {
      const query = new URLSearchParams({ limit: "1000" });
      if (after) query.set("after", after);
      const members = await rest.get(Routes.guildMembers(guildId), { query });
      for (const member of members) {
        if (stopped) return;
        if (member.user.bot || member.pending || needsRole(member) === member.roles.includes(roleId)) continue;
        const id = member.user.id;
        try {
          const current = await rest.get(Routes.guildMember(guildId, id));
          if (stopped || current.user.bot || current.pending) continue;
          const eligible = needsRole(current);
          if (eligible === current.roles.includes(roleId)) continue;
          const route = Routes.guildMemberRole(guildId, id, roleId);
          const options = { reason: "Synchronize Drakora supporter recognition" };
          if (eligible) await rest.put(route, options);
          else await rest.delete(route, options);
        } catch (error) {
          if (error.code !== 10007) failures++;
        }
      }
      after = members.length === 1000 ? members.at(-1).user.id : undefined;
    } while (after && !stopped);
    if (failures) throw new Error(`Supporter role updates pending for ${failures} members.`);
  }

  function refresh() {
    if (!stopped && !running && client.isReady()) {
      running = reconcile()
        .catch((error) => console.error("Discord Supporter role synchronization failed:", error.code ?? error.message))
        .finally(() => { running = undefined; });
    }
    return running;
  }

  client.on("clientReady", refresh);
  const timer = setInterval(refresh, 5 * 60_000).unref();
  refresh();
  return {
    refresh,
    async close() {
      stopped = true;
      clearInterval(timer);
      client.off("clientReady", refresh);
      await running;
    },
  };
}
