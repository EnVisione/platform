import { ticketCategories } from "./tickets.js";

export const staffPermissions = [
  [
    "moderation.view",
    "Moderation",
    "View moderation history",
    "Read recorded warnings, timeouts and bans, including their reasons and linked applicant or ticket history.",
  ],
  [
    "tickets.view",
    "Tickets",
    "Open ticket queues",
    "Open Tickets. Each category also requires its own view permission.",
  ],
  [
    "tickets.reply",
    "Tickets",
    "Reply to tickets",
    "Send messages and attachments to players.",
    ["tickets.view"],
  ],
  [
    "tickets.claim",
    "Tickets",
    "Claim tickets",
    "Take responsibility for an unclaimed ticket.",
    ["tickets.view"],
  ],
  [
    "tickets.close",
    "Tickets",
    "Resolve tickets",
    "Record the work and commands used, attach proof, and close tickets.",
    ["tickets.view"],
  ],
  [
    "logs.view",
    "Logs",
    "View ticket logs",
    "Read ticket history and private staff transcripts. Category permissions also apply to transcripts.",
    ["tickets.view"],
  ],
  [
    "dashboard.view",
    "Dashboard",
    "Open the staff dashboard",
    "Sign in and open the overview.",
  ],
  [
    "huly.access",
    "Workspace",
    "Open Tracker and Calendar",
    "Open Tracker and Calendar with your dashboard account. Workspace membership is created automatically.",
  ],
  [
    "office.view",
    "Workspace",
    "View the staff office",
    "See staff activity, voice rooms and meetings.",
    ["huly.access"],
  ],
  [
    "office.host",
    "Workspace",
    "Host meetings",
    "Start and end staff meetings.",
    ["office.view"],
  ],
  [
    "applications.view",
    "Staff Applications",
    "View applications",
    "Read submissions, applicant history and staff feedback.",
  ],
  [
    "applications.comment",
    "Staff Applications",
    "Post staff feedback",
    "Share feedback on an applicant.",
    ["applications.view"],
  ],
  [
    "applications.review",
    "Staff Applications",
    "Start reviewing",
    "Mark an application as under review and notify the applicant.",
    ["applications.view"],
  ],
  [
    "applications.approve",
    "Staff Applications",
    "Approve applications",
    "Accept applications and notify the applicant.",
    ["applications.view"],
  ],
  [
    "applications.deny",
    "Staff Applications",
    "Deny applications",
    "Deny applications and choose the message and reapplication wait.",
    ["applications.view"],
  ],
  [
    "applications.edit",
    "Staff Applications",
    "Edit application questions",
    "Edit and save all four application forms.",
    ["applications.view"],
  ],
  [
    "accounts.view",
    "Accounts",
    "View registered accounts",
    "See linked Minecraft names, ranks and Discord activity.",
  ],
  [
    "accounts.minecraft",
    "Accounts",
    "Approve Minecraft name changes",
    "Approve or reject requested Minecraft name changes.",
    ["accounts.view"],
  ],
  [
    "mail.view",
    "Email",
    "View email",
    "Read, search and filter the shared Drakora mailbox.",
  ],
  [
    "mail.attachments",
    "Email",
    "Download email attachments",
    "Download attachments from received email.",
    ["mail.view"],
  ],
  [
    "mail.flags",
    "Email",
    "Change email read status and stars",
    "Mark email read or unread and add or remove stars.",
    ["mail.view"],
  ],
  [
    "mail.delete",
    "Email",
    "Delete email",
    "Move shared email to Trash.",
    ["mail.view"],
  ],
  [
    "mail.send",
    "Email",
    "Send email",
    "Compose, reply and forward from configured Drakora addresses.",
    ["mail.view"],
  ],
  [
    "settings.view",
    "Settings",
    "Open settings",
    "Change dashboard appearance and see the linked Minecraft name.",
  ],
  [
    "settings.minecraft",
    "Settings",
    "Request a Minecraft name change",
    "Submit a name correction for approval.",
    ["settings.view"],
  ],
  [
    "roles.view",
    "Roles",
    "View roles and permissions",
    "Open the Roles tab. Limited to Managers and Founders.",
  ],
  [
    "roles.edit",
    "Roles",
    "Edit dashboard permissions",
    "Change the permission switches for staff roles. Limited to Managers and Founders.",
    ["roles.view"],
  ],
  [
    "roles.assign",
    "Roles",
    "Assign Discord roles",
    "Change member ranks and specialist roles in Discord. Limited to Managers and Founders.",
    ["roles.view"],
  ],
].map(([key, group, label, description, requires = []]) => ({
  key,
  group,
  label,
  description,
  requires: key === "dashboard.view" ? [] : ["dashboard.view", ...requires],
}));

export const protectedFounderPermissions = [
  "dashboard.view",
  "roles.view",
  "roles.edit",
  "roles.assign",
];

export const inboxPermission = (address, action = "view") =>
  `mail.inbox.${address.toLowerCase()}.${action}`;

export function staffPermissionCatalog(identities = []) {
  const categoryPermissions = ticketCategories.flatMap(
    ({ id: category, name }) =>
      ["view", "reply", "claim", "close"].map((action) => ({
        key: `tickets.category.${category}.${action}`,
        group: `${name} tickets`,
        label: `${{ view: "View", reply: "Reply to", claim: "Claim", close: "Resolve" }[action]} ${name.toLowerCase()} tickets`,
        description:
          category === "billing"
            ? "Billing access defaults to Founders. Only a Founder can change these grants."
            : "Applies to the queue, messages, files, history and transcripts in this category.",
        requires: [
          "dashboard.view",
          "tickets.view",
          ...(action === "view"
            ? []
            : [`tickets.${action}`, `tickets.category.${category}.view`]),
        ],
      })),
  );
  const inboxPermissions = identities.flatMap(({ address }) =>
    ["view", "send", "reply"].map((action) => ({
      key: inboxPermission(address, action),
      group: `Inbox · ${address}`,
      label: {
        view: "View inbox",
        send: "Compose and forward",
        reply: "Reply to received email",
      }[action],
      description: `Controls ${action === "view" ? "messages, search, files and counts" : action === "send" ? "new messages and forwards" : "replies to visible messages"} for ${address}.`,
      requires: [
        "dashboard.view",
        "mail.view",
        ...(action === "view" ? [] : ["mail.send", inboxPermission(address)]),
      ],
    })),
  );
  return [...staffPermissions, ...categoryPermissions, ...inboxPermissions];
}

export function visibleInboxes(user, identities) {
  return identities
    .filter(
      ({ address }) =>
        user.capabilities?.["mail.view"] &&
        user.capabilities?.[inboxPermission(address)],
    )
    .map(({ address }) => address);
}

export function permissionDependencies(values, catalog = staffPermissions) {
  const result = { ...values };
  for (const permission of catalog)
    result[permission.key] = Boolean(
      result[permission.key] && permission.requires.every((key) => result[key]),
    );
  return result;
}
