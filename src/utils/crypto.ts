/**
 * Shared AES-256-CBC encrypt/decrypt helpers for Bluesky credentials.
 */
import crypto from "crypto";
import { env } from "../env.ts";

// Key must be 32 bytes for AES-256
const AES_KEY = Buffer.from(env.VINO_JP_CONFIG_BSKY_AES_KEY, "base64");
if (AES_KEY.length !== 32) {
    throw new Error(`VINO_JP_CONFIG_BSKY_AES_KEY must decode to exactly 32 bytes (got ${AES_KEY.length})`);
}

/** Encrypt a plaintext string with AES-256-CBC. Returns "iv:ciphertext" in base64. */
export function encrypt(text: string): string {
    const iv = crypto.randomBytes(16); // new IV every time
    const cipher = crypto.createCipheriv("aes-256-cbc", AES_KEY, iv);
    let encrypted = cipher.update(text, "utf8", "base64");
    encrypted += cipher.final("base64");
    // Store IV along with ciphertext
    return iv.toString("base64") + ":" + encrypted;
}

/** Decrypt a "iv:ciphertext" base64 string back to plaintext. */
export function decrypt(data: string): string {
    const parts = data.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error("Invalid encrypted data format — expected 'iv:ciphertext'");
    }
    const [ivBase64, encryptedData] = parts;
    const iv = Buffer.from(ivBase64!, "base64");
    const decipher = crypto.createDecipheriv("aes-256-cbc", AES_KEY, iv);
    let decrypted = decipher.update(encryptedData!, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}
