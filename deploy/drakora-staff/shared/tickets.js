export const ticketTypes = [
  ["general", "General support"],
  ["billing", "Purchases, ranks or billing"],
  ["game", "In-game help"],
  ["discord", "Discord help"],
  ["bug", "Bug or technical issue"],
  ["exploit", "Report an exploit"],
  ["player", "Report a player"],
  ["staff", "Report a staff member"],
  ["partnership", "Modpack partnership"],
].map(([id, name]) => ({ id, name }));

export const ticketStatuses = {
  pending: "Waiting for staff",
  claimed: "Claimed or staff replied",
  awaiting_resolution: "Awaiting staff resolution",
  closed: "Closed",
};

export function ticketStatusLabel(ticket) {
  if (ticket.status === "claimed") {
    if (ticket.claimedBy) return `Claimed by ${ticket.claimedBy.name}`;
    if (ticket.helpedBy) return `Staff replied · ${ticket.helpedBy.name}`;
    return "Staff replied";
  }
  return ticketStatuses[ticket.status];
}

export const ticketMediaDays = 30;
export const ticketUploadLimit = 8 * 1024 * 1024;
export const ticketMessageUploadLimit = 20 * 1024 * 1024;
export const ticketPath = (ticket) =>
  `/help/${encodeURIComponent(ticket.ign)}/${ticket.id}`;

export const ticketCategories = [
  { id: "support", name: "Support" },
  { id: "reports", name: "Reports" },
  { id: "billing", name: "Billing" },
  { id: "partnership", name: "Partnerships" },
  { id: "staff", name: "Staff reports" },
];
export const ticketCategory = (ticket) =>
  ["player", "exploit"].includes(ticket.type)
    ? "reports"
    : ["billing", "partnership", "staff"].includes(ticket.type)
      ? ticket.type
      : "support";
export const ticketCapability = (ticket, action = "view") =>
  `tickets.category.${ticketCategory(ticket)}.${action}`;

export function ticketIntake(type) {
  if (type === "partnership" || !ticketTypes.some((item) => item.id === type))
    return null;
  const report = ["player", "staff"].includes(type);
  const details = {
    general: [
      "Open a support ticket",
      "What do you need help with?",
      "Explain what you need help with and include any relevant details.",
    ],
    game: [
      "Get in-game help",
      "Describe the in-game problem",
      "Tell us what happened, when it started, and any relevant world or coordinates.",
    ],
    discord: [
      "Get Discord help",
      "Describe the Discord problem",
      "Tell us what you need help with and which Discord area is affected.",
    ],
    billing: [
      "Get billing help",
      "Describe your purchase or billing question",
      "Include your order reference if available. Never share card numbers, payment details or passwords.",
    ],
    bug: [
      "Report a bug or technical issue",
      "Describe the issue and steps to reproduce",
      "What happened, what did you expect, and how can we reproduce it? Include the time, pack version and any error message.",
    ],
    exploit: [
      "Report an exploit privately",
      "Describe the exploit and its impact",
      "Explain the exploit, where you found it and its impact. Keep the details inside this private ticket.",
    ],
    player: [
      "Report a player",
      "What happened and when? Include evidence",
      "Describe the player's actions, when they happened and any witnesses. Include evidence links if available; you can attach screenshots after opening the ticket.",
    ],
    staff: [
      "Report a staff member",
      "What happened and when? Include evidence",
      "Describe the staff member's actions, when they happened and any witnesses. Include evidence links if available; you can attach screenshots after opening the ticket.",
    ],
  }[type];
  return {
    title: details[0],
    fields: [
      {
        id: "ign",
        label: "Your Minecraft Java username",
        min: 3,
        max: 16,
        placeholder: "Your in-game name",
      },
      ...(report
        ? [
            {
              id: "reportTarget",
              label:
                type === "staff"
                  ? "Staff member you are reporting"
                  : "Player you are reporting",
              min: 2,
              max: 100,
              placeholder:
                "Their Minecraft or Discord username, or Discord user ID",
            },
          ]
        : []),
      ...(type === "billing"
        ? [
            {
              id: "orderReference",
              label: "Order reference (if available)",
              required: false,
              min: 0,
              max: 100,
              placeholder:
                "Your order or transaction reference, without payment details",
            },
          ]
        : []),
      ...(type === "bug"
        ? [
            {
              id: "packVersion",
              label: "Modpack and version (if known)",
              required: false,
              min: 0,
              max: 100,
              placeholder: "For example: Prominence II, version 3.0",
            },
          ]
        : []),
      {
        id: "location",
        label: report
          ? "Where did this happen?"
          : {
              billing: "Product, rank or purchase affected",
              game: "Server, world and coordinates (if useful)",
              discord: "Discord server or channel affected",
              exploit: "Where can the exploit happen?",
            }[type] || "Affected server, world or Discord area",
        min: 2,
        max: 100,
        placeholder: "For example: Prominence II — Terra, Void, or Discord",
      },
      {
        id: "description",
        label: details[1],
        min: 30,
        max: 4000,
        placeholder: details[2],
        multiline: true,
      },
      ...(type === "game"
        ? [
            {
              id: "topic",
              label: "Quest, item or command (if relevant)",
              required: false,
              min: 0,
              max: 100,
              placeholder: "Name the affected quest, item or command",
            },
          ]
        : []),
      ...(type === "discord"
        ? [
            {
              id: "topic",
              label: "Role, permission or action affected",
              required: false,
              min: 0,
              max: 100,
              placeholder:
                "For example: getting a role or joining a voice channel",
            },
          ]
        : []),
      ...(type === "bug"
        ? [
            {
              id: "errorMessage",
              label: "Exact error message (if any)",
              required: false,
              min: 0,
              max: 1000,
              multiline: true,
              placeholder:
                "Paste the error text. Remove passwords, tokens and private information.",
            },
          ]
        : []),
      ...(type === "exploit"
        ? [
            {
              id: "impact",
              label: "Who or what can be affected?",
              required: false,
              min: 0,
              max: 100,
              placeholder:
                "For example: item duplication or unauthorized access",
            },
          ]
        : []),
    ],
  };
}

export const ticketDetails = (ticket) =>
  (ticketIntake(ticket.type)?.fields || [])
    .filter(
      (field) =>
        !["ign", "location", "description"].includes(field.id) &&
        ticket[field.id],
    )
    .map((field) => ({ label: field.label, value: ticket[field.id] }));
