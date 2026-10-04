import { GatewayIntentBits } from "discord.js";

const rosters = new WeakMap();

export async function discordMembers(client, guild) {
  if (guild.available === false) throw new Error("Discord guild unavailable");
  let state = rosters.get(client);
  if (!state) {
    state = new Map();
    rosters.set(client, state);
    const reset = () => state.clear();
    for (const event of ["clientReady", "shardDisconnect", "shardResume"])
      client.on?.(event, reset);
    client.on?.("guildUnavailable", (unavailable) =>
      state.delete(unavailable.id),
    );
  }
  let roster = state.get(guild.id);
  if (!roster) {
    roster = {};
    state.set(guild.id, roster);
    roster.loading = (async () => {
      try {
        const options = client.options?.intents?.has(
          GatewayIntentBits.GuildPresences,
        )
          ? { withPresences: true }
          : undefined;
        const members = await guild.members.fetch(options);
        if (state.get(guild.id) !== roster)
          throw new Error("Discord membership changed while loading");
        roster.members = members;
      } catch (error) {
        if (state.get(guild.id) === roster) state.delete(guild.id);
        throw error;
      }
    })();
  }
  await roster.loading;
  if (state.get(guild.id) !== roster)
    throw new Error("Discord membership changed while loading");
  // Discord updates this cache on member joins, departures and role changes.
  return guild.members.cache ?? roster.members;
}
