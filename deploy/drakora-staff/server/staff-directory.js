import { AuthError } from "./discord.js";

export function staffAccountRoster(snapshot, registrations) {
  if (!snapshot?.connected)
    throw new AuthError("discord_unavailable", 503);
  const links = new Map(registrations);
  return new Map(
    snapshot.members
      .filter(
        (member) =>
          !member.bot &&
          !member.pending &&
          (member.staff || links.has(member.id)),
      )
      .map((member) => [
        member.id,
        { member, minecraft: links.get(member.id) ?? null },
      ]),
  );
}

export function staffDirectory(config, roster, minecraft) {
  return async () => {
    const people = await roster();
    const groups = config.ranks.map((rank) => ({
      name: rank.name,
      members: [],
    }));
    for (const person of people) {
      if (person.bot || person.pending) continue;
      const ranks = config.ranks
        .filter((rank) => person.roles.includes(rank.id))
        .map((rank) => rank.name);
      if (!ranks.length) continue;
      const link = minecraft(person.id);
      groups
        .find((group) => group.name === ranks[0])
        .members.push({
          name: person.name,
          minecraft: link?.name || null,
          ranks,
        });
    }
    for (const group of groups)
      group.members.sort((a, b) => a.name.localeCompare(b.name));
    return {
      groups: groups.filter((group) => group.members.length),
      total: groups.reduce((total, group) => total + group.members.length, 0),
    };
  };
}
