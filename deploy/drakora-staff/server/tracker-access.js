import apiClient from "@hcengineering/api-client";

let pending = Promise.resolve();

export function trackerProjectIds(config, user) {
  if (!user.permissions?.dashboard || !user.permissions?.todo) return [];
  const roles = new Set(user.roles ?? []);
  return (config.trackerProjects ?? [])
    .filter((project) => project.roleIds.some((id) => roles.has(id)))
    .map((project) => project.projectId);
}

async function withClient(config, token, action) {
  const next = pending.then(async () => {
    const client = await apiClient.createRestTxOperations(
      "http://transactor:3333",
      config.hulyWorkspace,
      token,
    );
    try {
      await action(client);
    } finally {
      await client.close();
    }
  });
  pending = next.catch(() => {});
  return next;
}

export async function reconcileTrackerProjects(client, config, users, account) {
  const projects = [];
  for (const settings of config.trackerProjects ?? []) {
    const project = await client.findOne("tracker:class:Project", {
      _id: settings.projectId,
    });
    if (!project)
      throw new Error(`Tracker project ${settings.name} was not found`);
    projects.push({ settings, project });
  }
  for (const { settings, project } of projects) {
    const current = new Set(project.members ?? []);
    const members = account ? new Set(current) : new Set();
    for (const user of users) {
      if (!user.hulyAccount || (account && user.hulyAccount !== account))
        continue;
      members.delete(user.hulyAccount);
      if (trackerProjectIds(config, user).includes(settings.projectId))
        members.add(user.hulyAccount);
    }
    members.add(config.hulyOwner);
    const update = {};
    if (!project.private) update.private = true;
    if (project.autoJoin !== false) update.autoJoin = false;
    if (project.autoJoinForRoles?.length) update.autoJoinForRoles = [];
    if (
      JSON.stringify([...current].sort()) !==
      JSON.stringify([...members].sort())
    )
      update.members = [...members];
    if (Object.keys(update).length)
      await client.updateDoc(
        project._class,
        project.space,
        project._id,
        update,
      );
  }
}

export function syncTrackerMember(config, token, user, account) {
  if (!config.trackerProjects?.length) return Promise.resolve();
  return withClient(config, token, (client) =>
    reconcileTrackerProjects(
      client,
      config,
      [{ ...user, hulyAccount: account }],
      account,
    ),
  );
}

export function trackerAccessService(config, store, huly, discord) {
  let timer;
  let interval;
  let active;
  let queued = false;
  let stopped = false;
  async function refresh() {
    if (stopped) return;
    if (active) {
      queued = true;
      return active;
    }
    active = (async () => {
      const users = [];
      for (const [id, saved] of store.entries("user")) {
        if (!saved.hulyAccount) continue;
        const checked = await discord.check(id, true);
        users.push(await huly.sync(checked));
      }
      await withClient(config, huly.serviceToken(), (client) =>
        reconcileTrackerProjects(client, config, users),
      );
    })().finally(() => {
      active = undefined;
      if (queued && !stopped) {
        queued = false;
        changed();
      }
    });
    return active;
  }
  function changed() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void refresh().catch(() =>
        console.error("Tracker role access reconciliation is pending."),
      );
    }, 750).unref();
  }
  return {
    changed,
    start() {
      changed();
      interval ??= setInterval(changed, 60000).unref();
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(interval);
      await active?.catch(() => {});
    },
  };
}
