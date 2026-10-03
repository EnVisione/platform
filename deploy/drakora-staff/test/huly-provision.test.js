import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import accountMethod from "../huly-staff-account.cjs";
import { patchAccount } from "../patch-huly-account.cjs";
import { hulyClient } from "../server/huly.js";

const identity = {
  discordId: "42",
  email: "staff@example.invalid",
  name: "Staff",
};
test("dashboard account tokens retain workspace scope without service privileges and expire with the parent session", () => {
  const fixture = clientFixture();
  const until = Date.now() + 60000;
  const token = fixture.client.accountToken("account-42", until);
  const [header, body, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.account, "account-42");
  assert.equal(claims.workspace, "workspace");
  assert.deepEqual(claims.extra, {});
  assert.equal(claims.exp, Math.floor(until / 1000));
  assert.equal(
    signature,
    createHmac("sha256", "test")
      .update(`${header}.${body}`)
      .digest("base64url"),
  );
  for (const expiry of [0, Date.now() - 1, NaN, Infinity])
    assert.throws(
      () => fixture.client.accountToken("account-42", expiry),
      /expired/,
    );
  assert.throws(() => fixture.client.accountToken(undefined, until), /expired/);
});
test("native author tokens retain workspace scope, signature and short expiry", () => {
  const fixture = clientFixture();
  for (const [token, expected] of [
    [fixture.client.serviceToken(), "recovery"],
    [fixture.client.serviceToken("account-42"), "account-42"],
  ]) {
    const [header, body, signature] = token.split(".");
    assert.equal(
      signature,
      createHmac("sha256", "test")
        .update(`${header}.${body}`)
        .digest("base64url"),
    );
    const claims = JSON.parse(Buffer.from(body, "base64url"));
    assert.equal(claims.account, expected);
    assert.equal(claims.workspace, "workspace");
    assert.deepEqual(claims.extra, { service: "tool" });
    assert.ok(
      claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 120,
    );
  }
});
function accountFixture(identities = []) {
  const records = [...identities];
  let writes = 0;
  const db = {
    socialId: {
      findOne: async (query) =>
        records.find((x) => x.type === query.type && x.value === query.value) ??
        null,
    },
  };
  const method = accountMethod({
    decodeToken: (_, token) => ({ extra: { service: token } }),
    verifyServices: (allowed, extra) => {
      if (!allowed.includes(extra?.service)) throw new Error("Forbidden");
    },
    loginWithProvider: async (
      _,
      __,
      ___,
      email,
      first,
      last,
      social,
      disabled,
    ) => {
      assert.equal(disabled, false);
      assert.equal(first, "Staff");
      assert.equal(last, "");
      const account =
        records.find((x) => x.type === social.type && x.value === social.value)
          ?.personUuid ??
        records.find((x) => x.type === "email" && x.value === email)
          ?.personUuid ??
        "account-42";
      if (
        !records.some((x) => x.type === social.type && x.value === social.value)
      )
        records.push({ ...social, personUuid: account });
      writes++;
      return { account, token: "test" };
    },
  });
  return {
    method: (params = identity, token = "tool") =>
      method({}, db, null, token, params),
    writes: () => writes,
    records,
  };
}
test("trusted staff provisioning creates a stable identity and links an existing email account", async () => {
  const fresh = accountFixture();
  assert.deepEqual(await fresh.method(), { account: "account-42" });
  assert.deepEqual(await fresh.method(), { account: "account-42" });
  assert.equal(fresh.records.length, 1);
  const linked = accountFixture([
    { type: "email", value: identity.email, personUuid: "existing-owner" },
  ]);
  assert.deepEqual(await linked.method(), { account: "existing-owner" });
  assert.equal(linked.records[1].value, "discord:42");
});
test("public or other service tokens and malformed identities cannot provision accounts", async () => {
  const fixture = accountFixture();
  for (const token of ["", "workspace", "github"])
    await assert.rejects(fixture.method(identity, token), /Forbidden/);
  for (const params of [
    null,
    { ...identity, discordId: {} },
    { ...identity, discordId: 42 },
    { ...identity, email: "invalid" },
    { ...identity, name: " " },
    { ...identity, expectedAccount: {} },
  ])
    await assert.rejects(fixture.method(params), /Invalid staff identity/);
  assert.equal(fixture.writes(), 0);
});
test("saved identities and conflicting email accounts are never silently reassigned", async () => {
  const fixture = accountFixture([
    { type: "oidc", value: "discord:42", personUuid: "original" },
    { type: "email", value: identity.email, personUuid: "other" },
  ]);
  await assert.rejects(fixture.method(), /Huly identity conflict/);
  const missing = accountFixture();
  await assert.rejects(
    missing.method({ ...identity, expectedAccount: "original" }),
    /Huly identity conflict/,
  );
  assert.equal(fixture.writes() + missing.writes(), 0);
});
function clientFixture({ exists = false, admitted = true, fail = false } = {}) {
  let account = exists ? "account-42" : undefined;
  let members = exists ? [{ person: account }] : [];
  const calls = [];
  const user = {
    id: "42",
    email: identity.email,
    name: "Staff",
    checkedAt: 123,
    policyRevision: 2,
    projectRanks: [],
    permissions: {
      dashboard: admitted,
      todo: admitted,
      hulyRole: "USER",
      hulyRanks: [],
    },
  };
  const store = {
    get: () => user,
    set: (_, __, next) => Object.assign(user, next),
  };
  const client = hulyClient(
    {
      hulyOwner: "recovery",
      hulySecret: "test",
      hulyWorkspace: "workspace",
      hulyAccounts: "https://accounts.example.invalid",
    },
    store,
    async (_, options) => {
      const { method, params } = JSON.parse(options.body);
      calls.push({ method, params });
      if (method === "ensureStaffAccount") {
        if (fail) return Response.json({ error: { code: "unavailable" } });
        account = "account-42";
      }
      if (method === "assignWorkspace") members.push({ person: account });
      if (method === "leaveWorkspace") members = [];
      return Response.json({
        result:
          method === "findPersonBySocialKey"
            ? (account ?? null)
            : method === "ensureStaffAccount"
              ? { account }
              : method === "getWorkspaceMembers"
                ? members
                : true,
      });
    },
  );
  return { user, client, calls };
}
test("dashboard staff are provisioned before a Huly visit and concurrent requests join once", async () => {
  const fixture = clientFixture();
  await Promise.all([
    fixture.client.sync(fixture.user),
    fixture.client.sync(fixture.user),
  ]);
  assert.equal(fixture.user.hulyAccount, "account-42");
  assert.equal(fixture.user.syncedPolicyRevision, 2);
  assert.equal(
    fixture.calls.filter((x) => x.method === "ensureStaffAccount").length,
    1,
  );
  assert.equal(
    fixture.calls.filter((x) => x.method === "assignWorkspace").length,
    1,
  );
  await fixture.client.sync(fixture.user);
  assert.equal(
    fixture.calls.filter((x) => x.method === "ensureStaffAccount").length,
    2,
  );
  assert.equal(
    fixture.calls.filter((x) => x.method === "assignWorkspace").length,
    1,
  );
});
test("revoked staff are not created and existing workspace membership is removed", async () => {
  const missing = clientFixture({ admitted: false });
  await missing.client.sync(missing.user);
  assert.deepEqual(
    missing.calls.map((x) => x.method),
    ["findPersonBySocialKey"],
  );
  const existing = clientFixture({ exists: true, admitted: false });
  await existing.client.sync(existing.user);
  assert.equal(
    existing.calls.some((x) => x.method === "leaveWorkspace"),
    true,
  );
  assert.equal(
    existing.calls.some((x) => x.method === "assignWorkspace"),
    false,
  );
});
test("a failed provisioning request remains an error and is retried on the next request", async () => {
  const fixture = clientFixture({ fail: true });
  await assert.rejects(fixture.client.sync(fixture.user), /unavailable/);
  await assert.rejects(fixture.client.sync(fixture.user), /unavailable/);
  assert.equal(fixture.user.hulyAccount, undefined);
  assert.equal(fixture.user.syncedAt, undefined);
  assert.equal(
    fixture.calls.filter((x) => x.method === "ensureStaffAccount").length,
    2,
  );
});
test("the pinned account patch preserves private invitations and fails on an incompatible image", () => {
  const original = `loginInfo = await (0, import_account.joinWithProvider)(\n            socialKey,\n            signUpDisabled\n          );\n        ensurePerson: (0, import_utils6.wrap)(ensurePerson),`;
  const patched = patchAccount(original);
  assert.match(patched, /ensureStaffAccount/);
  assert.match(patched, /verifyServices: import_utils6.verifyAllowedServices/);
  assert.match(patched, /socialKey,\n            false/);
  assert.throws(() => patchAccount(original + original), /Expected one/);
  assert.throws(
    () => patchAccount(original.replace("ensurePerson:", "other:")),
    /staff account patch/,
  );
});
