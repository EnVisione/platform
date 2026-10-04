import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Collection, GatewayIntentBits, IntentsBitField } from "discord.js";
import { discordMembers } from "../server/discord-members.js";

test("concurrent roster consumers share one fetch and see live membership changes", async () => {
  const client = new EventEmitter();
  client.options = {
    intents: new IntentsBitField([GatewayIntentBits.GuildPresences]),
  };
  const cache = new Collection([["staff", { roles: ["helper"] }]]);
  let fetches = 0;
  const guild = {
    id: "guild",
    members: {
      cache,
      async fetch(options) {
        fetches++;
        assert.equal(options.withPresences, true);
        return cache;
      },
    },
  };
  const consumers = await Promise.all(
    Array.from({ length: 12 }, () => discordMembers(client, guild)),
  );
  assert.equal(fetches, 1);
  assert.ok(consumers.every((members) => members === cache));
  cache.set("staff", { roles: [] });
  cache.set("new-staff", { roles: ["manager"] });
  assert.deepEqual(
    (await discordMembers(client, guild)).get("staff").roles,
    [],
  );
  cache.delete("staff");
  assert.equal((await discordMembers(client, guild)).has("staff"), false);
  assert.equal(fetches, 1);
  client.emit("shardDisconnect");
  await discordMembers(client, guild);
  assert.equal(fetches, 2);
  client.emit("shardResume");
  await discordMembers(client, guild);
  assert.equal(fetches, 3);
});

test("failed or interrupted roster loads retry without trusting a stale snapshot", async () => {
  const client = new EventEmitter();
  const cache = new Collection();
  let fail = true,
    release;
  const guild = {
    id: "guild",
    members: {
      cache,
      async fetch() {
        if (fail) throw new Error("Rate limited");
        await new Promise((resolve) => {
          release = resolve;
        });
        return cache;
      },
    },
  };
  await assert.rejects(discordMembers(client, guild), /Rate limited/);
  fail = false;
  const pending = discordMembers(client, guild);
  client.emit("shardDisconnect");
  release();
  await assert.rejects(pending, /membership changed/);
  const retry = discordMembers(client, guild);
  release();
  assert.equal(await retry, cache);
  guild.available = false;
  await assert.rejects(discordMembers(client, guild), /unavailable/);
});
