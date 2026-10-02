module.exports = function staffAccountMethod({
  decodeToken,
  verifyServices,
  loginWithProvider,
}) {
  return async function ensureStaffAccount(ctx, db, branding, token, params) {
    verifyServices(["tool"], decodeToken(ctx, token).extra);
    if (
      !params ||
      typeof params.discordId !== "string" ||
      !/^\d{1,22}$/.test(params.discordId) ||
      typeof params.email !== "string" ||
      params.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.email) ||
      typeof params.name !== "string" ||
      !params.name.trim() ||
      params.name.length > 100 ||
      (params.expectedAccount !== undefined &&
        typeof params.expectedAccount !== "string")
    )
      throw new Error("Invalid staff identity");
    const email = params.email.trim().toLowerCase();
    const socialId = { type: "oidc", value: `discord:${params.discordId}` };
    const existing = await db.socialId.findOne(socialId);
    const emailIdentity = await db.socialId.findOne({
      type: "email",
      value: email,
    });
    const person = existing?.personUuid ?? emailIdentity?.personUuid;
    if (
      (params.expectedAccount && person !== params.expectedAccount) ||
      (existing &&
        emailIdentity &&
        existing.personUuid !== emailIdentity.personUuid)
    )
      throw new Error("Huly identity conflict");
    const result = await loginWithProvider(
      ctx,
      db,
      branding,
      email,
      params.name.trim(),
      "",
      socialId,
      false,
    );
    if (!result?.account) throw new Error("Huly account creation failed");
    return { account: result.account };
  };
};
