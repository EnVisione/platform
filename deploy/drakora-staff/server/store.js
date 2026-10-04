import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import session from "express-session";

export const hash = (value) => createHash("sha256").update(value).digest("hex");

export function openStore(path, encryptionKey) {
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS records (
    kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
    expires INTEGER NOT NULL, PRIMARY KEY (kind,id)
  ); CREATE INDEX IF NOT EXISTS records_expiry ON records(expires);`);
  const key = Buffer.from(encryptionKey, "base64");
  if (key.length !== 32) throw new Error("Invalid database encryption key");
  const seal = (data) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(data)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  };
  const open = (value) => {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  };
  const put = db.prepare(
    "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,expires=excluded.expires",
  );
  const select = db.prepare(
    "SELECT value,expires FROM records WHERE kind=? AND id=? AND expires>?",
  );
  const remove = db.prepare("DELETE FROM records WHERE kind=? AND id=?");
  const store = {
    kinds() {
      return db
        .prepare("SELECT DISTINCT kind FROM records")
        .all()
        .map((row) => row.kind);
    },
    get(kind, id) {
      const row = select.get(kind, id, Date.now());
      return row ? open(row.value) : undefined;
    },
    set(kind, id, data, expires = Date.now() + 43200000) {
      put.run(kind, id, seal(data), expires);
    },
    delete(kind, id) {
      remove.run(kind, id);
    },
    take(kind, id) {
      const row = this.get(kind, id);
      this.delete(kind, id);
      return row;
    },
    entries(kind) {
      return db
        .prepare("SELECT id,value FROM records WHERE kind=? AND expires>?")
        .all(kind, Date.now())
        .map((row) => [row.id, open(row.value)]);
    },
    clean() {
      db.prepare("DELETE FROM records WHERE expires<=?").run(Date.now());
    },
    transaction(action) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = action();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    page(kind, limit = 50, offset = 0, matches) {
      if (matches) {
        let total = 0;
        const items = [];
        const rows = db.prepare(
          "SELECT value FROM records WHERE kind=? AND expires>? ORDER BY id DESC",
        );
        for (const row of rows.iterate(kind, Date.now())) {
          const value = open(row.value);
          if (!matches(value)) continue;
          if (total >= offset && items.length < limit) items.push(value);
          total++;
        }
        return { items, total };
      }
      const total = db
        .prepare(
          "SELECT count(*) AS total FROM records WHERE kind=? AND expires>?",
        )
        .get(kind, Date.now()).total;
      const items = db
        .prepare(
          "SELECT value FROM records WHERE kind=? AND expires>? ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(kind, Date.now(), limit, offset)
        .map((row) => open(row.value));
      return { items, total };
    },
    close() {
      db.close();
    },
  };
  class Sessions extends session.Store {
    get(id, callback) {
      try {
        callback(null, store.get("session", id));
      } catch (error) {
        callback(error);
      }
    }
    set(id, value, callback) {
      try {
        store.set("session", id, value, Date.parse(value.cookie.expires));
        callback?.();
      } catch (error) {
        callback?.(error);
      }
    }
    destroy(id, callback) {
      store.delete("session", id);
      callback?.();
    }
    touch(id, value, callback) {
      this.set(id, value, callback);
    }
  }
  class OidcAdapter {
    constructor(name) {
      this.kind = `oidc:${name}`;
    }
    async upsert(id, payload, expiresIn) {
      store.set(
        this.kind,
        id,
        payload,
        Date.now() + (expiresIn ?? 43200) * 1000,
      );
    }
    async find(id) {
      return store.get(this.kind, id);
    }
    async findByUid(uid) {
      return store
        .entries(this.kind)
        .find(([, value]) => value.uid === uid)?.[1];
    }
    async findByUserCode(code) {
      return store
        .entries(this.kind)
        .find(([, value]) => value.userCode === code)?.[1];
    }
    async destroy(id) {
      store.delete(this.kind, id);
    }
    async consume(id) {
      const payload = await this.find(id);
      if (payload)
        await this.upsert(
          id,
          { ...payload, consumed: Math.floor(Date.now() / 1000) },
          Math.max(1, payload.exp - Date.now() / 1000),
        );
    }
    async revokeByGrantId(grantId) {
      for (const [id, payload] of store.entries(this.kind))
        if (payload.grantId === grantId) store.delete(this.kind, id);
    }
  }
  return { store, sessions: new Sessions(), OidcAdapter };
}
