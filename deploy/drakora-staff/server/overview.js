import { visibleInboxes } from "../shared/staff-permissions.js";
import { networkMonitor } from "./network-status.js";
import { applicationReviewAccess, mailAccess } from "./roles.js";

export function overviewService(
  config,
  { applications, mail, queues, probe, tickets } = {},
) {
  const network = networkMonitor(config.overview?.servers, probe);
  const mailSnapshots = new Map();
  const mailRequests = new Map();
  async function inbox(user) {
    const scope = visibleInboxes(user, mail.identities || [])
      .map((address) => address.toLowerCase())
      .sort();
    if (!scope.length) return { available: false };
    const key = scope.join(",");
    const mailSnapshot = mailSnapshots.get(key);
    if (mailRequests.has(key)) return mailRequests.get(key);
    if (mailSnapshot && Date.now() - mailSnapshot.checkedAt < 30000)
      return mailSnapshot;
    const pending = mail
      .attention(scope)
      .then((result) => {
        const snapshot = { available: true, ...result, checkedAt: Date.now() };
        mailSnapshots.set(key, snapshot);
        return snapshot;
      })
      .catch(() => {
        const snapshot = { available: false, checkedAt: Date.now() };
        mailSnapshots.set(key, snapshot);
        return snapshot;
      })
      .finally(() => {
        mailRequests.delete(key);
      });
    if (mailSnapshots.size >= 128)
      mailSnapshots.delete(mailSnapshots.keys().next().value);
    mailRequests.set(key, pending);
    return pending;
  }
  async function emailStatus(user) {
    let timer;
    try {
      return await Promise.race([
        inbox(user),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ available: false, loading: true }),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async snapshot(user) {
      const [status, email, discord] = await Promise.all([
        network.snapshot(),
        mail && mailAccess(config, user) ? emailStatus(user) : null,
        queues ? queues(user) : [],
      ]);
      return {
        network: status,
        applications:
          applications && applicationReviewAccess(config, user)
            ? applications.attention()
            : null,
        email,
        queues: [
          ...discord,
          ...(tickets && user.capabilities?.["tickets.view"]
            ? [tickets.attention(user)]
            : []),
        ],
        queueKinds: [
          ...new Set([
            ...(config.overview?.queues ?? []).map((queue) => queue.kind),
            ...(tickets ? ["tickets"] : []),
          ]),
        ],
      };
    },
  };
}
