# Staff portal and Discord Office

## Identity and access

The Express service provides Discord OAuth, an OpenID Connect issuer for Huly, and a reverse proxy that checks every Huly HTTP request and WebSocket upgrade. The React dashboard and Office use same-origin authenticated APIs.

The Dashboard role is required for Discord sign-in and all staff sessions. The Todo role additionally grants Huly and Office access. Without Todo, Huly is absent from the dashboard. Rank roles never grant either access permission. Founder maps to Huly Owner, Manager and Admin to Maintainer, and the remaining configured ranks to User. Specialist ranks can appear only in Huly. A member with several ranks receives the highest configured permission level and all corresponding project role labels.

The Huly Contacts Role column also shows all configured Discord ranks for employees linked to a staff account. The staff gateway resolves those rank names from the connected Discord bot roster and the stored Discord to Huly account link. The browser refreshes the badges every fifteen seconds while Contacts is open. Huly's generic HR Worker badge is hidden only in this staff deployment; the HR mixin remains on the contact. A disconnected bot clears rank badges instead of showing stale assignments. Employee and GitHub badges remain unchanged.

The first dashboard or Huly visit after Discord login requires a Minecraft Java Edition username. Existing staff see a welcome-back prompt. The name is stored under the stable Discord ID in the encrypted database, is case-insensitively unique among current links and pending change requests, and is marked `pending` for later in-game verification. Staff may continue immediately while it is pending. A member cannot directly overwrite a submitted name. They can request a change in Settings; only a current Dashboard member with the Founder or Manager role can approve or reject it. An approved name remains pending verification. Founder, Manager, and Admin can view registered accounts, linked names, pending requests, current configured Discord staff ranks, and last observed Discord activity in Accounts. Ranks are unavailable while the Discord Office connection is down. This view does not expose OAuth tokens or Huly account secrets. Minecraft server last-login activity and ownership verification are deferred until the server integration is available.

The dashboard Settings page requires the same Dashboard role as Overview. Its accent preference accepts 3 or 6 digit hex colors, normalizes them to 6 digits, and stores them under the Discord account ID in that browser's local storage. It changes dashboard controls and accents only; the sign-in screen, Huly, and Office keep their own appearance. Reset removes the saved preference. No preference is sent to the server or synchronized between browsers. Minecraft name links and change requests are stored on the server instead.

Discord IDs are the persistent identity. The verified Discord email allows Huly to link an existing account during OpenID sign-in. A valid, email-bound workspace invitation also permits Huly account creation when public signup is disabled. The original recovery owner remains an owner internally, while the public proxy still requires both Dashboard and Todo roles. Preserve private recovery access separately.

Sessions last twelve hours and use Secure, HttpOnly, host-only cookies. A Huly session depends on its originating staff session. Signing out closes related live connections. A single-use, browser-bound handoff connects the two host sessions. Background requests receive an authentication error instead of restarting the login flow. Role checks refresh after sixty seconds, and open WebSockets are rechecked every thirty seconds. Losing Dashboard blocks an existing session at its next role check. Meeting mutations force a fresh role check and require an origin match and session CSRF token.

The staff proxy adds `STAFF_SSO_URL` to Huly's browser configuration and hides Huly's local login and signup controls. A Huly login page reached without a valid app session returns to the existing staff session and runs the OpenID handoff. A 30 second browser guard prevents repeated redirects if the handoff fails; the OpenID provider button remains available to retry. The gateway still checks Dashboard and Todo roles before exposing Huly.

The proxy also sets `STAFF_DASHBOARD_URL` to the staff portal origin. In this deployment, clicking the top-left Huly logo returns to the staff dashboard. The profile menu still offers Select Workspace. Without that configuration, the logo retains Huly's normal workspace menu.

Discord profiles sync during authenticated activity. Guild avatars take precedence over global avatars, with Discord's default picture as a fallback. Huly stores an external avatar URL and loads it from Discord's CDN. A changed picture updates after the next role refresh; a browser refresh may be needed to replace an already-rendered Huly profile.

## Discord channels

Create one private Staff Office category containing:

| Channel | Type | Default state |
| --- | --- | --- |
| All Hands | Voice, meeting | Locked |
| Meeting Room 1 | Voice, meeting | Locked |
| Meeting Room 2 | Voice, meeting | Locked |
| Voice Room 1 | Voice | Open |
| Voice Room 2 | Voice | Open |
| meeting-invites | Text | Visible to Todo members |

Deny View Channel and Connect to everyone. Allow View Channel, Connect, and Speak to the Todo role on the category and casual voice rooms. Meeting rooms override the Todo role's Connect permission to deny until started. Discord administrators retain their platform-level permission bypass. Avoid other role or member overrides that independently grant access to meeting rooms.

The bot needs View Channel, Manage Channels, Manage Roles for channel permission overwrites, Connect, Speak, Send Messages, Embed Links, Read Message History, and permission to mention the Todo role. Limit its permissions to this category where practical. The bot must be able to edit the configured role's overwrites. The service validates channel types and category membership before mutations.

The Office uses Guilds, Guild Members, Guild Presences, Guild Voice States, and Guild Messages Gateway intents. The two privileged intents must be enabled in Discord's Developer Portal. Message Content Intent is unnecessary. The browser refreshes its view every five seconds. Invisible members appear offline. The roster includes all non-bot staff server members for authorized Todo users, with active staff highlighted separately. Voice state remains in memory.

Last active combines observed online presence and message creation timestamps from the staff guild and optional `activityGuildIds`, with at most two distinct guilds in total. Only current staff guild members contribute records. Direct messages, bots, webhooks, system messages, and other guilds are excluded. Message bodies are not inspected or retained, and the gateway disables its message cache. Timestamps are kept in the encrypted staff database for ninety days. A message updates the exact timestamp even within the presence write interval; older events cannot rewind newer activity.

After connection and resume, a background refresh reads the latest 100 messages per readable channel and active thread in the configured guilds. It requires View Channel and Read Message History. Inaccessible channels are skipped without blocking Office. This bounded refresh is not a complete Discord history import and does not scan archived threads. Only the latest activity timestamp survives the scan. Live message events continue updating activity without relying on visible presence. Shutdown waits for the refresh before closing the database.

Huly's Office keeps its original floor and room layout. Clicking a room tile opens Huly's native room view. The Discord control in the Huly header opens staff presence, the searchable server roster, room occupancy, voice links, and Discord meeting actions. Discord room status remains visible on matching tiles. Huly's native audio and video connection requires a separately configured Love service and LiveKit endpoint; opening a room does not start or unlock a Discord meeting. The dashboard no longer includes a separate Office navigation item. Minecraft game activity is reserved for the later proxy unification.

The Drakora Huly frontend excludes the current Chat application, the legacy Chunter application, and HR from workspace navigation. Their models and existing records stay intact, including previously created meeting minutes. This is a navigation change, not a data migration.

## Meeting lifecycle

Only configured meeting host roles with Todo access can start or end a meeting. A start first persists an operation record, unlocks the room, then sends one private invitation mentioning only the Todo role. The invitation's button opens the voice channel in Discord. The UI asks the host to confirm before sending.

Operations on each room are serialized. Repeated starts while live return the existing meeting and do not send another invitation. Failed invitations trigger an attempt to relock the room. An unsuccessful close remains recoverable and blocks another start. Ending a meeting locks new joins and edits the existing invitation without another notification. It never disconnects voice participants.

Meeting state is persisted in the encrypted database. After restart, live meetings remain open; incomplete operations are reconciled to closed. Initialization retries are bounded. If Discord cannot be reached or permissions no longer match, the UI shows unavailable controls. Restart the service after correcting persistent configuration or permission errors.

An ambiguous Discord send timeout can leave an invitation whose delivery was not acknowledged. The room is relocked when possible; inspect the invitation channel after such an error. Do not infer that a message was never delivered from a failed HTTP response.

## Configuration and services

`server/discord.js` owns OAuth token refresh and access checks. `server/huly.js`, `profile.js`, and `project-roles.js` reconcile Huly workspace membership, pictures, and the default tracker project's named roles. `office.js` owns the Gateway connection and Discord operations; `meetings.js` owns durable meeting transitions. `store.js` encrypts records with AES-256-GCM in SQLite.

The Huly account endpoint defaults in the example to `http://account:3000`; the upstream proxy points to `http://nginx:80`. Profile and project reconciliation use `http://transactor:3333` on the shared private Docker network. The tracker project ID is `tracker:project:DefaultProject`.

Keep the public domains exclusively behind the staff proxy. An independently public Huly origin would bypass the Discord role gate. The proxy expects a trusted TLS terminator and is bound to loopback on the host. If using Cloudflare Tunnel, point both hostnames at `http://staff:3000` on the shared network and retain normal TLS protection. Keep tunnel credentials outside the checkout.

The optional Office configuration includes the category, invitation channel, allowed host role IDs, and an ordered list of meeting or casual voice rooms. Removing it disables the integration server. Build the matching Huly frontend before exposing the Office configuration to clients.

## Discord to-do forums and Tracker

Create a Huly Tracker project for each Discord forum to-do list. Set `todoForums` in the private staff configuration to distinct `{ "channelId": "...", "projectId": "..." }` pairs. The bot must be able to view the forum and its posts. Add a URL property named `Discord post` to Huly's Issue type; the service uses that property and a stable Discord thread ID to prevent duplicate imports. It imports current and public archived forum posts and polls every five minutes. A changed Discord title or workflow tag updates the corresponding Tracker issue. Other Huly edits remain intact until that source value changes. There is no reverse sync, and comments, attachments, assignees, and non-workflow forum tags are not copied.

The forum tag `In Progress` maps to Huly In Progress, `Complete` to Completed, and `Vetoed/Not Possible` to Impossible / Void. `Awaiting Verification` maps to the same-named status when present. A post without a workflow tag starts Pending. Use Huly statuses for progress and Huly labels for pack, server, and issue classification. The current labels cover Prom2, Luna, Terra, Sol, RestLess Horizons (RH), Eclipse, Void, EU Proxy, NA Proxy, Hub, Bug, Glitch, Exploit, and PRIORITY. Huly's own issue changes do not change Discord forum tags.

## Backups and recovery

Back up the private configuration, SQLite database, and `oidc-jwks.json` together using a consistent SQLite backup or a stopped service. The database key is required to recover encrypted records. Keep backups encrypted or access-restricted and outside Git. Back up Huly's databases and object storage using its deployment procedures as well; a source fork is not a data backup.

Retain the previous staff and Huly front image identifiers before deployment. To roll back, restore those images and their matching source and configuration. Restoring an older meeting database can disagree with current Discord permissions, so inspect and reconcile managed rooms before reopening Office access.

## Verification

`pnpm test` checks independent access roles, rank ordering, encrypted persistence, one-use handoffs, role revocation, background login behavior, meeting serialization and recovery, avatar URL selection, and forum issue import and reconciliation.

For a live installation, verify a user with each access combination, the Huly Office iframe, avatar rendering, and a real voice join. A host should start and end a test meeting with participants aware that the Todo role will be notified. Confirm the invitation opens the correct channel, regular Todo members cannot join before start or after end, and existing participants remain connected after end. Browser-only checks do not establish audio connectivity.

## Application storage and delivery

Application sign-out removes the draft's linked Discord identity and confirmation and persists a marker requiring fresh Discord authorization on reconnection. The application OAuth challenge carries that preference, so an existing staff session cannot silently reconnect the account just disconnected. The marker clears after a successful new connection. Draft answers, staff sessions, and Huly sessions are preserved.

When configured, applications use a separate encrypted SQLite store mounted at `/applications`. Records include the submitted answers, questionnaire version, assigned scenario, contact email, optional Discord identity snapshot, and an unverified Minecraft name and resolved profile UUID. Roles used to determine available application types are read from Discord identity responses, never accepted from the form. No Discord bio or applicant OAuth access token is retained. Future network activity fields remain empty until a server integration supplies evidence.

Registered staff who connect Discord receive their Minecraft name from the panel registry under their verified Discord ID. The form requires confirmation of that exact name. Selecting an incorrect name directs them to panel Settings for a change request. A pending change blocks submission until Founder or Manager approval or rejection. An approved name change invalidates the previous confirmation. The server rejects attempts to substitute another name and rechecks the linked name after profile lookup before committing the application. Ordinary applicants without an active staff rank and registered link still enter their name manually.

Public mutations require the public origin and a session-bound CSRF token. Public sessions use a separate host-only Secure, HttpOnly, SameSite Lax cookie. Discord identity handoffs expire, are consumed once, and are bound to the browser session that started the application. Using the optional public sign-in never grants dashboard access or replaces an existing staff session. Form bodies and request rates are bounded. Only the application route and its assets are exposed on the public host.

Evidence is optional. `answers.experienceLinks` holds up to five newline-separated HTTP or HTTPS links, without embedded credentials. Links are validated before submission and are never fetched by the service. Required-question metadata is shared between server validation and the form's red asterisks, with screen-reader labels identifying required fields.

Portfolio and evidence questions provide an Imgur upload shortcut in a separate tab. Applicants host screenshots there and paste image or album links into the application. The service stores the submitted text and URLs only; it never fetches linked images, accepts image uploads, or stores image bytes in the database. The former public and staff image endpoints are unavailable. Evidence links appear on the applicant's final review and the private staff application detail. Discord notifications do not include evidence links.

Applicants who answer that they do not use Discord receive a final required Yes/No question about downloading Discord for staff communication if approved. Both answers allow submission and appear in the private staff view. Connected Discord users and applicants who already use Discord skip this question. Earlier questionnaire versions display that the question was not asked, rather than inferring an answer.

Submission writes the application, list summary, staff notification, applicant confirmation when Discord is linked, and receipt atomically. Repeating submission from the same draft returns its existing reference without scheduling duplicate messages. `server/application-notifications.js` owns the durable encrypted outbox. It retains compatibility with existing staff notification jobs. Temporary delivery failures retry with backoff up to eight attempts; Discord's reported rate limit delays are respected. Other HTTP client errors stop that message without retrying. A failed delivery does not lose the application. Every notification disables user, role, and automatic mentions, even when the display text includes a Discord user mention. Discord's deterministic nonce reduces duplicate messages within Discord's recent-message uniqueness window; it does not guarantee indefinite exactly-once delivery after an uncertain network result.

Only the verified Discord account linked at submission can receive applicant DMs. The worker opens a DM using the bot and sends immutable event messages for Received, Reviewing, Approved, and Denied. Messages for one application wait until earlier queued status messages have completed or failed. They include the role and reference, but never private staff feedback or questionnaire answers. Approval and denial messages include the staff's applicant-facing message; denials also include the reapplication date. Private application detail responses include DM delivery states and timestamps. Discord privacy settings and API restrictions may prevent delivery; staff can use the stored contact email instead. No automated email sender is configured. Existing applications do not receive retroactive submission confirmations, but a new review or decision schedules the corresponding update.

The staff list is paginated. Every list and detail request rechecks the authenticated Discord permissions and requires the Dashboard role plus Jr Moderator, Moderator, Sr Moderator, Admin, Manager, or Founder. Staff sessions retain the existing one-minute role refresh interval. Viewing an application does not change its status. Notices link to `/applications/{id}`, and sign-in preserves that destination.

Jr Moderator and higher may add private feedback. Feedback has a server-authenticated author and timestamp and is limited to 100 entries per application, with 3 to 4,000 characters each. Only Managers and Founders with Dashboard access may start review, approve, or deny. `POST /api/applications/{id}/review` changes Received to Reviewing and records the initiating reviewer and time. Repeating it while Reviewing preserves the original review and does not enqueue another DM. Viewing an application does not start review. `POST /api/applications/{id}/decision` accepts `decision`, `reason`, and, for denial, `reapplyDays`. Received and Reviewing can become Approved or Denied; final decisions cannot be overwritten. Reasons are limited to 2,000 characters and required for denial. Status, summary, cooldown, and applicant notification update in one transaction. Feedback, review, and decision mutations force a fresh Discord role check, match the staff origin, and require the session CSRF token. Decisions do not grant Discord roles.

A denial sets a minimum wait of seven days, with an optional whole-day value up to 365. The deadline is calculated from server time and stored as `decision.reapplyAfter`; a later denial cannot shorten an existing wait. Cooldowns apply only to the denied role and expire at their deadline. The server checks them both before profile lookup and inside the final submission transaction, so a concurrent denial also blocks a new submission. A new browser draft or service restart does not reset the deadline. Known cooldowns appear in the public role selection. Cooldown keys match the verified Discord ID and the normalized contact email plus Minecraft name pair. Because Discord is optional and anonymous email and Minecraft ownership are not verified, anonymous matching cannot prevent someone from claiming entirely different identity details. There is no automatic cooldown backfill for earlier denials.

Back up `applications.sqlite` with a consistent SQLite backup or while the service is stopped. Retain the independent encryption key separately in protected configuration; losing it makes existing records unreadable. Copying a live SQLite main file without its WAL can omit recent records. Draft and temporary handoff records expire automatically, but application records are retained. Account deletion, retention policy changes, automatic Discord role assignment, and Minecraft verification require separate product changes.
