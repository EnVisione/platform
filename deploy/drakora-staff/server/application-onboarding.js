import { randomUUID } from "node:crypto";
import { Routes } from "discord.js";
import { AuthError } from "./discord.js";
import { hash } from "./store.js";

const permanent = Number.MAX_SAFE_INTEGER;
const prefix = "application:onboard:";
const mentions = { parse: [], users: [], roles: [], replied_user: false };
const idPattern = /^[0-9a-f-]{36}$/;

export function applicationControls(config, record, event) {
  const buttons = [
    {
      type: 2,
      style: 5,
      label: "Click to view",
      url: `${config.staffOrigin}/applications/${record.id}`,
    },
  ];
  if (event === "approved" && record.discord && config.office) {
    if (config.roleSync)
      buttons.push({
        type: 2,
        style: 1,
        label: "Give role",
        custom_id: `${prefix}choose:${record.id}`,
      });
    buttons.push({
      type: 2,
      style: 2,
      label: "Invite to staff server",
      custom_id: `${prefix}invite:${record.id}`,
    });
  }
  return [{ type: 1, components: buttons }];
}

export function applicationOnboarding(
  config,
  store,
  office,
  policy,
  assignments,
) {
  const client = office.gateway;
  const selections = new Map();
  const locks = new Map();
  const tasks = new Set();
  let stopped = false;

  function approved(id) {
    const record = store.get("application", id);
    if (!record || record.erasingAt || record.status !== "Approved")
      throw new AuthError("accepted_application_required", 409);
    if (!/^\d{1,20}$/.test(record.discord?.id ?? ""))
      throw new AuthError("linked_discord_required", 409);
    return record;
  }
  function discordInviteAllowed(id) {
    const record = approved(id);
    if (record.notificationPreference === "email")
      throw new AuthError("email_updates_selected", 409);
    return record;
  }
  async function actor(interaction, roles = false) {
    if (interaction.guildId !== config.guildId)
      throw new AuthError("staff_server_required");
    const member = await office.staffMember(interaction.user.id);
    if (!member || member.pending || member.user?.bot)
      throw new AuthError("staff_membership_required");
    const user = policy.apply({
      id: interaction.user.id,
      name: member.nick || member.user?.global_name || member.user?.username,
      roles: member.roles,
    });
    if (
      !user.permissions.dashboard ||
      !user.capabilities["applications.approve"]
    )
      throw new AuthError("application_approval_required");
    if (roles) policy.authorize(user, "roles.assign");
    return user;
  }
  async function locked(id, action) {
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    locks.set(id, current);
    try {
      return await current;
    } finally {
      if (locks.get(id) === current) locks.delete(id);
    }
  }
  async function choose(interaction, id) {
    if (!assignments) throw new AuthError("role_sync_unavailable", 503);
    const user = await actor(interaction, true);
    const record = approved(id);
    const [metadata, page] = await Promise.all([
      assignments.metadata(user),
      assignments.list(user, record.discord.id),
    ]);
    const target = page.members.find(
      (member) => member.id === record.discord.id,
    );
    if (!target) throw new AuthError("discord_member_not_found", 404);
    const founder = policy.roles.some(
      (role) => role.name === "Founder" && user.roles.includes(role.id),
    );
    const options = policy.roles
      .filter((role) =>
        metadata.some((item) => item.id === role.id && item.assignable),
      )
      .filter((role) => founder || !["Founder", "Manager"].includes(role.name))
      .map((role) => ({
        label: role.name,
        value: role.id,
        description: role.specialist ? "Add specialist role" : "Set staff rank",
      }));
    options.push({
      label: "Dashboard access",
      value: config.accessRoles.dashboard,
      description: "Allow staff dashboard sign-in",
    });
    if (!options.length) throw new AuthError("role_sync_unavailable", 503);
    for (const [key, value] of selections)
      if (value.expiresAt <= Date.now() || value.actorId === user.id)
        selections.delete(key);
    if (selections.size >= 256) throw new AuthError("role_selection_busy", 503);
    const key = randomUUID();
    selections.set(key, {
      applicationId: id,
      actorId: user.id,
      target,
      options,
      expiresAt: Date.now() + 10 * 60000,
    });
    await interaction.editReply({
      content:
        "Choose a role for the accepted applicant. A staff rank replaces their current rank; specialist and Dashboard roles are added. Existing access is preserved.",
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `${prefix}role:${key}`,
              placeholder: "Choose a role to give",
              min_values: 1,
              max_values: 1,
              options,
            },
          ],
        },
      ],
      allowedMentions: mentions,
    });
  }
  async function giveRole(interaction, key) {
    const selection = selections.get(key);
    if (
      !selection ||
      selection.expiresAt <= Date.now() ||
      selection.actorId !== interaction.user.id
    )
      throw new AuthError("role_selection_expired", 409);
    const roleId =
      interaction.values?.length === 1 ? interaction.values[0] : null;
    const selected = selection.options.find((role) => role.value === roleId);
    if (!selected) throw new AuthError("invalid_role_assignment", 400);
    await locked(selection.applicationId, async () => {
      if (selections.get(key) !== selection)
        throw new AuthError("role_selection_expired", 409);
      const user = await actor(interaction, true);
      const record = approved(selection.applicationId);
      if (record.discord.id !== selection.target.id)
        throw new AuthError("role_selection_expired", 409);
      selections.delete(key);
      const { target } = selection;
      const result = await assignments.grant(
        user,
        target.id,
        target.version,
        roleId,
      );
      approved(selection.applicationId);
      const status = result.request?.status;
      const detail =
        status === "applied" &&
        Object.values(result.discord).every(
          (delivery) => delivery.status === "synced",
        )
          ? "Role saved and synced."
          : status === "waiting_member"
            ? "Role saved. It will sync when the applicant joins the staff server."
            : status === "waiting_screening"
              ? "Role saved. It will sync when the applicant completes server screening."
              : "Role saved; Discord synchronization is pending. Check Roles for its delivery status.";
      await interaction.editReply({
        content: `${selected.label}: ${detail}`,
        components: [],
        allowedMentions: mentions,
      });
    });
  }
  async function invite(interaction, id) {
    await locked(id, async () => {
      const user = await actor(interaction);
      const record = discordInviteAllowed(id);
      const key = `${id}:invite`;
      let receipt = store.get("application-onboarding", key);
      if (receipt?.sentAt && receipt.expiresAt > Date.now()) {
        await interaction.editReply({
          content:
            "The applicant already received a staff server invite by DM. It expires 24 hours after creation and can be used once.",
          components: [],
        });
        return;
      }
      if (!receipt || receipt.expiresAt <= Date.now()) {
        const channel = await client.rest.get(
          Routes.channel(config.applications.notificationChannelId),
        );
        if (channel.guild_id !== config.guildId)
          throw new AuthError("staff_invite_channel_required", 503);
        discordInviteAllowed(id);
        const invitation = await client.rest.post(
          Routes.channelInvites(channel.id),
          {
            body: {
              max_age: 86400,
              max_uses: 1,
              temporary: false,
              unique: true,
            },
            reason: "Invite accepted applicant to the Drakora staff server",
          },
        );
        if (
          !/^[A-Za-z0-9_-]{1,100}$/.test(invitation.code ?? "") ||
          invitation.guild?.id !== config.guildId
        )
          throw new AuthError("staff_invite_unavailable", 503);
        receipt = {
          code: invitation.code,
          generation: randomUUID(),
          createdAt: Date.now(),
          expiresAt: Date.now() + 86400000,
          actor: { id: user.id, name: user.name },
        };
        store.set("application-onboarding", key, receipt, permanent);
      }
      discordInviteAllowed(id);
      const dm = await client.rest.post(Routes.userChannels(), {
        body: { recipient_id: record.discord.id },
      });
      discordInviteAllowed(id);
      if (!/^\d{1,20}$/.test(dm.id ?? ""))
        throw new AuthError("staff_invite_unavailable", 503);
      const deliveryKey = `${id}:staff-invite:${receipt.generation}`;
      const message = await client.rest.post(Routes.channelMessages(dm.id), {
        body: {
          embeds: [
            {
              title: "Join the Drakora staff server",
              description:
                "Your staff application was accepted. Welcome to the team! Use the button below to join our private staff server. This invite expires after 24 hours and can be used once.",
              color: 0x22c55e,
              footer: { text: `Drakora · Reference ${id}` },
            },
          ],
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 5,
                  label: "Join staff server",
                  url: `https://discord.gg/${receipt.code}`,
                },
              ],
            },
          ],
          allowed_mentions: mentions,
          nonce: hash(deliveryKey).slice(0, 24),
          enforce_nonce: true,
        },
      });
      if (!/^\d{1,20}$/.test(message.id ?? ""))
        throw new AuthError("staff_invite_unavailable", 503);
      store.transaction(() => {
        store.set(
          "application-dm-delivery",
          deliveryKey,
          {
            messageId: message.id,
            channelId: dm.id,
            route: "discord",
            sentAt: Date.now(),
          },
          permanent,
        );
        store.set(
          "application-onboarding",
          key,
          { ...receipt, sentAt: Date.now() },
          permanent,
        );
      });
      policy.audit(user, "application-invite", {
        applicationId: id,
        memberId: record.discord.id,
      });
      await interaction.editReply({
        content: "Staff server invite sent to the applicant by DM.",
        components: [],
      });
    });
  }
  const errorMessage = (error) =>
    ({
      accepted_application_required:
        "This application is no longer accepted or is being removed.",
      linked_discord_required:
        "This applicant has no verified Discord account linked.",
      email_updates_selected:
        "This applicant chose email updates. Contact them by email, or ask them to enable Discord updates before sending a bot invite.",
      role_selection_expired:
        "This selection expired or was already used. Open Give role again.",
      discord_roles_changed:
        "The applicant's roles changed. Open Give role again before assigning.",
      discord_member_not_found:
        "The applicant must be in the main or staff server before you can give a role.",
      founder_role_required:
        "Only a Founder can change Founder or Manager assignments.",
      staff_invite_channel_required:
        "The application notification channel must be in the staff server.",
      role_sync_unavailable:
        "Role synchronization is unavailable. Check the Roles settings.",
      role_management_required:
        "You do not have permission to assign staff roles.",
      application_approval_required:
        "You do not have permission to onboard accepted applicants.",
      staff_membership_required: "Active staff server membership is required.",
      staff_server_required: "Use these controls in the staff server.",
      50007:
        "The invite could not be DMed. Ask the applicant to enable direct messages from Drakora, then try again.",
      50013:
        "The bot lacks Discord permissions for this action. Check its role and channel permissions.",
    })[error.code] ??
    "This action could not finish. Check the bot permissions and try again.";
  async function handle(interaction) {
    try {
      await interaction.deferReply({ flags: 64 });
      const [action, id] = interaction.customId.slice(prefix.length).split(":");
      if (!idPattern.test(id ?? ""))
        throw new AuthError("invalid_application", 400);
      if (action === "choose" && interaction.isButton())
        await choose(interaction, id);
      else if (action === "invite" && interaction.isButton())
        await invite(interaction, id);
      else if (action === "role" && interaction.isStringSelectMenu())
        await giveRole(interaction, id);
      else throw new AuthError("invalid_application", 400);
    } catch (error) {
      if (interaction.deferred || interaction.replied)
        await interaction.editReply({
          content: errorMessage(error),
          components: [],
          allowedMentions: mentions,
        });
    }
  }
  function listener(interaction) {
    if (stopped || !interaction.customId?.startsWith(prefix)) return;
    const task = handle(interaction).catch(() =>
      console.error(
        "Application onboarding interaction could not be completed.",
      ),
    );
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }
  client.on("interactionCreate", listener);
  return {
    async erase(record) {
      await locked(record.id, async () => {
        const invite = store.get(
          "application-onboarding",
          `${record.id}:invite`,
        );
        if (!invite?.code) return;
        try {
          await client.rest.delete(Routes.invite(invite.code));
        } catch (error) {
          if (error.code !== 10006 && error.status !== 404) throw error;
        }
      });
      for (const [key, selection] of selections)
        if (selection.applicationId === record.id) selections.delete(key);
    },
    async close() {
      stopped = true;
      client.off("interactionCreate", listener);
      await Promise.allSettled([...tasks]);
      selections.clear();
    },
  };
}
