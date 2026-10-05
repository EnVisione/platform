import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { openStore } from "../server/store.js";
import { rolePermissions } from "../server/role-permissions.js";
import { discordClient } from "../server/discord.js";
import { ticketService } from "../server/tickets.js";
import { config as fixture } from "./fixture.js";

const config = {
  ...fixture,
  applications: {
    publicOrigin: "https://example.invalid",
    specialistRoles: { artist: "52" },
  },
  tickets: { guildId: "2", staffRoleId: "80" },
};
const actor = (rank, ticketRole = true) => ({
  id: rank,
  name: `Staff ${rank}`,
  roles: ["10", rank],
  ticketRole,
});
function setup(t, withService = false) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const policy = rolePermissions(config, store);
  const service = withService ? ticketService(config, store, policy) : null;
  t.after(async () => {
    await service?.stop();
    store.close();
  });
  return { store, policy, service };
}
const edit = (policy, user = actor("28")) => {
  const model = policy.read(user);
  return {
    revision: model.revision,
    roles: model.roles
      .filter((role) => role.id)
      .map((role) => ({ id: role.id, permissions: { ...role.permissions } })),
  };
};

test("ranks and stale overrides cannot bypass the main-server Tickets role", (t) => {
  const { store, policy } = setup(t);
  for (const rank of ["20", "28", "21", "22", "23", "52"]) {
    const user = actor(rank, false);
    user.roles.push("80");
    user.capabilities = { "tickets.view": true };
    const current = policy.apply(user);
    assert.equal(current.permissions.dashboard, true);
    for (const [key, value] of Object.entries(current.capabilities))
      if (key.startsWith("tickets.") || key === "logs.view")
        assert.equal(value, false, key);
  }
  const model = policy.read(actor("28"));
  for (const role of model.roles.filter((role) => role.id && !role.ticket)) {
    assert.equal(role.permissions["tickets.view"], false);
    assert.equal(
      store.get("role-permissions", "current").overrides[role.id]?.[
        "tickets.view"
      ],
      false,
    );
  }
  const forged = edit(policy);
  forged.roles.find((role) => role.id === "23").permissions["tickets.view"] =
    true;
  assert.throws(() => policy.save(actor("28"), forged), {
    code: "ticket_role_required",
  });
});

test("Tickets grants general actions across staff specialties but deletion still requires Admin", (t) => {
  const { policy } = setup(t);
  for (const rank of ["52", "23", "22", "21", "28", "20"]) {
    const caps = policy.apply(actor(rank)).capabilities;
    for (const key of [
      "tickets.view",
      "tickets.reply",
      "tickets.claim",
      "tickets.takeover",
      "tickets.close",
      "logs.view",
      "tickets.category.support.reply",
      "tickets.category.reports.claim",
    ])
      assert.equal(caps[key], true, `${rank} ${key}`);
    assert.equal(caps["tickets.delete"], ["20", "28", "21"].includes(rank));
    assert.equal(
      caps["tickets.category.billing.view"],
      ["20", "28"].includes(rank),
    );
    assert.equal(
      caps["tickets.category.staff.view"],
      ["20", "28"].includes(rank),
    );
  }
  assert.equal(
    policy.apply({ ...actor("52"), roles: ["52"] }).capabilities[
      "tickets.view"
    ],
    false,
  );
});

test("Managers can configure billing and staff reports for any rank without granting channel deletion or changing Founder privileges", (t) => {
  const { store, policy } = setup(t);
  const input = edit(policy);
  for (const category of ["billing", "staff"]) {
    for (const action of ["view", "reply", "claim", "takeover", "close"])
      input.roles.find((role) => role.id === "52").permissions[
        `tickets.category.${category}.${action}`
      ] = true;
    for (const action of [
      "view",
      "reply",
      "claim",
      "takeover",
      "close",
      "delete",
    ])
      input.roles.find((role) => role.id === "20").permissions[
        `tickets.category.${category}.${action}`
      ] = false;
  }
  policy.save(actor("28"), input);
  const restarted = rolePermissions(config, store);
  assert.equal(restarted.read(actor("28")).revision, input.revision + 1);
  assert.equal(
    restarted.apply(actor("52")).capabilities["tickets.category.billing.claim"],
    true,
  );
  assert.equal(
    restarted.apply(actor("52")).capabilities["tickets.category.staff.reply"],
    true,
  );
  assert.equal(
    restarted.apply(actor("52", false)).capabilities[
      "tickets.category.billing.view"
    ],
    false,
  );
  assert.equal(
    restarted.apply(actor("52")).capabilities["tickets.delete"],
    false,
  );
  assert.equal(
    restarted.apply(actor("20")).capabilities["tickets.category.staff.view"],
    false,
  );
  const forbidden = edit(restarted);
  forbidden.roles.find((role) => role.id === "20").permissions["mail.view"] =
    false;
  assert.throws(() => restarted.save(actor("28"), forbidden), {
    code: "founder_role_required",
  });
});

test("authoritative main membership and Gateway changes revoke ticket access without signing staff out", async (t) => {
  const { store, policy } = setup(t);
  store.set(
    "user",
    "52",
    { ...actor("52"), tokens: {}, tokenExpires: Number.MAX_SAFE_INTEGER },
    Number.MAX_SAFE_INTEGER,
  );
  let main = { roles: ["80"] };
  const client = discordClient(
    config,
    store,
    () => {
      throw new Error("OAuth must not be used");
    },
    policy.apply,
    {
      available: () => true,
      member: async () => ({ roles: ["10", "52"] }),
      ticketMember: async () => main,
    },
  );
  assert.equal(
    (await client.checkMembership("52")).capabilities["tickets.claim"],
    true,
  );
  store.set("session", "session", { userId: "52" }, Number.MAX_SAFE_INTEGER);
  main = { roles: [] };
  const event = client.observe({
    t: "GUILD_MEMBER_UPDATE",
    d: { guild_id: "2", user: { id: "52" }, roles: [] },
  });
  assert.deepEqual(event, { id: "52", revoked: false, ticketRevoked: true });
  assert.equal((await client.check("52")).capabilities["tickets.view"], false);
  assert.ok(store.get("session", "session"));
  assert.equal(store.get("user", "52").staffMember, true);
  main = { roles: ["80"], pending: true };
  assert.equal(
    (await client.checkMembership("52")).capabilities["tickets.view"],
    false,
  );
  main = undefined;
  assert.equal(
    (await client.checkMembership("52")).capabilities["tickets.view"],
    false,
  );
  main = { roles: ["80"] };
  assert.equal(
    (await client.checkMembership("52")).capabilities["tickets.view"],
    true,
  );
  main = { roles: [] };
  assert.deepEqual(
    client.observe({
      t: "GUILD_ROLE_DELETE",
      d: { guild_id: "2", role_id: "80" },
    }),
    { ticketRevokedIds: ["52"] },
  );
  assert.equal(store.get("user", "52").ticketRole, false);
  assert.ok(store.get("session", "session"));
});

test("specialists with Tickets can claim, discuss and request a Manager-approved takeover", async (t) => {
  const { service } = setup(t, true);
  const ticket = service.create(
    { id: "player", name: "Player" },
    {
      requestId: randomUUID(),
      ign: "Player",
      type: "general",
      location: "Void",
      description:
        "A detailed support request with enough information for staff.",
    },
  );
  service.claim(actor("23"), ticket.id);
  assert.throws(() => service.staff(actor("20", false), ticket), {
    code: "ticket_access_denied",
  });
  await assert.rejects(service.takeover(actor("52"), ticket.id, "23"), {
    code: "ticket_takeover_approval_required",
  });
  const request = service.requestTakeover(actor("52"), ticket.id, {
    claimedBy: "23",
    reason: "The assigned helper needs specialist assistance.",
  });
  service.attach({ staffUser: async () => actor("52") });
  await service.reviewTakeover(actor("28"), ticket.id, request.id, true);
  assert.equal(service.get(ticket.id).claimedBy.id, "52");
  assert.equal(service.notes(actor("52"), ticket.id).messages.length, 1);
  assert.throws(() => service.staff(actor("52"), ticket, "tickets.delete"), {
    code: "ticket_access_denied",
  });
});
