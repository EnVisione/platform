import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hash } from "./store.js";

export const bridgeFailure = (error, status = 400) =>
  Object.assign(new Error(error), { code: error, status });
export const bridgeUuid = (value) => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw bridgeFailure("invalid_player_uuid");
  return value.toLowerCase();
};
export const bridgePlayer = (player, optionalName = false) => {
  const uuid = bridgeUuid(player?.uuid);
  if (
    !(optionalName && player.name === undefined) &&
    (typeof player?.name !== "string" ||
      !/^[A-Za-z0-9_]{3,16}$/.test(player.name))
  )
    throw bridgeFailure("invalid_player_name");
  return { uuid, ...(player.name !== undefined ? { name: player.name } : {}) };
};
const kindOf = (kind) => {
  if (!["staff", "member"].includes(kind))
    throw bridgeFailure("invalid_link_kind");
  return kind;
};
const forever = Number.MAX_SAFE_INTEGER;
const lifetime = 600000;
const opaque = () => randomBytes(32).toString("base64url");
const equal = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  Buffer.byteLength(left) === Buffer.byteLength(right) &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function proxyAuthenticator(settings, store, now = Date.now, keys) {
  if (!keys) {
    const path = settings.proxyKeysFile;
    if (!isAbsolute(path ?? ""))
      throw new Error("Minecraft proxy key file must be absolute");
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      stat.size > 4096 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error(
        "Minecraft proxy key file must be a private owned regular file",
      );
    keys = JSON.parse(readFileSync(path, "utf8"));
  }
  const trusted = new Map();
  for (const [id, value] of Object.entries(keys)) {
    if (!["na", "eu"].includes(id) || typeof value !== "string")
      throw new Error("Invalid Minecraft proxy key configuration");
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== value)
      throw new Error(
        "Minecraft proxy keys must contain 32 base64 encoded bytes",
      );
    trusted.set(id, decoded);
  }
  if (!trusted.has("na"))
    throw new Error("Configure the NA Minecraft proxy key");
  return (headers, raw) => {
    const id = headers["x-drakora-proxy"],
      time = headers["x-drakora-time"],
      nonce = headers["x-drakora-nonce"],
      signature = headers["x-drakora-signature"];
    if (
      !trusted.has(id) ||
      typeof time !== "string" ||
      !/^\d{13}$/.test(time) ||
      Math.abs(now() - Number(time)) > 60000 ||
      typeof nonce !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        nonce,
      ) ||
      typeof signature !== "string" ||
      !/^[0-9a-f]{64}$/.test(signature) ||
      !Buffer.isBuffer(raw) ||
      raw.length > 32768
    )
      throw bridgeFailure("proxy_authentication_failed", 401);
    const expected = createHmac("sha256", trusted.get(id))
      .update(`${id}\n${time}\n${nonce}\n`)
      .update(raw)
      .digest("hex");
    if (!equal(expected, signature))
      throw bridgeFailure("proxy_authentication_failed", 401);
    store.transaction(() => {
      const key = hash(`${id}:${nonce}`);
      if (store.get("minecraft-proxy-nonce", key))
        throw bridgeFailure("proxy_replay", 409);
      store.set("minecraft-proxy-nonce", key, true, now() + 120000);
    });
    return id;
  };
}

export function minecraftLinkService(
  config,
  store,
  registry,
  dependencies = {},
) {
  const now = dependencies.now ?? Date.now;
  const owner = (uuid) => store.get("minecraft-owner", uuid);
  const byDiscord = (id) => store.get("minecraft-discord-owner", id);
  const save = (value) =>
    store.set("minecraft-owner", value.uuid, value, forever);
  const audit = (event, value) =>
    store.set(
      "minecraft-link-audit",
      `${now()}:${opaque()}`,
      {
        event,
        uuid: value.uuid,
        discordId: value.discord?.id,
        kind: value.kind,
        at: now(),
      },
      now() + 90 * 86400000,
    );
  function challenge(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
      throw bridgeFailure("link_expired", 410);
    const saved = store.get("minecraft-link-challenge", hash(value));
    if (!saved || saved.expiresAt <= now())
      throw bridgeFailure("link_expired", 410);
    return saved;
  }
  function flags(value) {
    return {
      staffLinked: Boolean(value?.staffLinked),
      memberLinked: Boolean(value?.memberLinked),
    };
  }
  function pending(player, kind) {
    const id = store.get("minecraft-link-pending", `${player.uuid}:${kind}`);
    if (!id) return undefined;
    const value = store.get("minecraft-link-challenge", id);
    return value?.expiresAt > now() ? value : undefined;
  }
  async function eligibleStaff(id) {
    if (!dependencies.assertStaff) return false;
    try {
      await dependencies.assertStaff(id);
      return true;
    } catch (error) {
      if (error.code === "staff_admission_required") return false;
      throw error;
    }
  }
  const publicChallenge = (value) => ({
    player: value.player,
    kind: value.kind,
    state: value.discord ? "approved" : "pending",
    ...(value.kind === "staff" || value.staffApproved === true
      ? { staffVerification: true }
      : {}),
    expiresAt: value.expiresAt,
    ...(value.discord ? { discord: value.discord } : {}),
  });
  return {
    owner,
    byDiscord,
    entries: () => store.entries("minecraft-owner"),
    begin(input) {
      const player = bridgePlayer(input.player),
        kind = kindOf(input.kind);
      return store.transaction(() => {
        const existing = pending(player, kind);
        const value = existing ?? {
          token: opaque(),
          player,
          kind,
          expiresAt: now() + lifetime,
        };
        if (!existing) {
          store.set(
            "minecraft-link-challenge",
            hash(value.token),
            value,
            value.expiresAt,
          );
          store.set(
            "minecraft-link-pending",
            `${player.uuid}:${kind}`,
            hash(value.token),
            value.expiresAt,
          );
        }
        const origin = config.staffOrigin;
        return {
          ok: true,
          state: "pending",
          url: `${origin}/minecraft/link#challenge=${value.token}`,
          expiresAt: value.expiresAt,
        };
      });
    },
    preview(token) {
      return publicChallenge(challenge(token));
    },
    async approve(token, identity, staffAdmitted = false, verifyStaff = false) {
      const saved = challenge(token);
      if (!/^\d{1,20}$/.test(identity?.id) || typeof identity.name !== "string")
        throw bridgeFailure("discord_login_required", 401);
      if (saved.kind === "staff" && !staffAdmitted)
        throw bridgeFailure("staff_admission_required", 403);
      if (saved.kind === "staff" && dependencies.assertStaff)
        await dependencies.assertStaff(identity.id);
      const staffApproved =
        saved.kind === "member" && verifyStaff === true &&
        (await eligibleStaff(identity.id));
      return store.transaction(() => {
        const current = challenge(token);
        const occupied = owner(current.player.uuid),
          other = byDiscord(identity.id);
        if (
          (occupied && occupied.discord.id !== identity.id) ||
          (other && other.uuid !== current.player.uuid)
        )
          throw bridgeFailure("minecraft_ownership_conflict", 409);
        if (current.discord && current.discord.id !== identity.id)
          throw bridgeFailure("link_already_approved", 409);
        current.discord = { id: identity.id, name: identity.name.slice(0, 80) };
        current.staffApproved = staffApproved;
        current.confirmationCode ??= opaque();
        current.approvedAt ??= now();
        store.set(
          "minecraft-link-challenge",
          hash(token),
          current,
          current.expiresAt,
        );
        return { ok: true, ...publicChallenge(current) };
      });
    },
    status(input) {
      const player = bridgePlayer(input.player),
        kind = kindOf(input.kind),
        value = owner(player.uuid);
      const waiting = pending(player, kind);
      if (waiting)
        return {
          ok: true,
          ...flags(value),
          state: waiting.discord ? "approved" : "pending",
          ...(waiting.discord
            ? {
                discord: waiting.discord,
                confirmationCode: waiting.confirmationCode,
              }
            : {}),
        };
      return {
        ok: true,
        ...flags(value),
        state: value?.[`${kind}Linked`] ? "linked" : "unlinked",
        ...(value ? { discord: value.discord } : {}),
      };
    },
    async confirm(input) {
      const player = bridgePlayer(input.player),
        kind = kindOf(input.kind);
      const waiting = pending(player, kind);
      if (
        !waiting ||
        !waiting.discord ||
        !equal(waiting.confirmationCode, input.code)
      )
        throw bridgeFailure("invalid_confirmation", 409);
      if (kind === "staff")
        await dependencies.assertStaff?.(waiting.discord.id);
      const staffEligible =
        waiting.staffApproved === true && (await eligibleStaff(waiting.discord.id));
      const { value, consents } = store.transaction(() => {
        const current = pending(player, kind);
        if (!current?.discord || !equal(current.confirmationCode, input.code))
          throw bridgeFailure("invalid_confirmation", 409);
        const existing = owner(player.uuid),
          other = byDiscord(current.discord.id);
        if (
          (existing && existing.discord.id !== current.discord.id) ||
          (other && other.uuid !== player.uuid)
        )
          throw bridgeFailure("minecraft_ownership_conflict", 409);
        const verifiedKinds = [kind];
        if (kind === "member" && current.staffApproved && staffEligible)
          verifiedKinds.push("staff");
        const consents = verifiedKinds.map((category) => ({
          category,
          first: !existing?.[`${category}Linked`],
        }));
        const linked = {
          ...existing,
          uuid: player.uuid,
          name: player.name,
          discord: current.discord,
          verifiedAt: existing?.verifiedAt ?? now(),
        };
        for (const category of verifiedKinds) {
          linked[`${category}Linked`] = true;
          linked[`${category}ConsentAt`] = now();
        }
        if (verifiedKinds.includes("staff"))
          registry.verify(current.discord.id, player);
        save(linked);
        store.set(
          "minecraft-discord-owner",
          linked.discord.id,
          { uuid: linked.uuid },
          forever,
        );
        store.delete("minecraft-link-pending", `${player.uuid}:${kind}`);
        store.delete("minecraft-link-challenge", hash(current.token));
        audit("confirmed", { ...linked, kind });
        return { value: linked, consents };
      });
      if (dependencies.onLinked)
        await Promise.all(
          consents.map(({ category, first }) =>
            dependencies.onLinked(value, category, first),
          ),
        );
      return {
        ok: true,
        state: "linked",
        ...flags(value),
        discord: value.discord,
      };
    },
  };
}

export function eraseMinecraftStaffIdentity(store, discordId) {
  const pointer = store.get("minecraft-discord-owner", discordId);
  const owner = pointer && store.get("minecraft-owner", pointer.uuid);
  if (owner) {
    store.delete("minecraft-rank-job", `${owner.uuid}:staff`);
    if (owner.memberLinked) {
      owner.staffLinked = false;
      delete owner.staffConsentAt;
      store.set("minecraft-owner", owner.uuid, owner, forever);
      const ranks = store.get("minecraft-ranks", owner.uuid);
      if (ranks) {
        delete ranks.jobs.staff;
        ranks.staffBootstrap = false;
        store.set("minecraft-ranks", owner.uuid, ranks, forever);
      }
    } else {
      store.delete("minecraft-owner", owner.uuid);
      store.delete("minecraft-discord-owner", discordId);
      store.delete("minecraft-ranks", owner.uuid);
      store.delete("minecraft-rank-job", `${owner.uuid}:store`);
    }
  }
  for (const [key, value] of store.entries("minecraft-link-challenge"))
    if (value.kind === "staff" && value.discord?.id === discordId) {
      store.delete("minecraft-link-challenge", key);
      store.delete("minecraft-link-pending", `${value.player.uuid}:staff`);
    }
}
