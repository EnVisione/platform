import { networkMonitor } from "./network-status.js";
import { applicationReviewAccess, mailAccess } from "./roles.js";

export function overviewService(
  config,
  { applications, mail, queues, probe } = {},
) {
  const network = networkMonitor(config.overview?.servers, probe);
  let mailSnapshot;
  let mailPending;
  async function inbox() {
    if (mailSnapshot && Date.now() - mailSnapshot.checkedAt < 30000)
      return mailSnapshot;
    if (mailPending) return mailPending;
    mailPending = mail
      .attention()
      .then((result) => {
        mailSnapshot = { available: true, ...result, checkedAt: Date.now() };
        return mailSnapshot;
      })
      .catch(() => {
        mailSnapshot = { available: false, checkedAt: Date.now() };
        return mailSnapshot;
      })
      .finally(() => {
        mailPending = undefined;
      });
    return mailPending;
  }
  async function emailStatus() {
    let timer;
    try {
      return await Promise.race([
        inbox(),
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
        mail && mailAccess(config, user) ? emailStatus() : null,
        queues ? queues(user) : [],
      ]);
      return {
        network: status,
        applications:
          applications && applicationReviewAccess(config, user)
            ? applications.attention()
            : null,
        email,
        queues: discord,
        queueKinds: [
          ...new Set(
            (config.overview?.queues ?? []).map((queue) => queue.kind),
          ),
        ],
      };
    },
  };
}
