import sodium from "libsodium-wrappers";

export type EngineKeys = {
  boxPublicKey: Uint8Array;
  boxSecretKey: Uint8Array;
  signPublicKey: Uint8Array;
  signSecretKey: Uint8Array;
};

let ready: Promise<typeof sodium> | null = null;

export function getSodium(): Promise<typeof sodium> {
  ready ??= sodium.ready.then(() => sodium);
  return ready;
}

export async function generateEngineKeys(): Promise<EngineKeys> {
  const s = await getSodium();
  const box = s.crypto_box_keypair();
  const sign = s.crypto_sign_keypair();
  return {
    boxPublicKey: box.publicKey,
    boxSecretKey: box.privateKey,
    signPublicKey: sign.publicKey,
    signSecretKey: sign.privateKey,
  };
}

export async function generateSignKeypair(): Promise<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}> {
  const s = await getSodium();
  const sign = s.crypto_sign_keypair();
  return { publicKey: sign.publicKey, secretKey: sign.privateKey };
}

export async function sealTo(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const s = await getSodium();
  return s.crypto_box_seal(message, recipientPublicKey);
}

export async function openSeal(
  ciphertext: Uint8Array,
  publicKey: Uint8Array,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  const s = await getSodium();
  try {
    return s.crypto_box_seal_open(ciphertext, publicKey, secretKey);
  } catch {
    throw new Error("sealed box could not be opened");
  }
}

export async function signDetached(
  message: Uint8Array,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  const s = await getSodium();
  return s.crypto_sign_detached(message, secretKey);
}

export async function verifyDetached(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const s = await getSodium();
  try {
    return s.crypto_sign_verify_detached(signature, message, publicKey);
  } catch {
    return false;
  }
}
