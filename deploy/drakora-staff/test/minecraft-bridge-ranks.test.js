import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import { minecraftRegistry } from "../server/minecraft.js";
import {
  minecraftLinkService,
  eraseMinecraftStaffIdentity,
} from "../server/minecraft-bridge.js";
import { minecraftRankBridge } from "../server/minecraft-bridge-ranks.js";

const player = {
  uuid: "12345678-1234-4234-8234-123456789012",
  name: "RankPlayer",
};
const config = {
  staffOrigin: "https://staff.test",
  storefront: { origin: "https://store.test" },
  guildId: "1",
  accessRoles: { dashboard: "10" },
  roleSync: {
    guildId: "2",
    roles: [
      { staffId: "20", mainId: "120" },
      { staffId: "21", mainId: "121" },
    ],
  },
  minecraftBridge: {
    enabled: true,
    rankSyncEnabled: true,
    linkedRoleId: "99",
    staffMappings: [{ roleId: "20", rank: "helper", scope: "rh" }],
    storeMappings: [
      { roleId: "200", rank: "wyrm", scope: "rh" },
      { roleId: "201", rank: "wyrm", scope: "prom2" },
      { roleId: "202", rank: "archwyrm", scope: "network" },
      { roleId: "203", rank: "dragon", scope: "rh" },
      { roleId: "204", rank: "drake", scope: "rh" },
    ],
  },
};
const rank = (name, scope, expiresAt = null) => ({
  rank: name,
  scope,
  expiresAt,
});
function setup(t, options = {}) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const clock = { value: Date.now() },
    changes = [],
    gatewayTasks = [],
    callbacks = new Set(),
    assignments = [];
  const environment = {
    online: true,
    member: true,
    pending: false,
    blocked: false,
    roles: [...(options.roles ?? ["900", "10"])],
    staff: ["10", "20", "21"],
  };
  const transport = {
    async member() {
      if (!environment.online) throw { code: "discord_unavailable" };
      return environment.member
        ? { roles: [...environment.roles], pending: environment.pending }
        : null;
    },
    async assertStaff() {
      if (!environment.online || !environment.staff.includes("10"))
        throw { code: "staff_admission_required" };
      return { roles: [...environment.staff] };
    },
    async validate(ids) {
      if (environment.blocked) throw { code: "cosmetic_role_unavailable" };
      assert.equal(
        ids.every((id) =>
          ["99", "200", "201", "202", "203", "204"].includes(id),
        ),
        true,
      );
    },
    async change(_id, id, add) {
      assert.equal(["10", "900"].includes(id), false);
      await environment.beforeChange?.(id, add);
      environment.roles = add
        ? [...environment.roles, id]
        : environment.roles.filter((r) => r !== id);
      changes.push({ id, add });
      // gateway callbacks do not block rest requests.
      const observed = ranks.observe({
        t: "GUILD_MEMBER_UPDATE",
        d: { guild_id: "2", user: { id: "42" }, roles: [...environment.roles] },
      });
      observed.catch(() => {});
      gatewayTasks.push(observed);
      await environment.afterChange?.(id, add);
    },
  };
  store.set(
    "discord-role-sync",
    "42",
    { id: "42", version: 1, roles: ["20", "21"] },
    Number.MAX_SAFE_INTEGER,
  );
  const staffSync = {
    onIntent(fn) {
      callbacks.add(fn);
      return () => callbacks.delete(fn);
    },
    async setDesired(id, roles, origin) {
      const value = {
        id,
        roles,
        origin,
        version: (store.get("discord-role-sync", id)?.version ?? 0) + 1,
      };
      store.set("discord-role-sync", id, value, Number.MAX_SAFE_INTEGER);
      assignments.push(value);
      for (const fn of callbacks) fn(value);
    },
  };
  let ranks;
  const registry = minecraftRegistry(store);
  const links = minecraftLinkService(config, store, registry, {
    now: () => clock.value,
    assertStaff: transport.assertStaff,
    onLinked: (value, kind, first) => ranks.linked(value, kind, first),
  });
  const localConfig = {
    ...config,
    minecraftBridge: {
      ...config.minecraftBridge,
      rankSyncEnabled: options.enabled !== false,
    },
  };
  const create = () =>
    minecraftRankBridge(
      localConfig,
      store,
      links,
      transport,
      staffSync,
      () => clock.value,
    );
  ranks = create();
  t.after(async () => {
    try {
      await Promise.all(gatewayTasks);
    } finally {
      await ranks.close();
      store.close();
    }
  });
  return {
    links,
    store,
    clock,
    changes,
    environment,
    assignments,
    get ranks() {
      return ranks;
    },
    enable() {
      localConfig.minecraftBridge.rankSyncEnabled = true;
    },
    async restart() {
      await ranks.close();
      ranks = create();
    },
    async link(kind = "member") {
      const begin = links.begin({ player, kind });
      const token = new URLSearchParams(new URL(begin.url).hash.slice(1)).get(
        "challenge",
      );
      await links.approve(
        token,
        { id: "42", name: "Rank Discord" },
        kind === "staff",
      );
      return links.confirm({
        player,
        kind,
        code: links.status({ player, kind }).confirmationCode,
      });
    },
    observe(roles, extra = {}) {
      environment.roles = roles;
      return ranks.observe({
        t: "GUILD_MEMBER_UPDATE",
        d: { guild_id: "2", user: { id: "42" }, roles, ...extra },
      });
    },
    intent(roles) {
      staffSync.setDesired("42", roles, "discord");
    },
  };
}
test("fresh member links grant only Linked and do not revoke cosmetic roles from missing or empty initial snapshots", async (t) => {
  const s = setup(t, { roles: ["900", "10", "200"] });
  await s.ranks.snapshot({ player, ranks: [], revision: 0 });
  assert.equal(s.store.get("minecraft-ranks", player.uuid), undefined);
  await s.link();
  assert.equal(s.environment.roles.includes("99"), true);
  assert.equal(s.environment.roles.includes("200"), true);
  await s.ranks.snapshot({ player, ranks: [], revision: 1 });
  assert.equal(s.environment.roles.includes("200"), true);
  assert.deepEqual((await s.ranks.poll()).refresh, [player.uuid]);
  await s.ranks.snapshot({ player, ranks: [rank("wyrm", "rh")], revision: 1 });
  assert.equal(s.store.get("minecraft-ranks", player.uuid).memberReady, true);
  assert.equal((await s.ranks.poll()).jobs.length, 0);
});
test("positive game snapshots replace only mapped cosmetic scopes and suppress Discord echoes", async (t) => {
  const s = setup(t);
  await s.link();
  const source = [
    rank("wyrm", "rh"),
    rank("wyrm", "prom2"),
    rank("archwyrm", "network"),
  ];
  await s.ranks.snapshot({ player, ranks: source, revision: 1 });
  assert.deepEqual(
    new Set(s.environment.roles),
    new Set(["900", "10", "99", "200", "201", "202"]),
  );
  await s.observe([...s.environment.roles]);
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  const next = source.filter((r) => r.scope !== "rh");
  await s.ranks.snapshot({ player, ranks: next, revision: 2 });
  assert.equal(s.environment.roles.includes("200"), false);
  assert.equal(s.environment.roles.includes("201"), true);
  assert.equal(s.environment.roles.includes("202"), true);
  assert.equal(s.environment.roles.includes("10"), true);
  await s.ranks.snapshot({ player, ranks: source, revision: 1 });
  assert.equal(s.environment.roles.includes("200"), false);
  await assert.rejects(
    s.ranks.snapshot({ player, ranks: source, revision: 2 }),
    { code: "rank_revision_conflict" },
  );
});
test("Discord changes queue durable leased scoped jobs and acknowledgments cannot overwrite another player or revision", async (t) => {
  const s = setup(t);
  await s.link();
  const source = [
    rank("wyrm", "rh"),
    rank("wyrm", "prom2"),
    rank("archwyrm", "network"),
  ];
  await s.ranks.snapshot({ player, ranks: source, revision: 1 });
  await s.observe(s.environment.roles.filter((r) => r !== "200"));
  await s.ranks.snapshot({ player, ranks: source, revision: 2 });
  await s.ranks.snapshot({ player, ranks: source, revision: 3 });
  assert.equal(s.environment.roles.includes("200"), false);
  const first = (await s.ranks.poll()).jobs[0];
  assert.equal(first.category, "store");
  assert.deepEqual(first.assignments, [
    rank("archwyrm", "network"),
    rank("wyrm", "prom2"),
  ]);
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  await s.restart();
  s.clock.value += 30001;
  const again = (await s.ranks.poll()).jobs[0];
  assert.equal(again.id === first.id, true);
  assert.equal(again.revision, first.revision);
  await assert.rejects(
    s.ranks.ack({
      ...first,
      revision: first.revision + 1,
      success: true,
      ranks: first.assignments,
    }),
    { code: "rank_job_not_found" },
  );
  await assert.rejects(
    s.ranks.ack({
      ...first,
      uuid: "12345678-1234-4234-8234-123456789013",
      success: true,
      ranks: first.assignments,
    }),
    { code: "rank_job_not_found" },
  );
  await assert.rejects(
    s.ranks.ack({ ...first, success: true, ranks: source }),
    { code: "rank_ack_mismatch" },
  );
  await s.ranks.ack({
    ...first,
    success: false,
    error: "do not persist raw message text",
    ranks: source,
  });
  assert.equal(
    s.store.get("minecraft-rank-job", `${player.uuid}:store`).error,
    "proxy_apply_failed",
  );
  s.clock.value += 60000;
  await s.ranks.ack({ ...first, success: true, ranks: first.assignments });
  await s.ranks.ack({ ...first, success: true, ranks: first.assignments });
  await s.ranks.snapshot({ player, ranks: source, revision: 3 });
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  assert.equal(s.environment.roles.includes("200"), false);
});
test("saved game expiry is preserved and new manual Discord grants have no synthetic subscription timer", async (t) => {
  const s = setup(t);
  await s.link();
  const expiresAt = Math.floor(s.clock.value / 1000) + 60;
  const permanent = rank("wyrm", "rh");
  await s.ranks.snapshot({
    player,
    ranks: [permanent, rank("dragon", "rh", expiresAt)],
    revision: 1,
  });
  await s.observe([...s.environment.roles, "201"]);
  let job = (await s.ranks.poll()).jobs[0];
  assert.equal(
    job.assignments.find((r) => r.rank === "dragon").expiresAt,
    expiresAt,
  );
  await s.ranks.ack({ ...job, success: true, ranks: job.assignments });
  s.clock.value += 61000;
  await s.ranks.retry();
  assert.equal(s.environment.roles.includes("203"), false);
  assert.equal(s.environment.roles.includes("200"), true);
  await s.observe([...s.environment.roles, "203"]);
  job = (await s.ranks.poll()).jobs[0];
  assert.equal(
    job.assignments.find((r) => r.rank === "dragon").expiresAt,
    null,
  );
  await s.ranks.ack({ ...job, success: true, ranks: job.assignments });
  await s.ranks.snapshot({
    player,
    ranks: [permanent, rank("wyrm", "prom2")],
    revision: 2,
  });
  assert.equal(s.environment.roles.includes("203"), false);
  assert.equal(s.environment.roles.includes("200"), true);
});
test("missing members, screening, outages and role hierarchy errors retain desired game ranks without cancellation", async (t) => {
  const s = setup(t);
  await s.link();
  s.environment.blocked = true;
  await s.ranks.snapshot({ player, ranks: [rank("wyrm", "rh")], revision: 1 });
  assert.equal(s.environment.roles.includes("200"), false);
  assert.equal(
    s.store.get("minecraft-ranks", player.uuid).error,
    "cosmetic_role_unavailable",
  );
  await s.restart();
  s.environment.blocked = false;
  s.environment.member = false;
  await s.ranks.retry();
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  s.environment.member = true;
  s.environment.pending = true;
  await s.ranks.retry();
  assert.equal(s.environment.roles.includes("200"), false);
  s.environment.pending = false;
  s.environment.online = false;
  await s.ranks.retry();
  assert.equal(
    s.store.get("minecraft-ranks", player.uuid).desiredStore.length,
    1,
  );
  s.environment.online = true;
  await s.ranks.retry();
  assert.equal(s.environment.roles.includes("200"), true);
  await s.ranks.observe({
    t: "GUILD_MEMBER_REMOVE",
    d: { guild_id: "2", user: { id: "42" } },
  });
  await s.ranks.observe({
    t: "GUILD_ROLE_DELETE",
    d: { guild_id: "2", role_id: "200" },
  });
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  assert.equal(
    s.store.get("minecraft-ranks", player.uuid).desiredStore.length,
    1,
  );
});
test("staff consent uses the existing intent hook, preserves unmapped staff roles and suppresses game echoes", async (t) => {
  const s = setup(t);
  await s.link("staff");
  let job = (await s.ranks.poll()).jobs[0];
  assert.deepEqual(job.assignments, [rank("helper", "rh")]);
  await s.ranks.snapshot({ player, ranks: [], revision: 1 });
  assert.equal(s.assignments.length, 0);
  await s.ranks.ack({ ...job, success: true, ranks: job.assignments });
  await s.ranks.snapshot({ player, ranks: [], revision: 2 });
  assert.deepEqual(s.assignments.at(-1).roles, ["21"]);
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  s.intent(["20", "21"]);
  job = (await s.ranks.poll()).jobs[0];
  assert.equal(job.category, "staff");
  s.environment.staff = ["20", "21"];
  s.clock.value += 30001;
  assert.equal((await s.ranks.poll()).jobs.length, 0);
});
test("privacy retirement drops only staff consent and does not cancel member cosmetics or game purchases", async (t) => {
  const s = setup(t);
  await s.link();
  await s.link("staff");
  await s.ranks.snapshot({
    player,
    ranks: [rank("wyrm", "rh"), rank("helper", "rh")],
    revision: 1,
  });
  const before = [...s.environment.roles];
  s.store.transaction(() => eraseMinecraftStaffIdentity(s.store, "42"));
  assert.equal(s.links.owner(player.uuid).staffLinked, false);
  assert.equal(s.links.owner(player.uuid).memberLinked, true);
  assert.deepEqual(s.environment.roles, before);
  assert.equal(
    s.store.get("minecraft-rank-job", `${player.uuid}:staff`),
    undefined,
  );
  assert.equal(
    s.store.get("minecraft-ranks", player.uuid).desiredStore.length,
    1,
  );
});
test("a new Prominence game rank merges with a pending Restless Discord removal", async (t) => {
  const s = setup(t);
  await s.link();
  await s.ranks.snapshot({ player, ranks: [rank("wyrm", "rh")], revision: 1 });
  await s.observe(s.environment.roles.filter((id) => id !== "200"));
  const original = (await s.ranks.poll()).jobs[0];
  await s.ranks.snapshot({
    player,
    ranks: [rank("wyrm", "rh"), rank("wyrm", "prom2")],
    revision: 2,
  });
  const merged = (await s.ranks.poll()).jobs[0];
  assert.deepEqual(merged.assignments, [rank("wyrm", "prom2")]);
  assert.equal(merged.revision > original.revision, true);
  assert.equal(s.environment.roles.includes("200"), false);
  assert.equal(s.environment.roles.includes("201"), true);
  await assert.rejects(s.ranks.ack({ ...original, success: true, ranks: [] }), {
    code: "rank_job_not_found",
  });
});
test("Gateway intent survives REST failure and restart without copying the old game rank back", async (t) => {
  const s = setup(t);
  await s.link();
  await s.ranks.snapshot({ player, ranks: [rank("wyrm", "rh")], revision: 1 });
  s.environment.online = false;
  await s.observe(s.environment.roles.filter((id) => id !== "200"));
  assert.equal(
    s.store.get("minecraft-ranks", player.uuid).pendingStore.includes("200"),
    false,
  );
  await s.restart();
  await s.ranks.retry();
  assert.equal(s.environment.roles.includes("200"), false);
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  s.environment.online = true;
  await s.ranks.retry();
  const job = (await s.ranks.poll()).jobs[0];
  assert.deepEqual(job.assignments, []);
  s.environment.member = false;
  s.clock.value += 30001;
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  s.environment.member = true;
  assert.equal((await s.ranks.poll()).jobs[0].id === job.id, true);
});
test("concurrent polls cannot lease the same staff job twice", async (t) => {
  const s = setup(t);
  await s.link("staff");
  const results = await Promise.all([s.ranks.poll(), s.ranks.poll()]);
  assert.equal(results.flatMap((r) => r.jobs).length, 1);
});
test("a pending staff demotion is not undone by an old game snapshot during NA outage and retry", async (t) => {
  const s = setup(t);
  await s.link("staff");
  const initial = (await s.ranks.poll()).jobs[0];
  await s.ranks.ack({ ...initial, success: true, ranks: initial.assignments });
  await s.ranks.snapshot({
    player,
    ranks: [rank("helper", "rh")],
    revision: 1,
  });
  s.intent(["21"]);
  s.environment.online = false;
  await s.ranks.retry();
  assert.deepEqual(s.store.get("discord-role-sync", "42").roles, ["21"]);
  s.environment.online = true;
  await s.ranks.retry();
  assert.deepEqual(s.store.get("discord-role-sync", "42").roles, ["21"]);
  await s.ranks.snapshot({
    player,
    ranks: [rank("helper", "rh")],
    revision: 2,
  });
  const removal = (await s.ranks.poll()).jobs[0];
  assert.deepEqual(removal.assignments, []);
  await s.ranks.ack({ ...removal, success: false, ranks: [] });
  await s.ranks.retry();
  assert.deepEqual(s.store.get("discord-role-sync", "42").roles, ["21"]);
  await s.ranks.ack({ ...removal, success: true, ranks: [] });
  await s.ranks.retry();
  assert.deepEqual(s.store.get("discord-role-sync", "42").roles, ["21"]);
});
test(
  "an in flight game copy cannot restore a newer deliberately removed Discord rank",
  { timeout: 2000 },
  async (t) => {
    let release, entered;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    t.after(() => release());
    const s = setup(t);
    await s.link();
    await s.ranks.snapshot({ player, ranks: [], revision: 1 });
    s.environment.afterChange = async (id, add) => {
      if (id === "200" && add) {
        entered();
        await held;
      }
    };
    const copying = s.ranks.snapshot({
      player,
      ranks: [rank("wyrm", "rh")],
      revision: 2,
    });
    await started;
    const removing = s.observe(
      s.environment.roles.filter((id) => id !== "200"),
    );
    release();
    await Promise.all([copying, removing]);
    assert.equal(s.environment.roles.includes("200"), false);
    await s.ranks.retry();
    assert.equal(s.environment.roles.includes("200"), false);
    assert.deepEqual((await s.ranks.poll()).jobs[0].assignments, []);
  },
);
test("mapping replacement requires a fresh game baseline and does not replay queued revocations", async (t) => {
  const s = setup(t);
  await s.link();
  await s.ranks.snapshot({ player, ranks: [rank("wyrm", "rh")], revision: 1 });
  s.environment.blocked = true;
  await s.observe(s.environment.roles.filter((id) => id !== "200"));
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  const value = s.store.get("minecraft-ranks", player.uuid);
  value.mappingVersion = "old-mapping";
  s.store.set("minecraft-ranks", player.uuid, value, Number.MAX_SAFE_INTEGER);
  await s.restart();
  s.environment.blocked = false;
  assert.equal(s.store.get("minecraft-ranks", player.uuid).memberReady, false);
  assert.equal(
    s.store.get("minecraft-ranks", player.uuid).pendingStore,
    undefined,
  );
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  await s.ranks.snapshot({ player, ranks: [rank("wyrm", "rh")], revision: 1 });
  assert.equal(s.environment.roles.includes("200"), true);
});
test("poll batches cap jobs and refresh requests together at thirty two", async (t) => {
  const s = setup(t);
  for (let i = 0; i < 33; i++) {
    const uuid = `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`,
      id = `job-${i}`;
    s.store.set(
      "minecraft-owner",
      uuid,
      { uuid, discord: { id: String(100 + i) }, memberLinked: true },
      Number.MAX_SAFE_INTEGER,
    );
    s.store.set(
      "minecraft-ranks",
      uuid,
      { uuid, revision: 1, refresh: true, jobs: { store: id } },
      Number.MAX_SAFE_INTEGER,
    );
    s.store.set(
      "minecraft-rank-job",
      `${uuid}:store`,
      {
        id,
        uuid,
        revision: 1,
        category: "store",
        assignments: [],
        status: "pending",
        nextAt: 0,
        leaseUntil: 0,
      },
      Number.MAX_SAFE_INTEGER,
    );
  }
  let result = await s.ranks.poll();
  assert.equal(result.jobs.length, 32);
  assert.equal(result.jobs.length + result.refresh.length, 32);
  result = await s.ranks.poll();
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs.length + result.refresh.length, 32);
});
test("confirmed staff revocation still reaches the game after Dashboard removal while new grants wait for admission", async (t) => {
  const s = setup(t);
  await s.link("staff");
  let current = (await s.ranks.poll()).jobs[0];
  await s.ranks.ack({ ...current, success: true, ranks: current.assignments });
  s.environment.staff = ["21"];
  s.intent(["21"]);
  current = (await s.ranks.poll()).jobs[0];
  assert.deepEqual(current.assignments, []);
  await s.ranks.ack({ ...current, success: true, ranks: [] });
  s.intent(["20", "21"]);
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  s.environment.staff = ["10", "20", "21"];
  assert.deepEqual((await s.ranks.poll()).jobs[0].assignments, [
    rank("helper", "rh"),
  ]);
});
test("staff linked before rank synchronization is enabled bootstrap from Discord before an empty game snapshot", async (t) => {
  const s = setup(t, { enabled: false });
  await s.link("staff");
  assert.equal(
    s.store.get("minecraft-ranks", player.uuid).staffBootstrap,
    true,
  );
  assert.equal((await s.ranks.poll()).jobs.length, 0);
  s.enable();
  await s.restart();
  await s.ranks.snapshot({ player, ranks: [], revision: 1 });
  assert.deepEqual(s.store.get("discord-role-sync", "42").roles, ["20", "21"]);
  const job = (await s.ranks.poll()).jobs[0];
  assert.deepEqual(job.assignments, [rank("helper", "rh")]);
  await s.ranks.retry();
  assert.deepEqual(s.store.get("discord-role-sync", "42").roles, ["20", "21"]);
});
test(
  "a different RH Discord change cannot resurrect a cancelled Dragon during its pending copy",
  { timeout: 2000 },
  async (t) => {
    let release, entered;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    t.after(() => release());
    const s = setup(t);
    await s.link();
    const permanent = rank("wyrm", "rh");
    await s.ranks.snapshot({
      player,
      ranks: [permanent, rank("dragon", "rh")],
      revision: 1,
    });
    s.environment.beforeChange = async (id, add) => {
      if (id === "203" && !add) {
        entered();
        await held;
      }
    };
    const cancelling = s.ranks.snapshot({
      player,
      ranks: [permanent],
      revision: 2,
    });
    await started;
    const adding = s.observe([...s.environment.roles, "204"]);
    release();
    await Promise.all([cancelling, adding]);
    assert.equal(s.environment.roles.includes("203"), false);
    const job = (await s.ranks.poll()).jobs[0];
    assert.equal(
      job.assignments.some((r) => r.rank === "dragon"),
      false,
    );
    assert.deepEqual(job.assignments, [rank("drake", "rh"), permanent]);
  },
);
test("periodic rotating refresh observes a direct backend subscription removal without a rank command", async (t) => {
  const s = setup(t);
  await s.link();
  const permanent = rank("wyrm", "rh");
  await s.ranks.snapshot({
    player,
    ranks: [permanent, rank("dragon", "rh")],
    revision: 1,
  });
  assert.equal((await s.ranks.poll()).refresh.length, 0);
  s.clock.value += 60001;
  assert.deepEqual((await s.ranks.poll()).refresh, [player.uuid]);
  assert.equal((await s.ranks.poll()).refresh.length, 0);
  await s.ranks.snapshot({ player, ranks: [permanent], revision: 2 });
  assert.equal(s.environment.roles.includes("203"), false);
  assert.equal(s.environment.roles.includes("200"), true);
  let calls = 0;
  s.environment.beforeChange = () => {
    calls++;
  };
  await s.ranks.snapshot({ player, ranks: [permanent], revision: 3 });
  assert.equal(calls, 0);
});
