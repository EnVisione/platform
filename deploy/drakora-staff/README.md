# Drakora Staff

A React staff portal, Discord identity provider, and private Discord Office for Huly 0.7.426. The Dashboard role is required to sign in. The Todo role additionally grants Huly and Office access. Staff ranks determine Huly workspace permissions and appear as project roles.

The Office shows Discord presence, profile pictures, voice participants, and links to the configured voice channels. Meeting hosts can open a room and notify the Todo role in a private invitation channel. Ending a meeting locks new joins and updates the invitation. Existing voice participants remain connected.

The dashboard places the Drakora logo beside the staff name in its sidebar heading, with the same branding above navigation on mobile. There is no separate Discord server rail.

Last active combines observed presence with message timestamps, including messages sent while invisible. Set `activityGuildIds` to the community guild ID to include its messages; the staff guild is always included. Only current staff guild members contribute activity records. The bot must be present and able to view the relevant channels. Read Message History permits a bounded refresh of the latest 100 messages in each readable channel and active thread after connection. Older and inaccessible history may be missing. Only the latest activity timestamp is retained, never message contents.

Huly Contacts shows the configured Discord staff ranks for linked employees. The rank badges refresh while Contacts is open. The generic Huly Worker badge is hidden in this deployment; its underlying HR data remains intact.

## Requirements

- A working [Huly self-hosted installation](https://github.com/hcengineering/huly-selfhost), matching this checkout's Huly version.
- Docker Compose and a shared private Docker network.
- Two HTTPS origins routed through this service, preserving the original Host header and setting X-Forwarded-Proto to https.
- A Discord application with OAuth2 and a bot in the staff guild and any community guild configured for activity. Enable Server Members Intent and Presence Intent. Message Content Intent is unnecessary.
- Node.js 24 and pnpm 11.19.0 for local portal development.

## Install

1. Copy `.env.example` to a private `.env`. Set persistent data and configuration paths outside the checkout and the actual Huly Docker network name.
2. Copy `config.example.json` to that configuration path. Replace every placeholder. Generate independent random session and OIDC secrets. Generate the database key using `openssl rand -base64 32`. Use Huly's existing shared token secret, workspace UUID, and owner account UUID. Keep this file readable only by the service user.
3. Configure Discord's OAuth redirect as `https://staff.example.com/auth/discord/callback`. The requested scopes are `identify email guilds.members.read`. Only a verified Discord email may establish an identity.
4. Create the Office category and channels described in [the technical documentation](documentation.md). Add the IDs to the private configuration. Keep rank entries in highest to lowest priority order.
5. Create the data directory for container user 1000. Run `docker compose build staff` and `docker compose up -d staff` from this directory.
6. Add the supplied `huly-auth.compose.yml` to the Huly Compose files. Set its variables privately. The OIDC secret must match `oidcClientSecret`, and `STAFF_SOURCE_PATH` points to this directory on the host. The issuer wait script resolves the first startup dependency.
7. Build the Huly frontend and account images below, set `HULY_OFFICE_IMAGE` and `HULY_ACCOUNT_IMAGE`, and recreate Huly's front and account services.
8. Route both public origins to this service on port 3000 through the private network, or to its loopback port 8088. Keep Huly's nginx and account services inaccessible directly from the public internet.

The staff root redirects unauthenticated users to `/login`. Discord sign-in is denied without the Dashboard role. Huly is hidden unless the signed-in member also has the Todo role. `/huly` and `/todo` start the Huly sign-in handoff. If Huly loses its browser session, its login page restarts the same handoff automatically. The public Huly view hides local email and password login. `/office` opens the standalone Discord view. Huly's Office keeps its native floor layout and room clicks, with Discord room links and a member panel available separately.

After Discord sign-in, new and existing staff must submit a Minecraft Java Edition username before using the dashboard or Huly. Names are 3–16 letters, numbers, or underscores and cannot be claimed by another staff account, regardless of case. A submitted name is marked awaiting in-game verification, but staff may continue immediately. Verification and Minecraft server last-login activity require the later server integration. Staff may request a correction in Settings; only a Founder or Manager can approve a name change. Founder, Manager, and Admin can view registered accounts, current configured Discord staff ranks, and observed Discord activity on the Accounts page. Ranks are unavailable while the Discord Office connection is down. The activity record starts when the staff bot first sees a member online, retains observations for ninety days, and cannot reveal invisible presence or past history.

The configured community staff ranks, from highest to lowest, are Founder, Manager, Admin, Sr Moderator, Moderator, Jr Moderator, and Helper. Trial Staff is no longer configured. Manager uses the same Huly Maintainer permission level as Admin; the other new moderation ranks use User. Dashboard and Todo access still require their independent access roles.

The optional `roleSync` configuration mirrors mapped ranks between Drakora Staff and the main Drakora server. Promotions, demotions, and rank removals work in either direction. On the first sync, staff-server ranks resolve conflicting assignments; a member ranked in only one server keeps that rank. If the member has not joined the other server, the assignment waits in encrypted storage and applies when they join and finish membership screening. The bot needs Manage Roles and must be above the ranks it copies in both servers. An inaccessible rank remains pending without blocking other members and retries after permissions change. Unmapped roles, including Dashboard and Todo access, are preserved. See [rank synchronization](documentation.md#discord-staff-rank-synchronization) for configuration and recovery behavior.

Signed-in staff can open Dashboard Settings to choose a 3 or 6 digit hex accent color. Save applies it to the dashboard and keeps it across refreshes for that Discord account in the same browser. Reset restores the default Discord blue. This appearance setting stays in browser storage and does not sync across devices.

The Drakora Huly frontend hides the Chat and HR applications from workspace navigation. Staff communication stays in Discord. Existing Huly chat channels and meeting minutes remain stored; hiding the applications does not delete their records.

The optional `todoForums` configuration links Discord forum to-do lists to Huly Tracker projects. Give each entry a forum channel ID and its destination project ID. The service imports active and public archived posts, then checks for new posts, title changes, and workflow tags every five minutes. Each issue has a `Discord post` link back to its source. Create that URL property on Huly's Issue type and the workflow statuses listed in [the technical documentation](documentation.md) before enabling the mapping. Huly edits to an imported issue remain in place until the corresponding Discord title or workflow tag changes. The link is one-way; it does not post Huly changes to Discord or copy comments and attachments.

## Staff applications

The connected Discord account on the introduction screen includes a **Not you? Sign out** button. It disconnects that account from the application while preserving the draft. Reconnecting opens Discord authorization rather than automatically reusing a signed-in dashboard account. Dashboard and Huly sessions are unaffected.

Required questions and fields have a red asterisk. Portfolio and evidence questions link to Imgur for screenshot hosting. Applicants paste the image, album, portfolio, or other public reference links into their answers. Evidence or references remains optional and also accepts up to five public HTTP or HTTPS links in a separate field. Image uploads are unavailable, and the service does not download or store linked screenshots. Authorized reviewers can open evidence links from the private submission.

The optional `applications` configuration serves a public form at the separate `publicOrigin` under `/apply`. Route that hostname to this service while preserving Host and HTTPS forwarding. Its root redirects to `/apply`; staff APIs and Huly are unavailable on the public hostname. Existing staff and Huly hostnames retain their authentication requirements.

Applicants first enter a preferred name and can optionally connect Discord before choosing Community Staff, Builder, Artist, or Developer. Discord can be connected before entering a name, but a preferred name is always required to continue. Registered staff who connect Discord confirm the Minecraft name already linked in their panel. If it is incorrect, they must request a correction in panel Settings and wait for Founder or Manager approval. A pending correction blocks application submission, and an approved name change requires fresh confirmation. Other applicants enter a Minecraft Java Edition username. Applicants then answer questions for their role and selected Drakora communities. Discord sign-in uses the existing staff OAuth callback. It confirms only identity and does not create a staff account or require membership in the staff guild. Applicants without a verified Discord email must provide a contact email. Discord bios are not collected. Current community staff can apply for specialist roles they do not hold. Specialist staff can apply for Community Staff and other specialist roles they do not hold. Applicants with neither see all four options.

Applicants must confirm that they are 18 or older and consent to private application storage. Community Staff receives one randomly selected question from twenty scenarios; specialist roles receive a scenario relevant to their work. The assigned scenario stays with the draft. Drafts expire after seven days and remain associated with that browser's secure session. Submitted applications are retained until removed by the operator. Minecraft lookup and head previews confirm a public profile only, never account ownership. Server history and in-game verification are not connected yet.

Set `STAFF_APPLICATIONS_DATA_PATH` to a private persistent directory owned by container user 1000. The application SQLite database uses an independent random `applications.databaseKey`. Keep both the database and key backed up privately. Do not commit application data or private configuration. See [the technical documentation](documentation.md) for delivery and access boundaries.

Applicants who do not use Discord receive a final required Yes/No question about downloading it for staff communication if approved. Either answer allows submission and is shown to staff. Applicants who already use or connect Discord skip this question.

Application notices go to `applications.notificationChannelId` with all mentions disabled. They contain the preferred name, role, optional Discord mention, and a link to the private application. Configure the channel as read-only for members and allow the bot to view, send messages, embed links, and read history. Jr Moderator, Moderator, Sr Moderator, Admin, Manager, and Founder members with the Dashboard role can read the Staff Applications list and individual submissions and leave private feedback. Each application supports up to 100 feedback entries of 4,000 characters. Applications do not synchronize to Huly.

Only Managers and Founders can start reviewing, approve, or deny applications. Starting review records the reviewer and time and changes the list status to Reviewing. Decisions are final, record the reviewer and time, and do not automatically grant Discord roles. A denial uses a generic message when no custom message is provided and accepts a waiting period from 0 to 365 whole days, with seven days selected by default. Zero adds no waiting period. That wait applies only to the denied application type and is enforced when submitting, including from a new draft. Known waiting periods appear beside application types. Feedback, review, and decisions recheck Discord roles when saved.

Applicants who link Discord choose Discord updates or opt out and provide a contact email. DMs confirm submission and announce review, approval, or denial with teal, blue, green, and red accents, personal greetings, the applicant's avatar when available, and clear next steps. A denial includes the complete staff message and earliest reapplication date. With `applications.fallback` configured, blocked DMs use one private text channel per applicant in the main Drakora server. The applicant must be a member of that server. Only the applicant, configured reviewer roles, the bot, and Discord administrators can access it. Channels allow replies and remain open until the operator removes them. Failed delivery never loses an application.

Email choices require an explicit address, including for applicants whose Discord account has a verified email. With `applications.smtp` configured, submission confirmations and review, approval, and denial updates are sent through Proton Bridge. Emails include a personal greeting, colored status, staff decision message, and reapplication date when denied. Email choices do not send applicant DMs or create fallback channels. Without SMTP configuration, the encrypted email outbox remains available for later delivery and staff can follow up manually. The staff view and receipt distinguish queued mail, acceptance by the email service, and failed delivery. Acceptance does not guarantee arrival in the recipient's inbox. The receipt is bound to the submitting browser session for seven days and lets applicants change future notification preferences. Already delivered messages remain in place.

### Proton Bridge email delivery

Run a signed-in Proton Bridge on the same host as the staff container. Use its generated SMTP password, rather than the Proton account password. Install `proton-bridge-smtp.socket` and `proton-bridge-smtp.service` in the host user's systemd unit directory and enable the socket with `systemctl --user enable --now proton-bridge-smtp.socket`. The supplied service expects `protonmail-bridge.service`, `/usr/lib/systemd/systemd-socket-proxyd`, and Bridge's loopback SMTP port 1025. Adjust those deployment paths when needed. The socket directory is private to that user; its numeric UID must match the container user 1000. Keep user services running after logout with the host's normal linger configuration.

Set `STAFF_MAIL_SOCKET_PATH` to that user's `.local/share/drakora-mail` directory. The container mounts it at `/run/mail`. In private configuration, set `applications.smtp` with `socketPath` set to `/run/mail/smtp.sock`, Bridge `user` and `password`, the enabled sender `from`, optional `replyTo`, and `ca` containing Bridge's PEM certificate. STARTTLS and certificate verification are required. The supplied Bridge connection verifies the certificate for 127.0.0.1. Never expose Bridge's ports publicly or disable certificate verification. Update the trusted certificate if Bridge regenerates it. Sender addresses must already exist in the signed-in Proton account. See [Proton's Bridge CLI guide](https://proton.me/support/bridge-cli-guide) for connection settings.

The notification channel also receives blue review, green acceptance, and red denial updates identifying the acting Manager or Founder and applicant. Denials include the reason and the date and time remaining before that application type can be submitted again. Each update links to the application and reports the applicant's delivery route, failure, or queued update at posting time. Mentions stay silent, private feedback stays in the panel, and existing statuses are not backfilled.

The receipt also lists your current and previous applications with submission dates and colored review statuses. Refresh updates reloads the list. History matches the connected Discord account or applications submitted without Discord in the same browser session. Contact email and Minecraft name alone cannot retrieve another applicant's history. The list uses pages of twenty applications and does not include private staff feedback.

The staff review side panel lists the applicant's other stored applications, with application type, Minecraft name, submission date, colored current status, and a link to each review. It excludes the application being viewed and uses pages of five. Linked submissions match the same Discord account. If either submission has no Discord account, both the contact email and Minecraft name must match. These anonymous matches are claimed identities, not proof of ownership. This staff history remains private to authorized reviewers and does not expand public receipt access.

## Huly frontend image

From the platform repository root, using Node.js 20 through 24:

```sh
node common/scripts/install-run-rush.js install --to @hcengineering/prod
NODE_PATH="$PWD/dev/prod/node_modules" node common/scripts/install-run-rush.js package --to @hcengineering/prod --parallelism 6
docker build -f deploy/drakora-staff/Dockerfile.huly-front \
  --build-arg HULY_FRONT_IMAGE=your-existing-pinned-huly-front-image \
  -t drakora-huly-front:office .
```

Use the exact front image digest from the matching installation as the base. This image replaces browser assets while preserving the matching front server. Never mix platform tags and server versions. The optional `OFFICE_URL` browser configuration activates Discord controls in Huly's original Office layout; deployments without it retain Huly's original Office. Room tiles still open Huly's room view. Huly audio and video calls require a separately configured Love service and LiveKit endpoint; Discord voice links remain independent.

## Huly account image

Build the account overlay from the exact pinned account image digest used by the matching installation:

```sh
docker build -f deploy/drakora-staff/Dockerfile.huly-account \
  --build-arg HULY_ACCOUNT_IMAGE=your-existing-pinned-huly-account-image \
  -t drakora-huly-account:sso-invites deploy/drakora-staff
```

Set `HULY_ACCOUNT_IMAGE=drakora-huly-account:sso-invites` in the private Huly environment. The overlay permits an OpenID user with a valid workspace invitation to create an account while `DISABLE_SIGNUP=true`; a direct OpenID sign-in without an invitation still cannot create an account. The build fails if the pinned image no longer contains the expected account handler. Rebuild and review the overlay when changing the base image digest.

## GitHub integration

Register a private GitHub App for this Huly installation, using the callback and webhook URLs from the [Huly self-hosted GitHub instructions](https://github.com/hcengineering/huly-selfhost#github-service). Install the app only on repositories intended for this workspace. Keep the app private key, client secret, and webhook secret outside this checkout.

Add `huly-github.compose.yml` to the Huly Compose files. Set `HULY_GITHUB_IMAGE` to a pinned image matching the platform version, and set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and `TODO_COLLABORATOR_URL` in the private Huly environment. Add the supplied `/_github` proxy location to the live Huly nginx configuration. The staff gateway accepts only GitHub's signed webhook endpoint without a Discord session; Huly verifies the webhook signature. Other GitHub integration calls remain behind Todo access.

In Huly, open Integrations, connect your GitHub identity, install the app for the selected repositories, and map each repository to the intended Huly project. Mapping can create and synchronize issues and comments, so select the project deliberately. The GitHub service supports the same Huly 0.7.426 version as this source checkout.

## Development

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
CONFIG_PATH=/private/config.json DATA_PATH=/private/data pnpm start
```

Use disposable test configuration and data. Tests use synthetic identities and an in-memory database, and do not send Discord messages. Production secrets, sessions, member data, databases, and deployment-specific configuration are intentionally absent from this source tree.

See [documentation.md](documentation.md) for permissions, state recovery, security boundaries, and backup procedures. The platform's [license](../../LICENSE) applies to this fork.

## Self-host deployment templates

`huly-production.compose.yml`, `huly-images.compose.yml`, and `huly.nginx.conf` preserve the deployment customizations as templates. They target self-host commit `ca3808a57c83518b971343df7d073753f38796ed` with Huly 0.7.426. Copy the nginx template privately and replace its example hostname.

Set `HULY_NGINX_CONFIG`, `TODO_ORIGIN`, and `HULY_TUNNEL_TOKEN_PATH` in the private Huly environment, along with the base self-host configuration. Generate the MinIO and database credentials privately. Set `HTTP_BIND=127.0.0.1` and keep the persistent volume paths outside the checkout. Use the production override before the image pins, and the auth override last so the custom front image takes precedence:

```sh
docker compose --env-file /private/huly.conf \
  -f compose.yml \
  -f /source/deploy/drakora-staff/huly-production.compose.yml \
  -f /source/deploy/drakora-staff/huly-images.compose.yml \
  -f /source/deploy/drakora-staff/huly-auth.compose.yml up -d
```

The tunnel override assumes a private Cloudflare Tunnel token file. Configure both public hostnames to target the staff service. If using a different TLS proxy, omit the cloudflared service and configure that proxy instead.

The Staff Applications list searches preferred names, Minecraft usernames, or Discord IDs and filters by Community Staff, Builder, Artist, or Developer and by Received, In review, Approved, or Denied. Enter a name and press Search or Enter to find matching applications across all pages. Name searches ignore capitalization and surrounding spaces. Filters combine and remain in the page URL when opening an application and returning to the list. Reset filters clears the search and both selections. Denied applications remain stored and available to authorized reviewers.

Managers and Founders can open **Edit application questions** from Staff Applications. Each of the four forms has its own description, questions, order, required answers, community conditions, and scenario prompts. Questions support paragraphs, short answers, and single choice answers. Save each form before switching teams. Identity fields, the 18+ requirement, weekly hours, consent, and the required scenario response remain protected. Saved changes apply to new drafts; existing drafts and submitted applications retain their original questions and answers.
