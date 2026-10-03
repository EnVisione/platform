const expiry = Number.MAX_SAFE_INTEGER;
const name = "Drakora Tracker";

export function trackerWebhooks(store, discord, botId) {
  const hooks = new Map();
  async function hook(forumId, existingId) {
    const key = existingId || forumId;
    if (hooks.has(key)) return hooks.get(key);
    const saved = store.get("discord-todo-webhooks", key);
    if (saved?.channelId === forumId && saved.token) {
      hooks.set(key, saved);
      return saved;
    }
    let value;
    if (existingId) value = await discord(`/webhooks/${existingId}`);
    else {
      const available = await discord(`/channels/${forumId}/webhooks`);
      value = available.find(
        (item) => item.name === name && item.user?.id === botId,
      );
      if (!value)
        value = await discord(`/channels/${forumId}/webhooks`, {
          method: "POST",
          body: { name },
        });
    }
    if (
      value?.type !== 1 ||
      value.user?.id !== botId ||
      value.channel_id !== forumId ||
      !value.token ||
      !/^\d+$/.test(value.id)
    )
      throw new Error("Tracker webhook ownership is unavailable");
    const record = { id: value.id, token: value.token, channelId: forumId };
    store.set("discord-todo-webhooks", value.id, record, expiry);
    if (!existingId)
      store.set("discord-todo-webhooks", forumId, record, expiry);
    hooks.set(value.id, record);
    if (!existingId) hooks.set(forumId, record);
    return record;
  }
  async function request(thread, value, messageId, body, threadDiscord) {
    const suffix = messageId ? `/messages/${messageId}` : "";
    const query = new URLSearchParams({
      thread_id: thread.id,
      ...(messageId ? {} : { wait: "true" }),
    });
    try {
      return await threadDiscord(
        `/webhooks/${value.id}/${value.token}${suffix}?${query}`,
        { method: messageId ? "PATCH" : "POST", body },
      );
    } catch (error) {
      if (error.code === 10015) {
        for (const key of [value.id, value.channelId]) {
          if (store.get("discord-todo-webhooks", key)?.id !== value.id)
            continue;
          hooks.delete(key);
          store.delete("discord-todo-webhooks", key);
        }
      }
      throw error;
    }
  }
  return { hook, request };
}
