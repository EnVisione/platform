import apiClient from "@hcengineering/api-client";
const { createRestTxOperations } = apiClient;

let pending = Promise.resolve();

export function syncProjectRoles(config, token, account, names) {
  const action = pending.then(() =>
    reconcileProjectRoles(config, token, account, names),
  );
  pending = action.catch(() => {});
  return action;
}

async function reconcileProjectRoles(config, token, account, names) {
  const client = await createRestTxOperations(
    "http://transactor:3333",
    config.hulyWorkspace,
    token,
  );
  try {
    const project = await client.findOne("tracker:class:Project", {
      _id: "tracker:project:DefaultProject",
    });
    if (!project) throw new Error("Staff Tasks project was not found");
    const type = await client.findOne("core:class:SpaceType", {
      _id: project.type,
    });
    if (!type?.targetClass)
      throw new Error("Staff Tasks project type was not found");
    const existing = await client.findAll("core:class:Role", {
      attachedTo: type._id,
    });
    const assignments = client.getHierarchy().as(project, type.targetClass);
    const updates = {};
    for (const rank of config.ranks) {
      let role = existing.find(
        (item) => item._id === `drakora:role:${rank.id}`,
      );
      if (!role) {
        const id = `drakora:role:${rank.id}`;
        await client.addCollection(
          "core:class:Role",
          type.space,
          type._id,
          type._class,
          "roles",
          { name: rank.name, permissions: [] },
          id,
        );
        role = { _id: id };
      }
      const attribute = await client.findOne("core:class:Attribute", {
        name: role._id,
        attributeOf: type.targetClass,
      });
      if (!attribute) {
        const label = `embedded:embedded:Role: ${rank.name}`;
        const editor = "setting:component:RoleAssignmentEditor";
        await client.createDoc(
          "core:class:Attribute",
          "core:space:Model",
          {
            name: role._id,
            attributeOf: type.targetClass,
            label,
            type: {
              _class: "core:class:TypeAny",
              label,
              presenter: editor,
              editor,
            },
          },
          `drakora:attribute:${rank.id}`,
        );
      }
      const current = assignments?.[role._id] ?? [];
      const next = current.filter((value) => value !== account);
      if (names.includes(rank.name)) next.push(account);
      if (
        JSON.stringify([...current].sort()) !== JSON.stringify([...next].sort())
      )
        updates[role._id] = next;
    }
    if (Object.keys(updates).length)
      await client.createMixin(
        project._id,
        project._class,
        project.space,
        type.targetClass,
        updates,
      );
  } finally {
    await client.close();
  }
}
