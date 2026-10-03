export const ruleSections = [
  { id: "home", name: "Home" },
  { id: "prom2", name: "Prom2" },
  { id: "restless-horizons", name: "Restless Horizons" },
  { id: "discord", name: "Discord" },
];

export const applicationSections = [
  { id: "role", name: "What being staff means" },
  { id: "qualities", name: "What we look for", list: true },
  { id: "beforeApplying", name: "Before you apply", list: true },
  { id: "answers", name: "Write in your own words" },
  { id: "note", name: "Part of the community" },
];

export function newServer() {
  return {
    slug: "",
    name: "",
    summary: "",
    description: "",
    address: "play.drakora.org",
    pack: "",
    packVersion: "",
    minecraftVersion: "",
    downloadUrl: "",
    worlds: "",
    joining:
      "Add play.drakora.org to your multiplayer server list, then choose your world in the lobby.",
    rules: "home",
    artwork: "castle",
    published: false,
  };
}

export function newAnnouncement() {
  return {
    id: crypto.randomUUID(),
    title: "",
    body: "",
    date: "",
    published: false,
  };
}

export const initialWebsite = {
  home: {
    title: "Welcome to Drakora",
    introduction:
      "Modded Minecraft, shared adventures and a place to call home.",
    announcementsTitle: "Announcements",
    emptyMessage:
      "Community news and events will appear here. Join Discord for the latest updates.",
    announcements: [],
  },
  apply: {
    title: "Staff applications",
    introduction:
      "Want to help Drakora grow? We are looking for people who enjoy helping players, building together and keeping our community welcoming.",
    role: "Staff help players find their feet, keep conversations respectful and handle problems fairly. Builders, artists and developers also help shape our worlds and community.\n\nThese are volunteer roles. We value the time and care you give, but they are not paid positions. You do not need to know everything before applying; patience, honesty and a willingness to learn matter.",
    qualities:
      "Community spirit: help make Drakora welcoming for everyone.\nCalm communication: explain things clearly and stay respectful when a situation is difficult.\nFair judgment: listen to both sides and avoid favoritism.\nReliability: communicate your availability and follow through on what you take on.\nWillingness to learn: ask questions, accept feedback and work with the team.",
    beforeApplying:
      "Use your real Minecraft username and accurate contact details.\nBe honest about your experience, availability and moderation history.\nExplain why you want to help Drakora and the role you are interested in.\nGive thoughtful answers and examples rather than one-word responses.\nYou must be 18 or older to apply.\nApplying does not guarantee acceptance.",
    answers:
      "Your answers should reflect your own experience and judgment. Help with spelling or grammar is fine, but do not submit answers written for you. Take the time to explain what you think and how you would approach a situation.",
    note: "Staff are part of the community. Be helpful, patient and easy to work with. After you submit, the team will review your application and contact you through the details you provide. You can return to the form in this browser to check your application.",
  },
  rules: {
    home: "Harassment, bullying and discrimination are strictly prohibited.\n\nDo not post explicit or inflammatory media. Hateful or explicit profiles, usernames and skins are forbidden.\n\nKeep public chats in English so staff can moderate. Other languages are welcome in private messages. Contact staff if you need help with a translator.\n\nDo not spam, use excessive caps, beg for items or bring excessive negativity into chat. Advertising is prohibited.\n\nDo not impersonate staff or other players. Evading bans, warnings or mutes is strictly forbidden.\n\nStaff decisions are final. Do not argue about staff decisions in public. Open a Discord support ticket to discuss staff actions, appeal or report an issue. Do not DM staff about issues without direct permission.",
    prom2:
      "The universal rules apply in every world.\n\nBoosting is forbidden. Do not ask for items you have not progressed far enough to reach yourself. Do not give new players mid, late or end game items.\n\nHacked or cracked clients and exploitation of glitches, bugs or loopholes are strictly forbidden.\n\nPvP is enabled and requires the other player's direct consent. Random killing is forbidden.\n\nGriefing is forbidden. Do not cause lag or crash servers. Setups causing lag will be removed by staff.\n\nDo not claim progression structures. All players must be able to access structures necessary for progression.",
    "restless-horizons":
      "The universal rules apply in every world.\n\nBoosting is forbidden. Do not ask for items you have not progressed far enough to reach yourself. Do not give new players mid, late or end game items.\n\nHacked or cracked clients and exploitation of glitches, bugs or loopholes are strictly forbidden.\n\nPvP is enabled and requires the other player's direct consent. Random killing is forbidden.\n\nGriefing is forbidden. Do not cause lag or crash servers. Setups causing lag will be removed by staff.\n\nDo not claim progression structures. All players must be able to access structures necessary for progression.",
    discord:
      "The universal rules apply throughout our Discord.\n\nAll content must follow Discord's Terms of Service.\n\nVoice chats must follow the community rules.\n\nKeep content relevant to each channel's topic.\n\nFor support or appeals, open a ticket in the Discord rather than sending staff a private message.",
  },
  servers: [
    {
      ...newServer(),
      slug: "prom2",
      name: "Prominence II",
      pack: "Prominence II",
      summary: "A modded RPG adventure, shared with the Drakora community.",
      description:
        "Explore, build and progress together in Prominence II. Choose a world and make it your home. Our Discord is the place for pack updates, community events and help from staff.",
      worlds: "Luna, Terra, Sol",
      rules: "prom2",
      published: true,
    },
    {
      ...newServer(),
      slug: "restless-horizons",
      name: "Restless Horizons",
      pack: "Restless Horizons",
      summary: "A new horizon for builders, explorers and friends.",
      description:
        "Find your next adventure in Restless Horizons. Join other Drakora players, build together and settle into a shared world. Check Discord for pack updates, community events and support.",
      worlds: "Eclipse, Void",
      rules: "restless-horizons",
      artwork: "forest",
      published: true,
    },
  ],
};
