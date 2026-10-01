import { setTimeout } from "node:timers/promises";

const issuer = process.env.OPENID_ISSUER;
if (!issuer) throw new Error("OPENID_ISSUER is required");
console.log(
  "Waiting for the staff OpenID provider before starting Huly accounts.",
);
let ready = false;
for (let attempt = 0; attempt < 24; attempt++) {
  try {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok && (await response.json()).issuer === issuer) {
      ready = true;
      break;
    }
  } catch {}
  await setTimeout(5000);
}
if (!ready)
  throw new Error("Staff OpenID provider is unavailable; startup will retry.");
