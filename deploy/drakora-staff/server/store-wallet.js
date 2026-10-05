import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "./store.js";

const failure = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });
const token = () => randomBytes(32).toString("base64url");
const forever = Number.MAX_SAFE_INTEGER;
const cardLimit = 20;
export const validStoreUsername = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value);
const cardCode = (value) => {
  const code =
    typeof value === "string" ? value.trim().replaceAll(" ", "") : "";
  if (!/^[A-Za-z0-9-]{6,64}$/.test(code)) throw failure("invalid_gift_card");
  return code;
};
const publicCard = ({
  id,
  code,
  username,
  remaining,
  currency,
  checkedAt,
}) => ({
  id,
  suffix: code.slice(-4),
  username,
  remaining,
  currency,
  checkedAt,
});

export function storeWalletService(store, lookup, now = Date.now) {
  const ownedCards = (session) => {
    if (!session.storeIdentity) return session.storeCards ?? [];
    return (store.get("store-wallet", session.storeIdentity.id)?.cards ?? [])
      .map((key) => store.get("store-gift-card", key))
      .filter((card) => card?.owner === session.storeIdentity.id);
  };
  const checkOwner = (code, session) => {
    const card = store.get("store-gift-card", hash(code));
    if (card && card.owner !== session.storeIdentity?.id)
      throw failure("gift_card_already_saved", 409);
    return card;
  };
  function saveCard(session, card) {
    checkOwner(card.code, session);
    const cards = ownedCards(session);
    const existing = cards.find((entry) => entry.code === card.code);
    if (!existing && cards.length >= cardLimit)
      throw failure("gift_card_limit", 409);
    card.id = existing?.id ?? card.id;
    if (session.storeIdentity) {
      const key = hash(card.code),
        owner = session.storeIdentity.id;
      const keys = store.get("store-wallet", owner)?.cards ?? [];
      store.set("store-gift-card", key, { ...card, owner }, forever);
      store.set(
        "store-wallet",
        owner,
        { cards: [...new Set([...keys, key])] },
        forever,
      );
    } else {
      session.storeCards = [
        ...cards.filter((entry) => entry.code !== card.code),
        card,
      ];
    }
  }
  return {
    snapshot(session) {
      return {
        identity: session.storeIdentity ?? null,
        cards: ownedCards(session).map(publicCard),
      };
    },
    async register(session, input) {
      if (!validStoreUsername(input?.username))
        throw failure("minecraft_login_required", 401);
      const code = cardCode(input.code);
      checkOwner(code, session);
      const balance = await lookup({ code });
      checkOwner(code, session);
      if (balance.remaining > 0) {
        store.transaction(() =>
          saveCard(session, {
            id: randomUUID(),
            code,
            username: input.username,
            ...balance,
            checkedAt: now(),
          }),
        );
      }
      return {
        ...balance,
        saved: Boolean(session.storeIdentity) && balance.remaining > 0,
        ...this.snapshot(session),
      };
    },
    async refresh(session, id) {
      const card = ownedCards(session).find((entry) => entry.id === id);
      if (!card) throw failure("gift_card_not_found", 404);
      const balance = await lookup({ code: card.code });
      if (!ownedCards(session).some((entry) => entry.id === id))
        throw failure("gift_card_not_found", 404);
      store.transaction(() =>
        saveCard(session, { ...card, ...balance, checkedAt: now() }),
      );
      return this.snapshot(session);
    },
    forget(session, id) {
      const card = ownedCards(session).find((entry) => entry.id === id);
      if (!card) throw failure("gift_card_not_found", 404);
      if (session.storeIdentity) {
        store.transaction(() => {
          checkOwner(card.code, session);
          const owner = session.storeIdentity.id;
          const keys = store.get("store-wallet", owner)?.cards ?? [];
          store.delete("store-gift-card", hash(card.code));
          const remaining = keys.filter((key) => key !== hash(card.code));
          if (remaining.length)
            store.set("store-wallet", owner, { cards: remaining }, forever);
          else store.delete("store-wallet", owner);
        });
      } else
        session.storeCards = ownedCards(session).filter(
          (entry) => entry.id !== id,
        );
      return this.snapshot(session);
    },
    checkoutCode(session, id, username) {
      if (!id) return undefined;
      const card = ownedCards(session).find((entry) => entry.id === id);
      if (
        !card ||
        (!session.storeIdentity &&
          card.username.toLowerCase() !== username?.toLowerCase())
      )
        throw failure("gift_card_not_found", 404);
      checkOwner(card.code, session);
      return card.code;
    },
    link(session, identity) {
      if (!/^[0-9]{17,20}$/.test(identity?.id))
        throw failure("invalid_login_state");
      const drafts = session.storeCards ?? [];
      const linked = {
        ...session,
        storeIdentity: {
          id: identity.id,
          name: String(identity.name).slice(0, 80),
        },
      };
      store.transaction(() => {
        for (const card of drafts) saveCard(linked, card);
      });
      session.storeIdentity = linked.storeIdentity;
      delete session.storeCards;
    },
    challenge(sessionId, origin) {
      const value = token();
      store.set(
        "store-challenge",
        hash(value),
        { session: hash(sessionId), origin, until: now() + 600000 },
        now() + 600000,
      );
      return value;
    },
    challengeGet(value) {
      const pending =
        typeof value === "string"
          ? store.get("store-challenge", hash(value))
          : undefined;
      return pending?.until > now() ? pending : undefined;
    },
    handoff(value, identity) {
      const pending = this.challengeGet(value);
      if (!pending || !/^[0-9]{17,20}$/.test(identity?.id))
        throw failure("invalid_login_state");
      store.delete("store-challenge", hash(value));
      const handoff = token();
      store.set(
        "store-handoff",
        hash(handoff),
        {
          ...pending,
          until: now() + 60000,
          identity: { id: identity.id, name: identity.name },
        },
        now() + 60000,
      );
      return `${pending.origin}/store/auth/consume?handoff=${handoff}`;
    },
    consume(value, sessionId, origin) {
      const pending =
        typeof value === "string"
          ? store.get("store-handoff", hash(value))
          : undefined;
      if (
        !pending ||
        pending.until <= now() ||
        pending.session !== hash(sessionId) ||
        pending.origin !== origin
      )
        throw failure("invalid_handoff");
      store.delete("store-handoff", hash(value));
      return pending.identity;
    },
  };
}
