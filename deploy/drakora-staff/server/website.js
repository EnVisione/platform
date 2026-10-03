import { AuthError } from "./discord.js";
import { initialWebsite, ruleSections } from "../shared/website.js";

export function websiteAccess(config, user) {
  return Boolean(
    user.permissions?.dashboard &&
      config.ranks.some(
        (rank) =>
          ["Founder", "Manager", "Admin"].includes(rank.name) &&
          user.roles?.includes(rank.id),
      ),
  );
}

function text(value, limit, required = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    /[\0\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value) ||
    (required && !value.trim())
  )
    throw new AuthError("invalid_website_content", 400);
  return value.trim();
}
export function validateWebsite(input) {
  if (
    !input ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !input.rules ||
    !Array.isArray(input.servers) ||
    input.servers.length > 20
  )
    throw new AuthError("invalid_website_content", 400);
  const rules = Object.fromEntries(
    ruleSections.map(({ id }) => [id, text(input.rules[id], 20000, true)]),
  );
  const servers = input.servers.map((entry) => {
    if (
      !entry ||
      typeof entry.published !== "boolean" ||
      !["castle", "forest"].includes(entry.artwork) ||
      !ruleSections.some((section) => section.id === entry.rules)
    )
      throw new AuthError("invalid_website_content", 400);
    const server = {
      slug: text(entry.slug, 60, true),
      name: text(entry.name, 80, true),
      summary: text(entry.summary, 240, true),
      description: text(entry.description, 12000, true),
      address: text(entry.address, 253, true),
      pack: text(entry.pack, 100),
      packVersion: text(entry.packVersion, 60),
      minecraftVersion: text(entry.minecraftVersion, 40),
      downloadUrl: text(entry.downloadUrl, 500),
      worlds: text(entry.worlds, 200),
      joining: text(entry.joining, 6000, true),
      rules: entry.rules,
      artwork: entry.artwork,
      published: entry.published,
    };
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(server.slug) ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i.test(
        server.address,
      ) ||
      (server.address.includes(":") &&
        (Number(server.address.split(":")[1]) < 1 ||
          Number(server.address.split(":")[1]) > 65535))
    )
      throw new AuthError("invalid_website_content", 400);
    if (server.downloadUrl) {
      let url;
      try {
        url = new URL(server.downloadUrl);
      } catch {
        throw new AuthError("invalid_website_content", 400);
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new AuthError("invalid_website_content", 400);
    }
    return server;
  });
  if (new Set(servers.map((server) => server.slug)).size !== servers.length)
    throw new AuthError("duplicate_server_slug", 400);
  return { rules, servers };
}

export function websiteService(config, store) {
  const read = () =>
    store.get("website-content", "current") ?? {
      revision: 0,
      ...structuredClone(initialWebsite),
    };
  const authorize = (user) => {
    if (!websiteAccess(config, user))
      throw new AuthError("website_role_required");
  };
  return {
    read(user) {
      authorize(user);
      return read();
    },
    publicContent() {
      const { rules, servers } = read();
      return {
        rules,
        servers: servers.filter((server) => server.published),
        address: "play.drakora.org",
        discordInvite: config.website.discordInvite,
      };
    },
    save(user, input) {
      authorize(user);
      const content = validateWebsite(input);
      return store.transaction(() => {
        const previous = read();
        if (input.revision !== previous.revision)
          throw new AuthError("website_content_changed", 409);
        const next = {
          ...content,
          revision: previous.revision + 1,
          updatedAt: Date.now(),
          updatedBy: user.id,
        };
        store.set("website-content", "current", next, Number.MAX_SAFE_INTEGER);
        return next;
      });
    },
  };
}

export function communityStatus(config, fetcher = fetch, now = Date.now) {
  let cached,
    refreshAfter = -Infinity,
    pending;
  return async () => {
    if (!pending && now() >= refreshAfter) {
      refreshAfter = now() + 60000;
      pending = (async () => {
        try {
          const response = await fetcher(
            `https://discord.com/api/v10/guilds/${config.website.discordGuildId}?with_counts=true`,
            {
              signal: AbortSignal.timeout(5000),
              headers: {
                Authorization: `Bot ${config.discordBotToken}`,
                "User-Agent": "DiscordBot (https://drakora.org, 1.0)",
              },
            },
          );
          if (response.status === 429) {
            const retry = Number(response.headers.get("Retry-After"));
            if (Number.isFinite(retry) && retry > 0)
              refreshAfter =
                now() + Math.max(60000, Math.min(retry * 1000, 3600000));
          }
          if (!response.ok) return;
          const data = await response.json();
          if (
            Number.isSafeInteger(data.approximate_presence_count) &&
            data.approximate_presence_count >= 0
          )
            cached = {
              active: data.approximate_presence_count,
              checkedAt: now(),
            };
        } catch {
          /* discord counts can be unavailable while the site stays open. */
        }
      })().finally(() => {
        pending = undefined;
      });
    }
    await pending;
    return {
      players: 0,
      discord:
        cached && now() - cached.checkedAt < 15 * 60000
          ? { ...cached, stale: now() - cached.checkedAt >= 60000 }
          : { active: null, checkedAt: null, stale: false },
    };
  };
}
