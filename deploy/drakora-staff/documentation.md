# Staff portal and Discord Office

## Identity and access

The Express service provides Discord OAuth, an OpenID Connect issuer for Huly, and a reverse proxy that checks every Huly HTTP request and WebSocket upgrade. The React dashboard and Office use same-origin authenticated APIs.

The dashboard role grants dashboard access. The Todo role independently grants Huly and Office access. Rank roles never grant either access permission. Founder maps to Huly Owner, Admin to Maintainer, and the remaining configured ranks to User. Specialist ranks can appear only in Huly. A member with several ranks receives the highest configured permission level and all corresponding project role labels.

Discord IDs are the persistent identity. The verified Discord email allows Huly to link an existing account during OpenID sign-in. The original recovery owner remains an owner internally, while the public proxy still requires the Todo role. Preserve private recovery access separately.

Sessions last twelve hours and use Secure, HttpOnly, host-only cookies. A Huly session depends on its originating staff session. Signing out closes related live connections. A single-use, browser-bound handoff connects the two host sessions. Background requests receive an authentication error instead of restarting the login flow. Role checks refresh after sixty seconds, and open WebSockets are rechecked every thirty seconds. Meeting mutations force a fresh role check and require an origin match and session CSRF token.

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

The Office uses Guilds, Guild Members, Guild Presences, and Guild Voice States Gateway intents. The two privileged intents must be enabled in Discord's Developer Portal. The browser refreshes its view every five seconds. Invisible members appear offline. The roster includes all non-bot server members for authorized Todo users, with active staff highlighted separately. The service stores the latest observed online presence time in its encrypted database for ninety days. Last active starts when the service first observes a member online; Discord does not provide earlier history. Voice state remains in memory.

Huly's Office keeps its original floor and room layout. Matching room tiles open Discord voice channels when joining is allowed. The Discord control in the native Huly header opens staff presence, the searchable server roster, room occupancy, and meeting actions. The dashboard no longer includes a separate Office navigation item. Minecraft identities and game activity are reserved for the later proxy unification.

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

## Backups and recovery

Back up the private configuration, SQLite database, and `oidc-jwks.json` together using a consistent SQLite backup or a stopped service. The database key is required to recover encrypted records. Keep backups encrypted or access-restricted and outside Git. Back up Huly's databases and object storage using its deployment procedures as well; a source fork is not a data backup.

Retain the previous staff and Huly front image identifiers before deployment. To roll back, restore those images and their matching source and configuration. Restoring an older meeting database can disagree with current Discord permissions, so inspect and reconcile managed rooms before reopening Office access.

## Verification

`pnpm test` checks independent access roles, rank ordering, encrypted persistence, one-use handoffs, role revocation, background login behavior, meeting serialization and recovery, and avatar URL selection.

For a live installation, verify a user with each access combination, the Huly Office iframe, avatar rendering, and a real voice join. A host should start and end a test meeting with participants aware that the Todo role will be notified. Confirm the invitation opens the correct channel, regular Todo members cannot join before start or after end, and existing participants remain connected after end. Browser-only checks do not establish audio connectivity.
