import { AuthError } from "./discord.js";
import { evidenceLimits } from "../shared/application-form.js";

export function validateEvidenceImage(bytes, contentType, filename) {
  if (!Buffer.isBuffer(bytes) || !bytes.length)
    throw new AuthError("invalid_evidence_image", 400);
  if (bytes.length > evidenceLimits.maxImageBytes)
    throw new AuthError("evidence_image_too_large", 413);
  const png =
    bytes.length >= 33 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR";
  const jpeg =
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217;
  const webp =
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.readUInt32LE(4) + 8 === bytes.length &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  const type = png
    ? "image/png"
    : jpeg
      ? "image/jpeg"
      : webp
        ? "image/webp"
        : null;
  if (!type || type !== contentType)
    throw new AuthError("invalid_evidence_image", 400);
  const name =
    typeof filename === "string"
      ? filename
          .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
          .trim()
          .slice(0, 120)
      : "";
  return {
    name: name || `Evidence.${type.split("/")[1]}`,
    contentType: type,
    size: bytes.length,
  };
}

export function sendEvidenceImage(res, image) {
  res
    .set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    })
    .type(image.contentType)
    .send(Buffer.from(image.data, "base64"));
}
