export const applicationStatuses = {
  Received: "Received",
  Reviewing: "In review",
  Approved: "Approved",
  Denied: "Denied",
};

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
        "Upload screenshots to Imgur and paste the image or album link here. You can also share portfolio or video links. Explain which parts you made yourself and whether anyone else contributed.",
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
        "Upload examples to Imgur and paste the image or album link here, or share your portfolio link. Identify your own contribution, references, and any third-party or generated elements.",
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
    "Optional. Upload screenshots to Imgur and share their links, add other public references, or explain how we could confirm your previous role or identity. Do not include passwords, private messages, or personal documents.",
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

const optionalQuestions = new Set(["experienceProof", "comments"]);
export const requiredApplicationQuestion = (key) => !optionalQuestions.has(key);

export const evidenceLimits = {
  maxLinks: 5,
};

export function parseEvidenceLinks(value = "") {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > evidenceLimits.maxLinks)
    return { links: [], error: "Add up to 5 public links, one per line." };
  const links = [];
  for (const line of lines) {
    try {
      const url = new URL(line);
      if (
        line.length > 2048 ||
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
      links.push(url.href);
    } catch {
      return {
        links: [],
        error:
          "Use a complete http or https link on each line, without login details.",
      };
    }
  }
  return { links, error: null };
}

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

export const formLimits = { questions: 40, scenarios: 40, options: 12 };

export function defaultApplicationForm(role, scenarios) {
  return {
    description: applicationRoles[role].description,
    questions: questionList(
      role,
      communityOptions.map(([key]) => key),
    ).map(([key, title, help]) => ({
      key,
      title,
      help,
      kind: "paragraph",
      required: requiredApplicationQuestion(key),
      minLength:
        key === "scenarioAnswer"
          ? 40
          : requiredApplicationQuestion(key)
            ? 20
            : 1,
      condition:
        Object.entries(experienceQuestions).find(
          ([, question]) => question[0] === key,
        )?.[0] ?? "always",
      options: [],
    })),
    scenarios: [...scenarios],
  };
}

export function activeFormQuestions(form, communities = []) {
  return form.questions.filter(
    (question) =>
      question.condition === "always" ||
      communities.includes(question.condition),
  );
}

export function questionAnswerError(question, value) {
  const answer = typeof value === "string" ? value.trim() : "";
  if (!answer && !question.required) return null;
  if (question.kind === "choice")
    return question.options.includes(answer)
      ? null
      : "Choose one of the available answers.";
  if (answer.length < question.minLength)
    return `Please give at least ${question.minLength} characters.`;
  if (
    answer.length >
    (question.key === "scenarioAnswer"
      ? 6000
      : question.kind === "short"
        ? 300
        : 4000)
  )
    return "Your answer is too long.";
  return null;
}

export const applicationBaseFields = [
  "displayName",
  "ign",
  "minecraftConfirmed",
  "minecraftConfirmedName",
  "discordUses",
  "discordWhy",
  "discordWilling",
  "contactEmail",
  "notificationPreference",
  "pronouns",
  "age",
  "timezone",
  "communities",
  "hoursPerWeek",
  "adultConfirmed",
  "discordConfirmed",
  "privacyConsent",
  "accuracyConfirmed",
  "experienceLinks",
];
