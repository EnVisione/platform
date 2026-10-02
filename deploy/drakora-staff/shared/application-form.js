export const applicationRoles = {
  community: {
    label: "Community Staff",
    description:
      "Support players, moderate fairly, and help keep Drakora welcoming.",
    questions: [
      [
        "moderation",
        "How would you approach moderation?",
        "Describe how you would apply rules fairly, handle disagreements, and know when to involve another staff member.",
      ],
      [
        "playerSupport",
        "How do you help a player when you do not know the answer?",
        "Explain how you would investigate a modpack or server problem without guessing or promising a fix you cannot deliver.",
      ],
      [
        "boundaries",
        "How would you handle staff permissions and confidentiality?",
        "Tell us how you would separate playing from staff work, protect private information, and avoid using permissions for personal benefit.",
      ],
    ],
  },
  builder: {
    label: "Builder",
    description: "Create hubs, event spaces, and builds that fit the network.",
    questions: [
      [
        "portfolio",
        "Show us your building work",
        "Share portfolio links, screenshots, or videos. Explain which parts you made yourself and whether anyone else contributed.",
      ],
      [
        "buildingStyle",
        "What do you enjoy building?",
        "Describe your strongest styles, your experience with interiors, terrain, and larger projects, and a style you would like to improve.",
      ],
      [
        "buildingTools",
        "Which building tools can you use confidently?",
        "Tell us about WorldEdit, VoxelSniper, schematics, or other tools. How do you prevent accidental changes to existing worlds?",
      ],
      [
        "buildingProject",
        "Walk us through a build you are proud of",
        "Explain the brief, scale, time spent, challenges, and how you handled feedback or collaboration.",
      ],
    ],
  },
  artist: {
    label: "Artist",
    description:
      "Create artwork, textures, graphics, and visual assets for Drakora.",
    questions: [
      [
        "portfolio",
        "Show us your artwork",
        "Share portfolio links or examples. Identify your own contribution, references, and any third-party or generated elements.",
      ],
      [
        "artMediums",
        "What kinds of artwork can you create?",
        "Tell us about pixel art, textures, illustration, UI, logos, animation, or other work, and which tools you use.",
      ],
      [
        "artProcess",
        "How do you turn a brief into a finished asset?",
        "Describe your process, typical turnaround, file formats, revisions, and how you keep assets readable at small sizes.",
      ],
      [
        "artRights",
        "How do you handle ownership and permitted use?",
        "Explain how you check references, fonts, and other assets, and what staff would be allowed to do with work you contribute.",
      ],
    ],
  },
  developer: {
    label: "Developer",
    description:
      "Build and maintain mods, plugins, services, and network tools.",
    questions: [
      [
        "portfolio",
        "Show us your development work",
        "Share repositories, releases, or a project description. State what you wrote yourself. If your work is private, describe what evidence you could share privately.",
      ],
      [
        "developerStack",
        "What can you work with confidently?",
        "List your languages and relevant experience with Minecraft mods, plugins, proxies, databases, websites, or Discord integrations.",
      ],
      [
        "developerDebugging",
        "Describe a difficult bug you solved",
        "Explain how you reproduced it, found the cause, checked the fix, and avoided breaking existing behavior.",
      ],
      [
        "developerSafety",
        "How would you make a safe change to a live network?",
        "Tell us about testing, backups, deployments, credentials, permission checks, and recovering when a change goes wrong.",
      ],
      [
        "developerTeamwork",
        "How do you work with other developers?",
        "Describe your approach to version control, code review, documentation, feedback, and maintaining code after release.",
      ],
    ],
  },
};

export const communityOptions = [
  ["prom2", "Prominence II"],
  ["rh", "Restless Horizons"],
  ["discord", "Discord community"],
];

export const experienceQuestions = {
  prom2: [
    "prom2Experience",
    "Prominence II experience",
    "How long have you played the modpack? Which mods and quests do you know well? How far have you progressed on Drakora, and what still feels unfamiliar?",
  ],
  rh: [
    "rhExperience",
    "Restless Horizons experience",
    "Tell us how long you have played, which systems you know well, and how far you have progressed on Drakora. What would you still need to learn?",
  ],
  discord: [
    "discordExperience",
    "Discord community experience",
    "How do you take part in Drakora's Discord? Tell us about the conversations, support, or events you join and how you help other members.",
  ],
};

export const commonQuestions = [
  [
    "previousStaff",
    "Previous staff experience",
    "Tell us about any previous staff or community responsibilities, your role, and what you learned. If this would be your first role, say so.",
  ],
  [
    "experienceProof",
    "Evidence or references",
    "Optional. Share public links or explain how we could confirm your previous role or identity. Do not include passwords, private messages, or personal documents.",
  ],
  [
    "motivation",
    "Why would you like to join this team?",
    "What would you contribute in the role you chose? Describe a practical way you could help Drakora and what you hope to learn.",
  ],
  [
    "about",
    "Tell us about yourself",
    "What are your strengths and areas to improve? What games, interests, or hobbies do you enjoy outside Drakora?",
  ],
  [
    "availability",
    "When could you usually help?",
    "Describe your typical days and times in your selected timezone, commitments that affect availability, and how you would communicate an absence.",
  ],
];

export function questionList(role, communities = []) {
  return [
    [
      "drakoraExperience",
      "Drakora experience",
      "How long have you been playing on Drakora? Tell us about your time on the network.",
    ],
    ...communities.map((key) => experienceQuestions[key]).filter(Boolean),
    ...(applicationRoles[role]?.questions ?? []),
    ...commonQuestions,
    [
      "scenarioAnswer",
      "Your scenario response",
      "Explain what you would do, why, and when you would ask for help.",
    ],
    [
      "comments",
      "Comments",
      "Optional. Is there anything else you would like us to know?",
    ],
  ];
}
