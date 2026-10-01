import test from "node:test";
import assert from "node:assert/strict";
import { meetingService } from "../server/meetings.js";
import { discordAvatar } from "../server/avatar.js";
import { config } from "./fixture.js";

const host = { id: "99", roles: ["20", "11"], permissions: { todo: true } };
function fixture(overrides = {}) {
  const records = new Map();
  const changes = [];
  const store = {
    get: (_, id) => records.get(id),
    set: (_, id, value) => records.set(id, value),
  };
  const transport = {
    setOpen: async (_, open) => changes.push(open),
    invite: async () => {
      changes.push("invite");
      return "message";
    },
    endInvite: async () => changes.push("end"),
    ...overrides,
  };
  return {
    service: meetingService(config, store, transport),
    changes,
    records,
  };
}
test("concurrent meeting starts unlock once and send one invitation", async () => {
  const { service, changes } = fixture();
  await Promise.all([service.start("30", host), service.start("30", host)]);
  assert.deepEqual(changes, [true, "invite"]);
  assert.equal(service.get("30").status, "live");
  await service.end("30", host);
  await service.end("30", host);
  assert.deepEqual(changes, [true, "invite", false, "end"]);
  assert.equal(service.get("30").status, "closed");
});
test("meeting controls require both access and a host rank and reject unknown rooms", async () => {
  const { service, changes } = fixture();
  for (const user of [
    { ...host, roles: ["11"] },
    { ...host, permissions: { todo: false } },
  ])
    await assert.rejects(service.start("30", user), {
      code: "meeting_host_required",
    });
  await assert.rejects(service.start("unmanaged", host), {
    code: "unknown_meeting_room",
  });
  assert.deepEqual(changes, []);
});
test("failed invitations relock the room and interrupted operations recover closed", async () => {
  const { service, changes, records } = fixture({
    invite: async () => {
      throw new Error("Discord unavailable");
    },
  });
  await assert.rejects(service.start("30", host));
  assert.deepEqual(changes, [true, false]);
  assert.equal(service.get("30").status, "closed");
  records.set("30", { status: "starting" });
  await service.reconcile();
  assert.equal(service.get("30").status, "closed");
});
test("a failed close remains recoverable and cannot send another invite", async () => {
  let fail = false;
  const { service } = fixture({
    setOpen: async () => {
      if (fail) throw new Error("offline");
    },
  });
  await service.start("30", host);
  fail = true;
  await assert.rejects(service.end("30", host));
  assert.equal(service.get("30").status, "ending");
  await assert.rejects(service.start("30", host), {
    code: "meeting_recovery_required",
  });
  fail = false;
  await service.reconcile();
  assert.equal(service.get("30").status, "closed");
});
test("Discord avatars support guild pictures, global pictures, and default avatars", () => {
  assert.match(
    discordAvatar({ id: "42", avatar: "abc" }, "1", "def"),
    /guilds\/1\/users\/42\/avatars\/def.png/,
  );
  assert.match(
    discordAvatar({ id: "42", avatar: "abc" }),
    /avatars\/42\/abc.png/,
  );
  assert.match(
    discordAvatar({ id: "42", avatar: null }),
    /embed\/avatars\/0.png/,
  );
  assert.throws(() => discordAvatar({ id: "https://example.org" }));
});
