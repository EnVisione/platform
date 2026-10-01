# Drakora Staff

A React staff portal, Discord identity provider, and private Discord Office for Huly 0.7.426. The Dashboard role is required to sign in. The Todo role additionally grants Huly and Office access. Staff ranks determine Huly workspace permissions and appear as project roles.

The Office shows Discord presence, profile pictures, voice participants, and links to the configured voice channels. Meeting hosts can open a room and notify the Todo role in a private invitation channel. Ending a meeting locks new joins and updates the invitation. Existing voice participants remain connected.

## Requirements

- A working [Huly self-hosted installation](https://github.com/hcengineering/huly-selfhost), matching this checkout's Huly version.
- Docker Compose and a shared private Docker network.
- Two HTTPS origins routed through this service, preserving the original Host header and setting X-Forwarded-Proto to https.
- A Discord application with OAuth2 and a bot in the staff guild. Enable Server Members Intent and Presence Intent. Message Content Intent is unnecessary.
- Node.js 24 and pnpm 11.19.0 for local portal development.

## Install

1. Copy `.env.example` to a private `.env`. Set persistent data and configuration paths outside the checkout and the actual Huly Docker network name.
2. Copy `config.example.json` to that configuration path. Replace every placeholder. Generate independent random session and OIDC secrets. Generate the database key using `openssl rand -base64 32`. Use Huly's existing shared token secret, workspace UUID, and owner account UUID. Keep this file readable only by the service user.
3. Configure Discord's OAuth redirect as `https://staff.example.com/auth/discord/callback`. The requested scopes are `identify email guilds.members.read`. Only a verified Discord email may establish an identity.
4. Create the Office category and channels described in [the technical documentation](documentation.md). Add the IDs to the private configuration. Keep rank entries in highest to lowest priority order.
5. Create the data directory for container user 1000. Run `docker compose build staff` and `docker compose up -d staff` from this directory.
6. Add the supplied `huly-auth.compose.yml` to the Huly Compose files. Set its variables privately. The OIDC secret must match `oidcClientSecret`, and `STAFF_SOURCE_PATH` points to this directory on the host. The issuer wait script resolves the first startup dependency.
7. Build the Huly frontend image below, set `HULY_OFFICE_IMAGE`, and recreate Huly's front and account services.
8. Route both public origins to this service on port 3000 through the private network, or to its loopback port 8088. Keep Huly's nginx and account services inaccessible directly from the public internet.

The staff root redirects unauthenticated users to `/login`. Discord sign-in is denied without the Dashboard role. Huly is hidden unless the signed-in member also has the Todo role. `/huly` and `/todo` start the Huly sign-in handoff. `/office` opens the standalone Discord view. Huly's Office keeps its native floor layout with Discord room links and a member panel.

The Drakora Huly frontend hides the Chat and HR applications from workspace navigation. Staff communication stays in Discord. Existing Huly chat channels and meeting minutes remain stored; hiding the applications does not delete their records.

## Huly frontend image

From the platform repository root, using Node.js 20 through 24:

```sh
node common/scripts/install-run-rush.js install --to @hcengineering/prod
NODE_PATH="$PWD/dev/prod/node_modules" node common/scripts/install-run-rush.js package --to @hcengineering/prod --parallelism 6
docker build -f deploy/drakora-staff/Dockerfile.huly-front \
  --build-arg HULY_FRONT_IMAGE=your-existing-pinned-huly-front-image \
  -t drakora-huly-front:office .
```

Use the exact front image digest from the matching installation as the base. This image replaces browser assets while preserving the matching front server. Never mix platform tags and server versions. The optional `OFFICE_URL` browser configuration activates Discord controls in Huly's original Office layout; deployments without it retain Huly's original Office.

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
