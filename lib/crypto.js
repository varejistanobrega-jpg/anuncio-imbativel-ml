import crypto from "crypto";

function getEncryptionKey() {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;

  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY inválida");
  }

  return Buffer.from(keyHex, "hex");
}

export function encryptToken(token) {
  if (!token || typeof token !== "string") {
    throw new Error("Token inválido para criptografia");
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64")
  ].join(":");
}

export function decryptToken(envelope) {
  if (!envelope || typeof envelope !== "string") {
    throw new Error("Token criptografado inválido");
  }

  const parts = envelope.split(":");

  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Formato de token criptografado inválido");
  }

  const [, ivBase64, authTagBase64, encryptedBase64] = parts;

  const key = getEncryptionKey();
  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");
  const encrypted = Buffer.from(encryptedBase64, "base64");

  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error("Token criptografado corrompido");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}
