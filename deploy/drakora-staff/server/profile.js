import apiClient from "@hcengineering/api-client";

export async function syncAvatar(config, token, account, avatar) {
  if (!avatar || new URL(avatar).origin !== "https://cdn.discordapp.com")
    throw new Error("Invalid Discord avatar");
  const client = await apiClient.createRestTxOperations(
    "http://transactor:3333",
    config.hulyWorkspace,
    token,
  );
  try {
    const person = await client.findOne("contact:class:Person", {
      personUuid: account,
    });
    if (!person) throw new Error("Huly member profile was not found");
    if (person.avatarType !== "external" || person.avatarProps?.url !== avatar)
      await client.updateDoc(person._class, person.space, person._id, {
        avatarType: "external",
        avatarProps: { url: avatar },
      });
  } finally {
    await client.close();
  }
}
