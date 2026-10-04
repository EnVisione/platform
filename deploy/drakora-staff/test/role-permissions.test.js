import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import { rolePermissions } from "../server/role-permissions.js";
import { discordClient } from "../server/discord.js";
import { config as fixture } from "./fixture.js";

export const settings = {
  ...fixture,
  applications: {
    specialistRoles: { builder: "51", developer: "25", artist: "52" },
  },
  roleSync: {
    guildId: "2",
    initialSource: "staff",
    roles: fixture.ranks
      .filter((role) => role.dashboard)
      .map((role) => ({ staffId: role.id, mainId: `1${role.id}` })),
  },
  mail: {},
};
const actor = (rank, extra = ["10", "11"]) => ({
  id: rank,
  name: `Member ${rank}`,
  roles: [rank, ...extra],
});
function setup(t) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const policy = rolePermissions(settings, store);
  return { policy, store };
}

test("role activity filters include actor and target identity and paginate the matching audit", (t) => {
  const { store, policy } = setup(t);
  const at = Date.parse("2026-10-03T23:59:59.999Z");
  for (let i = 0; i < 28; i++)
    store.set(
      "role-audit",
      `${i}`.padStart(3, "0"),
      {
        id: String(i),
        at,
        actor: { id: "28", name: "Manager" },
        action: "assignment",
        memberId: "123",
      },
      Number.MAX_SAFE_INTEGER,
    );
  store.set(
    "role-audit",
    "old",
    {
      id: "old",
      at: at - 86400000,
      actor: { id: "28", name: "Manager" },
      action: "assignment",
      memberId: "123",
    },
    Number.MAX_SAFE_INTEGER,
  );
  const filters = {
    action: "assignment",
    query: "123",
    from: "2026-10-03",
    to: "2026-10-03",
  };
  const page = policy.history(actor("20"), 25, filters);
  assert.equal(page.total, 28);
  assert.equal(page.items.length, 3);
  assert.equal(
    policy.history(actor("20"), 0, { ...filters, query: "MANAGER" }).total,
    28,
  );
  assert.equal(
    policy.history(actor("20"), 0, { ...filters, action: "permissions" }).total,
    0,
  );
  assert.throws(() => policy.history(actor("23"), 0, filters), {
    code: "role_management_required",
  });
});
const input = (policy) => ({
  revision: policy.read(actor("20")).revision,
  roles: policy.read(actor("20")).roles.map((role) => ({
    id: role.id,
    permissions: { ...role.permissions },
  })),
});
function change(input, rank, key, value) {
  input.roles.find((role) => role.id === rank).permissions[key] = value;
}

test("defaults admit dashboard staff to the workspace and preserve role boundaries", (t) => {
  const { policy } = setup(t);
  assert.deepEqual(
    policy.roles.map((role) => role.label),
    [
      "Founder",
      "Manager",
      "Admin",
      "Sr Mod",
      "Mod",
      "Jr Mod",
      "Helper",
      "Builder",
      "Dev",
      "Artist",
    ],
  );
  assert.equal(policy.apply(actor("20", [])).permissions.dashboard, false);
  assert.equal(policy.apply(actor("20", ["10"])).permissions.todo, true);
  for (const rank of [
    "20",
    "28",
    "21",
    "29",
    "22",
    "30",
    "23",
    "51",
    "25",
    "52",
  ]) {
    const caps = policy.apply(actor(rank)).capabilities;
    assert.equal(caps["mail.view"], ["20", "28", "21"].includes(rank));
    assert.equal(caps["mail.delete"], ["20", "28", "21"].includes(rank));
    assert.equal(caps["roles.view"], ["20", "28"].includes(rank));
    assert.equal(
      caps["moderation.view"],
      ["20", "28", "21", "29", "22", "30"].includes(rank),
    );
    assert.equal(caps["applications.approve"], ["20", "28"].includes(rank));
    assert.equal(
      caps["applications.comment"],
      ["20", "28", "21", "29", "22", "30"].includes(rank),
    );
  }
});

test("persisted permissions separate read-only email from sending and combine multiple roles", (t) => {
  const { policy, store } = setup(t);
  const edit = input(policy);
  change(edit, "29", "mail.view", true);
  policy.save(actor("28"), edit);
  const restarted = rolePermissions(settings, store);
  const sr = restarted.apply(actor("29"));
  assert.equal(sr.capabilities["mail.view"], true);
  for (const key of [
    "mail.send",
    "mail.attachments",
    "mail.flags",
    "mail.delete",
  ])
    assert.equal(sr.capabilities[key], false);
  assert.equal(
    restarted.apply(actor("29", ["10", "11", "21"])).capabilities["mail.send"],
    true,
  );
  assert.equal(restarted.history(actor("20")).items[0].actor.id, "28");
  assert.equal(store.get("role-permissions", "current").revision, 1);
});

test("delete permission can be revoked independently of read status and email viewing", (t) => {
  const { policy } = setup(t);
  const edit = input(policy);
  change(edit, "21", "mail.delete", false);
  policy.save(actor("28"), edit);
  const caps = policy.apply(actor("21")).capabilities;
  assert.equal(caps["mail.view"], true);
  assert.equal(caps["mail.flags"], true);
  assert.equal(caps["mail.delete"], false);
});

test("policy changes take effect on a cached Discord session without another Discord request", async (t) => {
  const { policy, store } = setup(t);
  store.set(
    "user",
    "42",
    {
      ...actor("29"),
      id: "42",
      tokens: {},
      tokenExpires: Date.now() + 3600000,
      checkedAt: Date.now(),
      staffMember: true,
    },
    Number.MAX_SAFE_INTEGER,
  );
  let calls = 0;
  const client = discordClient(
    settings,
    store,
    () => {
      calls++;
      throw new Error("Unexpected network call");
    },
    policy.apply,
  );
  assert.equal((await client.check("42")).capabilities["mail.view"], false);
  const edit = input(policy);
  change(edit, "29", "mail.view", true);
  policy.save(actor("20"), edit);
  assert.equal((await client.check("42")).capabilities["mail.view"], true);
  assert.equal(calls, 0);
});

test("Managers cannot change Founder policy, and lower ranks cannot receive role management", (t) => {
  const { policy } = setup(t);
  const edit = input(policy);
  change(edit, "20", "mail.send", false);
  assert.throws(() => policy.save(actor("28"), edit), {
    code: "founder_role_required",
  });
  const lower = input(policy);
  change(lower, "29", "roles.view", true);
  assert.throws(() => policy.save(actor("20"), lower), {
    code: "role_management_protected",
  });
  for (const key of [
    "dashboard.view",
    "roles.view",
    "roles.edit",
    "roles.assign",
  ]) {
    const locked = input(policy);
    change(locked, "20", key, false);
    assert.throws(() => policy.save(actor("20"), locked), {
      code: "founder_access_protected",
    });
  }
  assert.throws(() => policy.read(actor("21")), {
    code: "role_management_required",
  });
  assert.equal(policy.read(actor("20")).revision, 0);
});

test("invalid, incomplete, stale and dependent permission saves leave the policy unchanged", (t) => {
  const { policy } = setup(t);
  const malformed = input(policy);
  malformed.roles[0].permissions["mail.send"] = "yes";
  assert.throws(() => policy.save(actor("20"), malformed), {
    code: "invalid_role_permissions",
  });
  const duplicate = input(policy);
  duplicate.roles[1] = duplicate.roles[0];
  assert.throws(() => policy.save(actor("20"), duplicate), {
    code: "invalid_role_permissions",
  });
  const incomplete = input(policy);
  incomplete.roles.pop();
  assert.throws(() => policy.save(actor("20"), incomplete), {
    code: "invalid_role_permissions",
  });
  const dependent = input(policy);
  change(dependent, "29", "mail.send", true);
  assert.throws(() => policy.save(actor("20"), dependent), {
    code: "role_permission_dependency",
  });
  policy.save(actor("20"), input(policy));
  const stale = input(policy);
  stale.revision = 0;
  assert.throws(() => policy.save(actor("20"), stale), {
    code: "role_permissions_changed",
  });
  assert.equal(policy.read(actor("20")).revision, 1);
});

test("disabled permissions block actions even when a Discord access role remains present", (t) => {
  const { policy } = setup(t);
  const edit = input(policy);
  for (const key of Object.keys(
    edit.roles.find((role) => role.id === "29").permissions,
  ))
    change(edit, "29", key, false);
  policy.save(actor("20"), edit);
  const member = policy.apply(actor("29"));
  assert.equal(member.permissions.dashboard, false);
  assert.equal(member.permissions.todo, false);
  assert.equal(member.capabilities["applications.view"], false);
});

test("workspace permissions remain enforced after the Todo role is retired", (t) => {
  const { policy } = setup(t);
  const staff = actor("29", ["10"]);
  assert.equal(policy.apply(staff).permissions.todo, true);
  const edit = input(policy);
  change(edit, "29", "office.view", false);
  change(edit, "29", "office.host", false);
  change(edit, "29", "huly.access", false);
  policy.save(actor("20"), edit);
  assert.equal(policy.apply(staff).permissions.dashboard, true);
  assert.equal(policy.apply(staff).permissions.todo, false);
  assert.equal(policy.apply(actor("29", ["11"])).permissions.dashboard, false);
});

test("category and inbox defaults preserve billing and partnership privacy across legacy policies", (t) => {
  const { store } = setup(t);
  const config = {
    ...settings,
    mail: {
      identities: [
        { address: "support@drakora.org" },
        { address: "partners@drakora.org" },
      ],
    },
  };
  const policy = rolePermissions(config, store);
  const founder = policy.apply(actor("20")),
    manager = policy.apply(actor("28")),
    admin = policy.apply(actor("21")),
    helper = policy.apply(actor("23"));
  for (const user of [founder, manager, admin, helper])
    assert.equal(user.capabilities["tickets.category.support.view"], true);
  for (const user of [founder, manager, admin, policy.apply(actor("29"))])
    assert.equal(user.capabilities["tickets.category.reports.view"], true);
  assert.equal(helper.capabilities["tickets.category.reports.view"], false);
  assert.equal(admin.capabilities["tickets.category.staff.view"], false);
  assert.equal(founder.capabilities["tickets.category.billing.view"], true);
  for (const user of [manager, admin, helper])
    assert.equal(user.capabilities["tickets.category.billing.view"], false);
  for (const user of [founder, manager]) {
    assert.equal(user.capabilities["tickets.category.partnership.reply"], true);
    assert.equal(
      user.capabilities["mail.inbox.partners@drakora.org.view"],
      true,
    );
  }
  assert.equal(admin.capabilities["mail.inbox.support@drakora.org.send"], true);
  assert.equal(
    admin.capabilities["mail.inbox.partners@drakora.org.view"],
    false,
  );
  assert.equal(helper.capabilities["tickets.category.partnership.view"], false);
  const edit = input(policy);
  change(edit, "28", "tickets.category.billing.view", true);
  assert.throws(() => policy.save(actor("28"), edit), {
    code: "founder_role_required",
  });
  policy.save(actor("20"), edit);
  assert.equal(
    policy.apply(actor("28")).capabilities["tickets.category.billing.view"],
    true,
  );
  const revoke = input(policy);
  change(revoke, "28", "mail.inbox.partners@drakora.org.send", false);
  policy.save(actor("20"), revoke);
  assert.equal(
    policy.apply(actor("28")).capabilities[
      "mail.inbox.partners@drakora.org.reply"
    ],
    true,
  );
  assert.equal(
    policy.apply(actor("28")).capabilities[
      "mail.inbox.partners@drakora.org.send"
    ],
    false,
  );
});

test("takeover defaults to Admin or higher, obeys category grants and cannot be delegated below Admin", (t) => {
  const { policy, store } = setup(t);
  for (const rank of ["20", "28", "21", "29", "22", "30", "23"]) {
    const caps = policy.apply(actor(rank)).capabilities;
    assert.equal(caps["tickets.takeover"], ["20", "28", "21"].includes(rank));
    assert.equal(
      caps["tickets.category.support.takeover"],
      ["20", "28", "21"].includes(rank),
    );
    assert.equal(caps["tickets.category.billing.takeover"], rank === "20");
  }
  const edit = input(policy);
  change(edit, "23", "tickets.takeover", true);
  assert.throws(() => policy.save(actor("20"), edit), {
    code: "ticket_takeover_protected",
  });
  store.set(
    "role-permissions",
    "current",
    {
      revision: 1,
      overrides: {
        23: {
          "tickets.takeover": true,
          "tickets.category.support.takeover": true,
        },
      },
    },
    Number.MAX_SAFE_INTEGER,
  );
  const restarted = rolePermissions(settings, store);
  assert.equal(
    restarted.apply(actor("23")).capabilities["tickets.takeover"],
    false,
  );
  assert.ok(
    restarted
      .read(actor("20"))
      .roles.find((role) => role.id === "23")
      .locked.includes("tickets.category.support.takeover"),
  );
  const valid = input(restarted);
  change(valid, "21", "tickets.category.support.takeover", false);
  restarted.save(actor("28"), valid);
  assert.equal(
    restarted.apply(actor("21")).capabilities["tickets.takeover"],
    true,
  );
  assert.equal(
    restarted.apply(actor("21")).capabilities[
      "tickets.category.support.takeover"
    ],
    false,
  );
});

test("closed ticket channel deletion is restricted to Admin or higher and category grants", (t) => {
  const { policy, store } = setup(t);
  for (const rank of ["20", "28", "21", "29", "22", "30", "23"]) {
    const caps = policy.apply(actor(rank)).capabilities;
    assert.equal(caps["tickets.delete"], ["20", "28", "21"].includes(rank));
    assert.equal(caps["tickets.category.billing.delete"], rank === "20");
  }
  const edit = input(policy);
  change(edit, "23", "tickets.delete", true);
  assert.throws(() => policy.save(actor("20"), edit), {
    code: "ticket_deletion_protected",
  });
  store.set(
    "role-permissions",
    "current",
    {
      revision: 1,
      overrides: {
        23: { "tickets.delete": true, "tickets.category.support.delete": true },
      },
    },
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    rolePermissions(settings, store).apply(actor("23")).capabilities[
      "tickets.delete"
    ],
    false,
  );
  const valid = input(policy);
  change(valid, "21", "tickets.category.support.delete", false);
  policy.save(actor("20"), valid);
  assert.equal(policy.apply(actor("21")).capabilities["tickets.delete"], true);
  assert.equal(
    policy.apply(actor("21")).capabilities["tickets.category.support.delete"],
    false,
  );
});
