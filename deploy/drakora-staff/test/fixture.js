export const accessRoles = { dashboard: "10", todo: "11" };
export const ranks = [
  ["20", "Founder", "OWNER", true],
  ["21", "Admin", "MAINTAINER", true],
  ["22", "Moderator", "USER", true],
  ["23", "Helper", "USER", true],
  ["24", "Trial Staff", "USER", true],
  ["25", "Developer", "USER", false],
  ["26", "Discord Management", "USER", false],
  ["27", "Server Management", "USER", false],
].map(([id, name, huly, dashboard]) => ({ id, name, huly, dashboard }));
export const config = {
  guildId: "1",
  accessRoles,
  ranks,
  office: {
    hostRoles: ["20", "21"],
    rooms: [{ id: "30", name: "All Hands", kind: "meeting" }],
  },
};
