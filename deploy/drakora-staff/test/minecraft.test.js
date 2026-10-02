import test from "node:test";
import assert from "node:assert/strict";
import { minecraftRegistry } from "../server/minecraft.js";
import { managementAccess } from "../server/roles.js";
import { config, accessRoles } from "./fixture.js";

function registry() {
  const records = new Map();
  const store = {
    get: (kind, id) => records.get(`${kind}:${id}`),
    set: (kind, id, value) =>
      records.set(`${kind}:${id}`, structuredClone(value)),
    entries: (kind) =>
      [...records.entries()]
        .filter(([key]) => key.startsWith(`${kind}:`))
        .map(([key, value]) => [
          key.slice(kind.length + 1),
          structuredClone(value),
        ]),
  };
  return minecraftRegistry(store);
}

test("Minecraft names are valid, unique regardless of case, and immutable", () => {
  const links = registry();
  assert.throws(() => links.register("one", "bad-name"), {
    code: "invalid_minecraft_name",
  });
  const first = links.register("one", "EnVy_1");
  assert.equal(first.status, "pending");
  assert.equal(links.get("one").name, "EnVy_1");
  assert.throws(() => links.register("one", "Other"), {
    code: "minecraft_name_locked",
  });
  assert.throws(() => links.register("two", "envy_1"), {
    code: "minecraft_name_taken",
  });
});

test("a name change requires a separate authorized decision", () => {
  const links = registry();
  links.register("one", "Original");
  links.register("two", "Second");
  links.requestChange("one", "NewName");
  assert.equal(links.get("one").name, "Original");
  assert.throws(() => links.register("three", "newname"), {
    code: "minecraft_name_taken",
  });
  links.decide("one", false);
  assert.equal(links.get("one").name, "Original");
  assert.equal(links.get("one").changeRequest, undefined);
  links.requestChange("one", "NewName");
  links.decide("one", true);
  assert.equal(links.get("one").name, "NewName");
  assert.equal(links.get("one").status, "pending");
  assert.equal(links.get("one").changeRequest, undefined);
});

test("account viewers and Minecraft approvers require their ranks and Dashboard access", () => {
  const evaluate = (roles) =>
    managementAccess(config, {
      roles,
      permissions: { dashboard: roles.includes(accessRoles.dashboard) },
    });
  assert.deepEqual(evaluate(["20"]), {
    founder: false,
    manager: false,
    approveMinecraftChange: false,
  });
  assert.deepEqual(evaluate([accessRoles.dashboard, "21"]), {
    founder: false,
    manager: true,
    approveMinecraftChange: false,
  });
  assert.deepEqual(evaluate([accessRoles.dashboard, "20"]), {
    founder: true,
    manager: true,
    approveMinecraftChange: true,
  });
  assert.deepEqual(evaluate([accessRoles.dashboard, "28"]), {
    founder: false,
    manager: true,
    approveMinecraftChange: true,
  });
  for (const id of ["22", "29", "30", "23", "24"])
    assert.deepEqual(evaluate([accessRoles.dashboard, id]), {
      founder: false,
      manager: false,
      approveMinecraftChange: false,
    });
});
