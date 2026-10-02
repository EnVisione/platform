import React, { useEffect, useState } from "react";
import "./roles.css";

const messages = {
  role_permissions_changed:
    "Someone changed permissions while you were editing. Your draft is still here. Reload the saved permissions before trying again.",
  discord_roles_changed:
    "This member's Discord roles changed. Refresh members and select them again before saving.",
  founder_role_required:
    "Only a Founder can change Founder permissions or assign and remove Manager and Founder ranks.",
  founder_access_protected:
    "Your Founder rank and access to role management must stay enabled.",
  role_management_required:
    "You no longer have permission for this action. Ask a Founder to check your access.",
  discord_unavailable: "Discord is temporarily unavailable. Please try again.",
  role_sync_unavailable: "Discord role assignment is not configured yet.",
  discord_member_required:
    "This account could not be found in either Drakora server.",
  role_permission_dependency: "Enable the required permissions before saving.",
};
async function request(path, options = {}) {
  const response = await fetch(`/api/roles${path}`, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      messages[data.error] ||
        "Could not complete this action. Please try again.",
    );
  return data;
}
const time = (value) =>
  value ? new Date(value).toLocaleString() : "Not available";
const draftRoles = (data) =>
  data.roles
    .filter((role) => role.id)
    .map((role) => ({ id: role.id, permissions: { ...role.permissions } }));

function SyncStatus({ member }) {
  return (
    <div className="role-sync-status">
      <p>
        Staff server: {member.inStaff ? "Joined" : "Waiting for member to join"}{" "}
        · Main server: {member.inMain ? "Joined" : "Waiting for member to join"}
      </p>
      {Object.entries(member.discord ?? {}).map(([guild, delivery]) => (
        <p key={guild}>
          Rank sync · {delivery.guildId || guild}:{" "}
          <strong>{delivery.status.replaceAll("_", " ")}</strong>
          {delivery.error && " · Waiting for Discord permissions or a retry"}
        </p>
      ))}
      {member.request && (
        <p>
          Specialist and access roles:{" "}
          <strong>{member.request.status.replaceAll("_", " ")}</strong>
          {member.request.error &&
            " · Waiting for the bot's role hierarchy or a retry"}
        </p>
      )}
      <p>Minecraft: Not connected</p>
    </div>
  );
}

function MemberRoles({ data, csrf, userId, onAudit }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [rank, setRank] = useState("");
  const [specialists, setSpecialists] = useState([]);
  const [access, setAccess] = useState({ dashboard: false, todo: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const ranks = data.roles.filter((role) => role.id && !role.specialist);
  const teams = data.roles.filter((role) => role.id && role.specialist);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request(
      `/members?${new URLSearchParams({ name: search, offset: String(offset) })}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setList(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [search, offset, refresh]);
  function select(member) {
    setSelected(member);
    setRank(ranks.find((role) => member.roles.includes(role.id))?.id ?? "");
    setSpecialists(
      teams
        .filter((role) => member.roles.includes(role.id))
        .map((role) => role.id),
    );
    setAccess(member.access);
    setConfirming(false);
    setError("");
    setNotice("");
  }
  const protectedMember = selected?.roles.some((id) =>
    ranks.some(
      (role) => role.id === id && ["Founder", "Manager"].includes(role.name),
    ),
  );
  const rankLocked = !data.founder && protectedMember;
  const ownFounder = data.founder && selected?.id === userId;
  async function assign() {
    setBusy(true);
    setError("");
    try {
      const result = await request(`/members/${selected.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          version: selected.version,
          rank: rank || null,
          specialists,
          access,
        }),
      });
      setSelected((previous) => ({ ...previous, ...result }));
      setConfirming(false);
      setNotice(
        "Role changes saved. Discord sync will retry changes waiting for membership, screening or bot permissions.",
      );
      setRefresh((value) => value + 1);
      onAudit();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="member-roles-title">
      <h3 id="member-roles-title">Assign Discord roles</h3>
      <p>
        Community ranks sync between the main and staff servers. Builder, Dev
        and Artist roles are assigned in the staff server; matching main-server
        roles are not configured. Minecraft sync will be added later.
      </p>
      <form
        className="roles-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSelected(null);
          setSearch(query.trim());
          setOffset(0);
          setRefresh((value) => value + 1);
        }}
      >
        <label>
          Discord name or user ID
          <input
            type="search"
            maxLength={80}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search a name, or paste a Discord user ID"
          />
        </label>
        <button className="button" disabled={busy}>
          Search
        </button>
        <button
          type="button"
          className="role-secondary"
          disabled={busy}
          onClick={() => {
            setSelected(null);
            setRefresh((value) => value + 1);
          }}
        >
          Refresh members
        </button>
      </form>
      <p className="roles-help">
        Members must be in at least one Drakora server. Use their Discord ID to
        queue roles before they join the staff server.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="role-success" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading Discord members…</p>
      ) : (
        list && (
          <>
            <div className="role-member-grid">
              {list.members.map((member) => (
                <button
                  className={`role-member${selected?.id === member.id ? " selected" : ""}`}
                  key={member.id}
                  type="button"
                  disabled={busy}
                  onClick={() => select(member)}
                >
                  {member.avatar && <img src={member.avatar} alt="" />}
                  <span>
                    <strong>{member.name}</strong>
                    <small>{member.id}</small>
                    <small>
                      {data.roles
                        .filter((role) => member.roles.includes(role.id))
                        .map((role) => role.label)
                        .join(" · ") || "No managed rank"}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            {!list.members.length && (
              <p>No members found. Try their Discord user ID.</p>
            )}
            {list.limited && (
              <p className="roles-help">
                Showing up to 100 matching members. Narrow your search to find a
                specific account.
              </p>
            )}
            <div className="roles-pagination">
              <button
                className="role-secondary"
                disabled={busy || offset === 0}
                onClick={() => {
                  setSelected(null);
                  setOffset(Math.max(0, offset - 25));
                }}
              >
                Previous
              </button>
              <span>{list.total} matching members</span>
              <button
                className="role-secondary"
                disabled={busy || offset + 25 >= list.total}
                onClick={() => {
                  setSelected(null);
                  setOffset(offset + 25);
                }}
              >
                Next
              </button>
            </div>
          </>
        )
      )}
      {selected && (
        <section
          className="role-member-editor"
          aria-label={`Roles for ${selected.name}`}
        >
          <h4>{selected.name}</h4>
          <SyncStatus member={selected} />
          <fieldset disabled={busy || !data.canAssign || confirming}>
            <legend>Roles and access</legend>
            <label>
              Community rank
              <select
                value={rank}
                disabled={rankLocked || ownFounder}
                onChange={(event) => setRank(event.target.value)}
              >
                <option value="">No community rank</option>
                {ranks.map((role) => (
                  <option
                    value={role.id}
                    key={role.id}
                    disabled={
                      !data.founder &&
                      ["Founder", "Manager"].includes(role.name)
                    }
                  >
                    {role.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="roles-help">
              Choose one community rank. This replaces other community ranks
              while keeping unrelated Discord roles. Only Founders may assign or
              remove Manager and Founder.
            </p>
            <div className="role-checks">
              {teams.map((role) => (
                <label key={role.id}>
                  <input
                    type="checkbox"
                    checked={specialists.includes(role.id)}
                    onChange={(event) =>
                      setSpecialists(
                        event.target.checked
                          ? [...specialists, role.id]
                          : specialists.filter((id) => id !== role.id),
                      )
                    }
                  />
                  {role.label}
                </label>
              ))}
            </div>
            <h5>Staff-server access roles</h5>
            <p className="roles-help">
              Dashboard and Huly also require these separate Discord access
              roles. A rank alone does not grant access.
            </p>
            <div className="role-checks">
              <label>
                <input
                  type="checkbox"
                  checked={access.dashboard}
                  disabled={rankLocked || ownFounder}
                  onChange={(event) =>
                    setAccess((previous) => ({
                      ...previous,
                      dashboard: event.target.checked,
                    }))
                  }
                />
                Dashboard access
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={access.todo}
                  disabled={rankLocked}
                  onChange={(event) =>
                    setAccess((previous) => ({
                      ...previous,
                      todo: event.target.checked,
                    }))
                  }
                />
                Huly / Todo access
              </label>
            </div>
          </fieldset>
          {data.canAssign &&
            (confirming ? (
              <div
                className="role-confirm"
                role="group"
                aria-label="Confirm role changes"
              >
                <p>
                  Update <strong>{selected.name}</strong> to{" "}
                  <strong>
                    {ranks.find((role) => role.id === rank)?.label ??
                      "No community rank"}
                  </strong>
                  {specialists.length
                    ? ` with ${teams
                        .filter((role) => specialists.includes(role.id))
                        .map((role) => role.label)
                        .join(", ")}`
                    : " with no specialist roles"}
                  ? Dashboard access: {access.dashboard ? "on" : "off"}. Huly
                  access: {access.todo ? "on" : "off"}.
                </p>
                <button className="button" disabled={busy} onClick={assign}>
                  {busy ? "Saving…" : "Confirm Discord changes"}
                </button>
                <button
                  className="role-secondary"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Review role changes
              </button>
            ))}
        </section>
      )}
    </section>
  );
}

export function Roles({ csrf, userId }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState("permissions");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(null);
  const [auditRefresh, setAuditRefresh] = useState(0);
  const dirty = Boolean(
    data && JSON.stringify(draft) !== JSON.stringify(draftRoles(data)),
  );
  async function load(signal) {
    const result = await request("/", { signal });
    if (signal?.aborted) return;
    setData(result);
    setDraft(draftRoles(result));
    setSelected(
      (previous) => previous ?? result.roles.find((role) => role.id)?.id,
    );
  }
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    request("/history", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setHistory(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistory({ error: true });
      });
    return () => controller.abort();
  }, [auditRefresh]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function reload() {
    if (
      dirty &&
      !window.confirm("Discard your unsaved permission changes and reload?")
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ revision: data.revision, roles: draft }),
      });
      setData((previous) => ({
        ...previous,
        revision: result.revision,
        roles: previous.roles.map((role) => ({
          ...role,
          permissions:
            draft.find((entry) => entry.id === role.id)?.permissions ??
            role.permissions,
        })),
      }));
      setNotice(
        "Permissions saved. Server checks use them immediately. Refresh dashboard pages to update their navigation and controls.",
      );
      setAuditRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  function toggle(key, enabled) {
    setDraft((previous) =>
      previous.map((entry) => {
        if (entry.id !== selected) return entry;
        const permissions = { ...entry.permissions, [key]: enabled };
        function enable(key) {
          permissions[key] = true;
          for (const parent of data.permissions.find(
            (permission) => permission.key === key,
          ).requires)
            enable(parent);
        }
        if (enabled) enable(key);
        else
          for (const permission of data.permissions)
            if (permission.requires.some((parent) => !permissions[parent]))
              permissions[permission.key] = false;
        return { ...entry, permissions };
      }),
    );
    setNotice("");
  }
  const role = data?.roles.find((role) => role.id === selected);
  const values =
    draft.find((entry) => entry.id === selected)?.permissions ?? {};
  return (
    <section className="roles-page" aria-labelledby="roles-title">
      <div className="roles-heading">
        <div>
          <span className="roles-eyebrow">
            DISCORD ROLES · DASHBOARD PERMISSIONS
          </span>
          <h2 id="roles-title">Roles</h2>
          <p>
            Fine-tune what each rank can do and manage staff roles from one
            place.
          </p>
        </div>
        <button className="role-secondary" disabled={busy} onClick={reload}>
          Reload saved permissions
        </button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="role-success" role="status">
          {notice}
        </p>
      )}
      {!data ? (
        <p role="status">Loading roles…</p>
      ) : (
        <>
          <div
            className="roles-tabs"
            role="group"
            aria-label="Role management views"
          >
            <button
              aria-pressed={tab === "permissions"}
              className={tab === "permissions" ? "button" : "role-secondary"}
              onClick={() => setTab("permissions")}
            >
              Dashboard permissions
            </button>
            <button
              aria-pressed={tab === "members"}
              disabled={!data.assignmentEnabled}
              className={tab === "members" ? "button" : "role-secondary"}
              onClick={() => setTab("members")}
            >
              Discord members
            </button>
          </div>
          <div hidden={tab !== "permissions"}>
            <p className="roles-help">
              Members receive the combined permissions of all their roles.
              Turning a permission off for one role does not remove it if
              another role grants it. Enabling a permission also enables the
              access it requires.
            </p>
            <div className="role-permission-layout">
              <nav className="role-picker" aria-label="Staff roles">
                {data.roles.map((item) => {
                  const discord = data.discordRoles.find(
                    (native) => native.id === item.id,
                  );
                  return (
                    <button
                      key={item.name}
                      disabled={!item.id || busy}
                      className={item.id === selected ? "selected" : ""}
                      aria-pressed={item.id === selected}
                      onClick={() => setSelected(item.id)}
                    >
                      <span
                        className="role-color"
                        style={{
                          backgroundColor:
                            discord?.color && discord.color !== "#000000"
                              ? discord.color
                              : "#5865f2",
                        }}
                      />
                      <span>
                        {item.label}
                        <small>
                          {!item.id
                            ? "Not configured"
                            : discord?.assignable
                              ? "Discord role ready"
                              : "Bot hierarchy may block assignment"}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </nav>
              {role && (
                <div className="role-permissions">
                  <h3>{role.label} permissions</h3>
                  {!role.editable && (
                    <p className="roles-help">
                      Only a Founder can edit this role.
                    </p>
                  )}
                  {[
                    ...new Set(
                      data.permissions.map((permission) => permission.group),
                    ),
                  ].map((group) => (
                    <fieldset
                      key={group}
                      disabled={busy || !data.canEdit || !role.editable}
                    >
                      <legend>{group}</legend>
                      {data.permissions
                        .filter((permission) => permission.group === group)
                        .map((permission) => (
                          <label
                            className="role-permission"
                            key={permission.key}
                          >
                            <span>
                              <strong>{permission.label}</strong>
                              <small>
                                {permission.description}
                                {role.locked.includes(permission.key) &&
                                  " This setting is protected."}
                              </small>
                            </span>
                            <input
                              type="checkbox"
                              role="switch"
                              checked={Boolean(values[permission.key])}
                              disabled={role.locked.includes(permission.key)}
                              onChange={(event) =>
                                toggle(permission.key, event.target.checked)
                              }
                            />
                          </label>
                        ))}
                    </fieldset>
                  ))}
                </div>
              )}
            </div>
            <div className="role-save-bar">
              <p>
                {dirty
                  ? "Unsaved changes across your selected roles"
                  : `Saved permission revision ${data.revision}`}
              </p>
              <button
                className="role-secondary"
                disabled={!dirty || busy}
                onClick={() => {
                  setDraft(draftRoles(data));
                  setNotice("");
                }}
              >
                Discard changes
              </button>
              <button
                className="button"
                disabled={!data.canEdit || !dirty || busy}
                onClick={save}
              >
                {busy ? "Saving…" : "Save permissions for all roles"}
              </button>
            </div>
          </div>
          {tab === "members" && (
            <MemberRoles
              data={data}
              csrf={csrf}
              userId={userId}
              onAudit={() => setAuditRefresh((value) => value + 1)}
            />
          )}
          <details className="role-history">
            <summary>Recent role management activity</summary>
            {history?.error ? (
              <p>
                Could not load activity.{" "}
                <button
                  className="role-secondary"
                  onClick={() => setAuditRefresh((value) => value + 1)}
                >
                  Retry
                </button>
              </p>
            ) : history ? (
              <ul>
                {history.items.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.actor.name}</strong>{" "}
                    {entry.action === "permissions"
                      ? `saved permission revision ${entry.revision}`
                      : `requested Discord role changes for ${entry.memberId}`}
                    <small>{time(entry.at)}</small>
                  </li>
                ))}
                {!history.items.length && (
                  <li>No role management changes yet.</li>
                )}
              </ul>
            ) : (
              <p>Loading activity…</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
