import { createHash } from "node:crypto";

export function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256Hex(data: Uint8Array | string): string {
  return sha256(data).toString("hex");
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 && value.length > 0) {
    throw new Error("invalid base64");
  }
  return new Uint8Array(bytes);
}
