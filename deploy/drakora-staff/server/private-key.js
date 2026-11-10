import {
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  constants,
} from "node:fs";

export function readPrivateKey(path, label) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 16 ||
      stat.size > 257 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error();
    const key = readFileSync(descriptor, "utf8").trim();
    if (!/^[\x21-\x7e]{16,256}$/.test(key)) throw new Error();
    return key;
  } catch {
    throw new Error(`Mount a private service-owned ${label}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
