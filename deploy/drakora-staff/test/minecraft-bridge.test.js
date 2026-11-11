import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import express from "express";
import session from "express-session";
import { openStore } from "../server/store.js";
import { minecraftRegistry } from "../server/minecraft.js";
import {
  minecraftLinkService,
  proxyAuthenticator,
} from "../server/minecraft-bridge.js";
import { minecraftBridgeRouter } from "../server/minecraft-bridge-routes.js";
import { validateMinecraftBridge } from "../server/minecraft-bridge-config.js";

const player = {
  uuid: "12345678-1234-4234-8234-123456789012",
  name: "FirstPlayer",
};
const second = {
  uuid: "12345678-1234-4234-8234-123456789013",
  name: "SecondPlayer",
};
const identity = { id: "42", name: "Discord Player" };
const settings = {
  staffOrigin: "https://staff.test",
  storefront: { origin: "https://store.test" },
  office: {},
  guildId: "1",
  accessRoles: { dashboard: "10" },
  ranks: [{ id: "20", name: "Helper" }],
  roleSync: { guildId: "2", roles: [{ staffId: "20", mainId: "120" }] },
  minecraftBridge: {
    enabled: true,
    linkedRoleId: "99",
    proxyKeysFile: "/private/keys.json",
  },
};
const tokenFrom = (begin) =>
  new URLSearchParams(new URL(begin.url).hash.slice(1)).get("challenge");
function setup(t, extra = {}) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const clock = { value: Date.now() },
    calls = [];
  const registry = minecraftRegistry(store);
  const dependencies = {
    now: () => clock.value,
    assertStaff: async (id) => {
      if (id !== "42")
        throw Object.assign(new Error(), {
          code: "staff_admission_required",
          status: 403,
        });
    },
    onLinked: async (value, kind, first) => calls.push({ value, kind, first }),
    ...extra,
  };
  const links = minecraftLinkService(settings, store, registry, dependencies);
  return {
    store,
    clock,
    registry,
    links,
    calls,
    restart: () =>
      minecraftLinkService(settings, store, registry, dependencies),
  };
}
test("link proof is two step, one use, persisted and separate by consent kind", async (t) => {
  const { links, registry, restart, calls } = setup(t);
  const begin = links.begin({ player, kind: "member" }),
    token = tokenFrom(begin);
  assert.equal(new URL(begin.url).search, "");
  assert.equal(links.status({ player, kind: "member" }).state, "pending");
  await links.approve(token, identity);
  assert.equal(links.owner(player.uuid), undefined);
  assert.equal(Object.hasOwn(links.preview(token), "confirmationCode"), false);
  const approved = links.status({ player, kind: "member" });
  assert.equal(approved.discord.id, "42");
  await assert.rejects(
    links.confirm({ player, kind: "member", code: "wrong" }),
    { code: "invalid_confirmation" },
  );
  const result = await links.confirm({
    player,
    kind: "member",
    code: approved.confirmationCode,
  });
  assert.equal(result.memberLinked, true);
  assert.equal(result.staffLinked, false);
  assert.equal(registry.get("42"), undefined);
  assert.equal(restart().status({ player, kind: "member" }).state, "linked");
  await assert.rejects(
    links.confirm({ player, kind: "member", code: approved.confirmationCode }),
    {
      code: "invalid_confirmation",
    },
  );
  const staff = links.begin({ player, kind: "staff" });
  await assert.rejects(links.approve(tokenFrom(staff), identity, false), {
    code: "staff_admission_required",
  });
  await links.approve(tokenFrom(staff), identity, true);
  await links.confirm({
    player,
    kind: "staff",
    code: links.status({ player, kind: "staff" }).confirmationCode,
  });
  assert.equal(registry.get("42").status, "verified");
  assert.equal(registry.get("42").uuid, player.uuid);
  assert.equal(links.owner(player.uuid).memberLinked, true);
  assert.deepEqual(
    calls.map((c) => [c.kind, c.first]),
    [
      ["member", true],
      ["staff", true],
    ],
  );
});
test("pending name reservations neither prove ownership nor block its real owner", async (t) => {
  const { links, registry } = setup(t);
  registry.register("43", player.name);
  registry.register("42", "IncorrectName");
  const token = tokenFrom(links.begin({ player, kind: "staff" }));
  await links.approve(token, identity, true);
  await links.confirm({
    player,
    kind: "staff",
    code: links.status({ player, kind: "staff" }).confirmationCode,
  });
  assert.equal(registry.get("43").status, "pending");
  assert.equal(registry.get("43").uuid, undefined);
  assert.equal(registry.get("42").name, player.name);
  assert.throws(() => registry.requestChange("42", "DifferentName"), {
    code: "minecraft_verification_required",
  });
  assert.equal(registry.get("42").status, "verified");
});
test("concurrent approvals cannot reassign UUID or Discord ownership", async (t) => {
  const { links } = setup(t);
  const a = tokenFrom(links.begin({ player, kind: "member" }));
  const b = tokenFrom(links.begin({ player: second, kind: "member" }));
  await Promise.all([links.approve(a, identity), links.approve(b, identity)]);
  await links.confirm({
    player,
    kind: "member",
    code: links.status({ player, kind: "member" }).confirmationCode,
  });
  await assert.rejects(
    links.confirm({
      player: second,
      kind: "member",
      code: links.status({ player: second, kind: "member" }).confirmationCode,
    }),
    { code: "minecraft_ownership_conflict" },
  );
  const steal = tokenFrom(links.begin({ player, kind: "staff" }));
  await assert.rejects(
    links.approve(steal, { id: "43", name: "Other" }, true),
    { code: "staff_admission_required" },
  );
  await assert.rejects(links.approve(a, { id: "43", name: "Other" }), {
    code: "link_expired",
  });
  const retry = tokenFrom(links.begin({ player, kind: "member" }));
  await assert.rejects(links.approve(retry, { id: "43", name: "Other" }), {
    code: "minecraft_ownership_conflict",
  });
  assert.equal(links.owner(player.uuid).discord.id, "42");
});
test("approval and confirmation expire and staff admission is checked again", async (t) => {
  let allowed = true;
  const { links, clock } = setup(t, {
    assertStaff: async () => {
      if (!allowed)
        throw Object.assign(new Error(), {
          code: "staff_admission_required",
          status: 403,
        });
    },
  });
  const token = tokenFrom(links.begin({ player, kind: "staff" }));
  await links.approve(token, identity, true);
  const code = links.status({ player, kind: "staff" }).confirmationCode;
  allowed = false;
  await assert.rejects(links.confirm({ player, kind: "staff", code }), {
    code: "staff_admission_required",
  });
  assert.equal(links.owner(player.uuid), undefined);
  clock.value += 600001;
  assert.throws(() => links.preview(token), { code: "link_expired" });
  await assert.rejects(links.confirm({ player, kind: "staff", code }), {
    code: "invalid_confirmation",
  });
});
test("a shared link verifies screened staff and preserves ordinary member linking", async (t) => {
  const { links, registry, calls } = setup(t);
  registry.register(identity.id, player.name);
  assert.equal(registry.verifiedStaff(identity.id), false);
  const token = tokenFrom(links.begin({ player, kind: "member" }));
  const approval = await links.approve(token, identity, false, true);
  assert.equal(approval.staffVerification, true);
  assert.equal(registry.verifiedStaff(identity.id), false);
  const verified = await links.confirm({
    player,
    kind: "member",
    code: links.status({ player, kind: "member" }).confirmationCode,
  });
  assert.equal(verified.staffLinked, true);
  assert.equal(verified.memberLinked, true);
  assert.equal(registry.verifiedStaff(identity.id), true);
  assert.deepEqual(calls.map(({ kind, first }) => [kind, first]), [
    ["member", true],
    ["staff", true],
  ]);

  const member = { id: "43", name: "Regular player" };
  const memberToken = tokenFrom(links.begin({ player: second, kind: "member" }));
  const memberApproval = await links.approve(memberToken, member, false, true);
  assert.equal(memberApproval.staffVerification, undefined);
  const ordinary = await links.confirm({
    player: second,
    kind: "member",
    code: links.status({ player: second, kind: "member" }).confirmationCode,
  });
  assert.equal(ordinary.memberLinked, true);
  assert.equal(ordinary.staffLinked, false);
  assert.equal(registry.verifiedStaff(member.id), false);
});

test("leaving the staff server during linking preserves only ordinary verification", async (t) => {
  let active = true;
  const { links, registry } = setup(t, {
    assertStaff: async () => {
      if (!active) throw Object.assign(new Error(), { code: "staff_admission_required" });
    },
  });
  const token = tokenFrom(links.begin({ player, kind: "member" }));
  await links.approve(token, identity, false, true);
  active = false;
  const result = await links.confirm({
    player,
    kind: "member",
    code: links.status({ player, kind: "member" }).confirmationCode,
  });
  assert.equal(result.memberLinked, true);
  assert.equal(result.staffLinked, false);
  assert.equal(registry.verifiedStaff(identity.id), false);
});

function signer(keys, now) {
  return (body, proxy = "na", changes = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    const headers = {
      "x-drakora-proxy": proxy,
      "x-drakora-time": String(now()),
      "x-drakora-nonce": randomUUID(),
      ...changes,
    };
    headers["x-drakora-signature"] = createHmac(
      "sha256",
      Buffer.from(keys[proxy], "base64"),
    )
      .update(
        `${proxy}\n${headers["x-drakora-time"]}\n${headers["x-drakora-nonce"]}\n`,
      )
      .update(raw)
      .digest("hex");
    return { headers, raw };
  };
}
test("HMAC authenticates exact bytes, timestamp, proxy and nonce with transactional replay rejection", (t) => {
  const { store, clock } = setup(t);
  const keys = {
    na: randomBytes(32).toString("base64"),
    eu: randomBytes(32).toString("base64"),
  };
  const authenticate = proxyAuthenticator(
    settings.minecraftBridge,
    store,
    () => clock.value,
    keys,
  );
  const sign = signer(keys, () => clock.value),
    signed = sign({ operation: "status", player, kind: "member" });
  assert.throws(
    () =>
      authenticate(
        signed.headers,
        Buffer.concat([signed.raw, Buffer.from(" ")]),
      ),
    {
      code: "proxy_authentication_failed",
    },
  );
  assert.throws(
    () =>
      authenticate({ ...signed.headers, "x-drakora-proxy": "eu" }, signed.raw),
    {
      code: "proxy_authentication_failed",
    },
  );
  assert.equal(authenticate(signed.headers, signed.raw), "na");
  assert.throws(() => authenticate(signed.headers, signed.raw), {
    code: "proxy_replay",
  });
  const expired = sign({ operation: "poll" }, "na", {
    "x-drakora-time": String(clock.value - 60001),
  });
  assert.throws(() => authenticate(expired.headers, expired.raw), {
    code: "proxy_authentication_failed",
  });
});
test("proxy key file must be private and linking roles cannot overlap staff ranks", (t) => {
  const { store } = setup(t);
  const dir = mkdtempSync(join(tmpdir(), "drakora-bridge-keys-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "keys.json");
  writeFileSync(
    path,
    JSON.stringify({ na: randomBytes(32).toString("base64") }),
    { mode: 0o600 },
  );
  assert.equal(
    typeof proxyAuthenticator({ proxyKeysFile: path }, store),
    "function",
  );
  chmodSync(path, 0o644);
  assert.throws(
    () => proxyAuthenticator({ proxyKeysFile: path }, store),
    /private owned regular/,
  );
  validateMinecraftBridge(settings);
  assert.throws(
    () =>
      validateMinecraftBridge({
        ...settings,
        minecraftBridge: { ...settings.minecraftBridge, linkedRoleId: "20" },
      }),
    /independent/,
  );
  assert.throws(
    () =>
      validateMinecraftBridge({
        ...settings,
        minecraftBridge: {
          ...settings.minecraftBridge,
          staffMappings: [{ roleId: "20", rank: "founder", scope: "network" }],
        },
      }),
    /existing configured staff rank/,
  );
});
test("HTTP proxy rejects EU writes and oversized bodies and browser approval enforces origin and CSRF", async (t) => {
  const { store, links, clock } = setup(t);
  const keys = {
    na: randomBytes(32).toString("base64"),
    eu: randomBytes(32).toString("base64"),
  };
  const sign = signer(keys, () => clock.value);
  const app = express();
  app.use(
    session({
      secret: randomBytes(32).toString("base64"),
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.get("/test-login", (req, res) => {
    req.session.storeIdentity = identity;
    req.session.storeCsrf = "test-csrf";
    res.json({ ok: true });
  });
  app.use(
    minecraftBridgeRouter(
      settings,
      links,
      { poll: async () => ({ ok: true, jobs: [], refresh: [] }) },
      proxyAuthenticator(
        settings.minecraftBridge,
        store,
        () => clock.value,
        keys,
      ),
      {
        dist: "/unused",
        signedIn: async () => {
          throw Object.assign(new Error(), { status: 401 });
        },
      },
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        `${url}${path}`,
        { ...options, agent: false },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              json: async () => JSON.parse(Buffer.concat(chunks).toString()),
              headers: {
                get: (name) => [response.headers[name]].flat().join(";"),
              },
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(options.body);
    });
  const send = (signed) =>
    call("/api/minecraft/proxy", {
      method: "POST",
      headers: {
        Host: "staff.test",
        "Content-Type": "application/json",
        ...signed.headers,
      },
      body: signed.raw,
    });
  let response = await send(sign({ operation: "poll" }, "eu"));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "proxy_writer_required");
  response = await send(
    sign({
      operation: "status",
      player: { uuid: player.uuid, name: player.name },
      kind: "member",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "unlinked");
  response = await send(
    sign({ operation: "begin", player, kind: "member" }, "eu"),
  );
  assert.equal(response.status, 200);
  const token = tokenFrom(await response.json());
  response = await call("/api/minecraft/link/preview", {
    method: "POST",
    headers: {
      Host: "staff.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ challenge: token }),
  });
  const preview = await response.json();
  assert.equal(response.status, 200);
  assert.equal(new URL(preview.continueUrl).origin, settings.storefront.origin);
  assert.equal(new URL(preview.continueUrl).search, "");
  response = await send(sign({ operation: "poll", data: "x".repeat(33000) }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).ok, false);
  const login = await call("/test-login", {
    headers: { Host: "store.test" },
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const approve = (origin, csrf) =>
    call("/api/minecraft/link/approve", {
      method: "POST",
      headers: {
        Host: "store.test",
        Cookie: cookie,
        Origin: origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ challenge: token, verifyStaff: true }),
    });
  assert.equal(
    (await approve("https://attacker.test", "test-csrf")).status,
    403,
  );
  assert.equal((await approve("https://store.test", "wrong")).status, 403);
  response = await approve("https://store.test", "test-csrf");
  assert.equal(response.status, 200);
  const approval = await response.json();
  assert.equal(approval.state, "approved");
  assert.equal(approval.staffVerification, true);
  assert.equal(links.owner(player.uuid), undefined);
});
test("confirmed ownership survives a real encrypted SQLite reopen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "drakora-bridge-persistence-"));
  const key = randomBytes(32).toString("base64"),
    path = join(dir, "identity.sqlite");
  let database = openStore(path, key);
  t.after(() => {
    database.store.close();
    rmSync(dir, { recursive: true });
  });
  let registry = minecraftRegistry(database.store);
  let links = minecraftLinkService(settings, database.store, registry, {
    assertStaff: async () => {},
  });
  const token = tokenFrom(links.begin({ player, kind: "staff" }));
  await links.approve(token, identity, true);
  await links.confirm({
    player,
    kind: "staff",
    code: links.status({ player, kind: "staff" }).confirmationCode,
  });
  database.store.close();
  database = openStore(path, key);
  registry = minecraftRegistry(database.store);
  links = minecraftLinkService(settings, database.store, registry, {
    assertStaff: async () => {},
  });
  assert.equal(links.owner(player.uuid).discord.id, "42");
  assert.equal(links.byDiscord("42").uuid, player.uuid);
  assert.equal(registry.get("42").status, "verified");
  const other = tokenFrom(links.begin({ player: second, kind: "member" }));
  await assert.rejects(links.approve(other, identity), {
    code: "minecraft_ownership_conflict",
  });
});
