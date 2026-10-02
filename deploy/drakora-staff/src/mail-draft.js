export function newDraft(from) {
  return {
    sendId: crypto.randomUUID(),
    composeKind: "new",
    from,
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
    quoteText: "",
    attachments: [],
  };
}

export function replyDraft(kind, original, identities, selectedIdentity = "") {
  const own = new Set(identities.map((entry) => entry.address.toLowerCase()));
  const external = (entries = []) => {
    const used = new Set();
    return entries.filter(({ address }) => {
      const key = address.toLowerCase();
      if (own.has(key) || used.has(key)) return false;
      used.add(key);
      return true;
    });
  };
  const recipients = external(original.replyTo);
  const to = recipients.length ? recipients : external(original.to);
  const used = new Set(to.map(({ address }) => address.toLowerCase()));
  const cc = external([...(original.to ?? []), ...(original.cc ?? [])]).filter(
    ({ address }) => !used.has(address.toLowerCase()),
  );
  const from = [...(original.to ?? []), ...(original.from ?? [])].find(
    ({ address }) => own.has(address.toLowerCase()),
  )?.address;
  const identity =
    identities.find(
      ({ address }) =>
        address.toLowerCase() === (from || selectedIdentity).toLowerCase(),
    ) ?? identities[0];
  const draft = newDraft(identity.address);
  const prefix = kind === "forward" ? "Fwd" : "Re";
  const subject = new RegExp(`^${prefix}:`, "i").test(original.subject)
    ? original.subject
    : `${prefix}: ${original.subject}`;
  const sender = (original.from ?? [])
    .map(({ name, address }) => (name ? `${name} <${address}>` : address))
    .join(", ");
  const date = original.date
    ? new Date(original.date).toLocaleString()
    : "an unknown date";
  return {
    ...draft,
    composeKind: kind,
    to: kind === "forward" ? "" : to.map(({ address }) => address).join(", "),
    cc: kind === "all" ? cc.map(({ address }) => address).join(", ") : "",
    replyAllCc: cc.map(({ address }) => address).join(", "),
    subject: subject.slice(0, 200),
    quoteText: `On ${date}, ${sender} wrote:\n${(original.replyText ?? "")
      .slice(0, 20000)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}`,
    reply: {
      kind: kind === "forward" ? "forward" : "reply",
      folder: original.folder,
      uid: original.uid,
      validity: original.validity,
    },
  };
}

export function draftPayload(draft) {
  const { composeKind, quoteText, replyAllCc, ...payload } = draft;
  return {
    ...payload,
    text: draft.text + (quoteText ? `\n\n${quoteText}` : ""),
  };
}
