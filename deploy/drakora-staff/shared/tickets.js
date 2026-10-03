export const ticketTypes = [
  ["general", "General support"],
  ["billing", "Purchases, ranks or billing"],
  ["game", "In-game help"],
  ["discord", "Discord help"],
  ["bug", "Bug or technical issue"],
  ["exploit", "Report an exploit"],
  ["player", "Report a player"],
  ["staff", "Report a staff member"],
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
