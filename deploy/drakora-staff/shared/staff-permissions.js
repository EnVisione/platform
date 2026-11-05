import { ticketCategories } from "./tickets.js";

export const staffPermissions = [
  [
    "bot.view",
    "Bot",
    "View bot settings",
    "Read custom commands, supported pack versions, change history and safe saved-reply previews.",
  ],
  [
    "bot.edit",
    "Bot",
    "Edit bot settings",
    "Create, edit, enable and delete commands, preview drafts and change supported-version overrides.",
    ["bot.view"],
  ],
  [
    "players.view",
    "Players",
    "View players and playtime",
    "Read connected players, reported server, heartbeat and committed playtime.",
  ],
  [
    "moderation.warn",
    "Moderation",
    "Issue warnings",
    "Create a warning on the selected platform only.",
    ["moderation.view"],
  ],
  [
    "moderation.mute",
    "Moderation",
    "Mute players",
    "Create temporary or permanent mutes on the selected platform only.",
    ["moderation.view"],
  ],
  [
    "moderation.ban",
    "Moderation",
    "Ban players",
    "Create temporary or permanent bans on the selected platform only.",
    ["moderation.view"],
  ],
  [
    "moderation.freeze",
    "Moderation",
    "Freeze Minecraft players",
    "Request a scoped Minecraft freeze and wait for backend confirmation.",
    ["moderation.view"],
  ],
  [
    "moderation.kick",
    "Moderation",
    "Kick Minecraft players",
    "Request a kick of a matching online session.",
    ["moderation.view"],
  ],
  [
    "moderation.ip",
    "Moderation",
    "View IP associations",
    "Admin or higher can inspect reported addresses and possible shared-IP accounts. An association does not establish ownership or wrongdoing.",
    ["moderation.view", "players.view"],
  ],
  [
    "moderation.ipban",
    "Moderation",
    "Issue scoped IP bans",
    "Admin or higher can ban a reported Minecraft address in a selected scope.",
    ["moderation.view", "moderation.ip"],
  ],
  [
    "staffnotes.view",
    "Staff notes",
    "View player notices",
    "Read player-visible staff notes and explicit acknowledgement times.",
    ["moderation.view", "players.view"],
  ],
  [
    "staffnotes.create",
    "Staff notes",
    "Send player notices",
    "Send high- or low-priority player notices in a selected network scope.",
    ["staffnotes.view"],
  ],
  [
    "staffnotes.clear",
    "Staff notes",
    "Clear player notices",
    "Stop pending notices while retaining their acknowledgement and clearing history.",
    ["staffnotes.view"],
  ],
  [
    "moderation.notes",
    "Moderation",
    "Write private case notes",
    "Add staff-only evidence, notes and conclusions. These are never sent to players.",
    ["moderation.view"],
  ],
  [
    "moderation.revoke",
    "Moderation",
    "Revoke sanctions",
    "Revoke an individual case without clearing other active cases.",
    ["moderation.view"],
  ],
  [
    "moderation.appeals",
    "Moderation",
    "Review appeals",
    "Accept or deny appeals with a player-visible decision. Acceptance also requires permission to revoke the case action.",
    ["moderation.view"],
  ],
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
    "tickets.takeover",
    "Tickets",
    "Take over tickets",
    "Managers and Founders can take any accessible ticket. Other staff need two ranks above its assignee, or Manager approval in the private staff thread.",
    ["tickets.claim"],
  ],
  [
    "tickets.close",
    "Tickets",
    "Resolve tickets",
    "Record the work and commands used, attach proof, and close tickets.",
    ["tickets.view"],
  ],
  [
    "tickets.rating.override",
    "Tickets",
    "Override support ratings",
    "Managers and Founders can exclude, replace or restore a ticket rating with a recorded reason.",
    ["tickets.view", "logs.view"],
  ],
  [
    "tickets.macros.manage",
    "Tickets",
    "Manage ticket macros",
    "Create, edit and remove shared reply templates in ticket categories you can reply to.",
    ["tickets.view", "tickets.reply"],
  ],
  [
    "tickets.delete",
    "Tickets",
    "Delete closed Discord channels",
    "Admin or higher can remove a closed channel after its transcript is saved. Dashboard history is kept.",
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

export function ticketPermissionScope(key) {
  if (key === "tickets.rating.override") return "rank";
  if (/^tickets\.category\.(billing|staff|partnership)\./.test(key))
    return "rank";
  return key.startsWith("tickets.") || key === "logs.view" ? "tickets" : null;
}

export function staffPermissionCatalog(identities = [], ticketRole = false) {
  const categoryPermissions = ticketCategories.flatMap(
    ({ id: category, name }) =>
      (category === "partnership"
        ? ["view", "decide"]
        : ["view", "reply", "claim", "takeover", "close", "delete"]
      ).map((action) => ({
        key: `tickets.category.${category}.${action}`,
        group: `${name} tickets`,
        label:
          category === "partnership"
            ? action === "view"
              ? "View partnership requests"
              : "Accept or deny partnership requests"
            : `${{ view: "View", reply: "Reply to", claim: "Claim", takeover: "Take over", close: "Resolve", delete: "Delete channels for", decide: "Accept or deny" }[action]} ${name.toLowerCase()} tickets`,
        description: ticketRole
          ? ["billing", "staff"].includes(category)
            ? "Requires the main-server Tickets role and this rank grant. Defaults to Manager and Founder; Managers can change access for any rank."
            : category === "partnership"
              ? "Requires the main-server Tickets role and Manager or Founder access."
              : "Requires the main-server Tickets role. Staff ranks do not grant general ticket access."
          : category === "billing"
            ? "Billing access is limited to Founders. Only a Founder can change these grants."
            : ["partnership", "staff"].includes(category)
              ? "Access is limited to Managers and Founders, including messages, files, history and transcripts."
              : "All dashboard staff have view access by default. Replying, claiming and resolving use separate permissions.",
        requires: [
          "dashboard.view",
          "tickets.view",
          ...(action === "view" || action === "decide"
            ? action === "decide"
              ? [`tickets.category.${category}.view`]
              : []
            : [
                `tickets.${action}`,
                `tickets.category.${category}.view`,
                ...(action === "takeover"
                  ? [`tickets.category.${category}.claim`]
                  : []),
              ]),
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
