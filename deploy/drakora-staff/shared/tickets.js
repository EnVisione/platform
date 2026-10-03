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
  claimed: "Being helped",
  awaiting_resolution: "Awaiting staff resolution",
  closed: "Closed",
};

export const ticketMediaDays = 30;
export const ticketUploadLimit = 8 * 1024 * 1024;
export const ticketMessageUploadLimit = 20 * 1024 * 1024;
export const ticketPath = (ticket) =>
  `/help/${encodeURIComponent(ticket.ign)}/${ticket.id}`;

export const ticketCategories = [
  { id: "support", name: "Support" },
  { id: "billing", name: "Billing" },
  { id: "partnership", name: "Partnerships" },
  { id: "staff", name: "Staff reports" },
];
export const ticketCategory = (ticket) =>
  ["billing", "partnership", "staff"].includes(ticket.type)
    ? ticket.type
    : "support";
export const ticketCapability = (ticket, action = "view") =>
  `tickets.category.${ticketCategory(ticket)}.${action}`;
