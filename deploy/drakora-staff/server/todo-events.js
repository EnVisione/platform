import apiClient from "@hcengineering/api-client";
import nativeClient from "@hcengineering/client-resources";

export function trackerEvents(
  config,
  huly,
  changed,
  {
    connect = nativeClient.connect,
    socketFactory = apiClient.NodeWebSocketFactory,
  } = {},
) {
  const projects = new Set(config.todoForums.map((forum) => forum.projectId));
  function relevant(tx) {
    if (!tx || typeof tx !== "object") return false;
    if (tx.tx) return relevant(tx.tx);
    if (Array.isArray(tx.txes)) return tx.txes.some(relevant);
    if (tx.objectClass === "tags:class:TagElement")
      return tx.objectSpace === "core:space:Workspace";
    return (
      projects.has(tx.objectSpace) &&
      [
        "tracker:class:Issue",
        "chunter:class:ChatMessage",
        "tags:class:TagReference",
      ].includes(tx.objectClass)
    );
  }
  return connect(
    "ws://transactor:3333/",
    (...transactions) => {
      if (transactions.some(relevant)) changed();
    },
    config.hulyWorkspace,
    config.hulyOwner,
    {
      socketFactory(url) {
        const endpoint = new URL(url);
        endpoint.pathname = `/${huly.serviceToken()}`;
        return socketFactory(endpoint.href);
      },
      onConnect: async () => changed(),
      onError: () =>
        console.error("Tracker change notifications are unavailable."),
    },
  );
}
