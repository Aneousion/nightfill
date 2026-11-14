import { randomUUID } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import { toHex } from "./codec.js";
import { codeMeasurement } from "./measure.js";
import { signDetached } from "./sodium.js";
import { ATTESTATION_WARNING, type Attestation } from "./types.js";

export async function buildAttestation(input: {
  boxPublicKey: Uint8Array;
  signPublicKey: Uint8Array;
  signSecretKey: Uint8Array;
  nonce?: string;
  now?: Date;
}): Promise<Attestation> {
  const measurement = codeMeasurement();
  const nonce = (input.nonce ?? randomUUID()).slice(0, 128);
  const unsigned = {
    kind: "nightfill.mock-attestation/v1" as const,
    warning: ATTESTATION_WARNING,
    simulatedEnvironment: "NEAR Shade Agent / NEAR AI confidential compute" as const,
    nonce,
    codeMeasurement: measurement.hex,
    measurementAlgorithm: "sha256" as const,
    measuredFiles: measurement.files,
    boxPublicKey: toHex(input.boxPublicKey),
    signPublicKey: toHex(input.signPublicKey),
    pair: "NEAR/USDC" as const,
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
  const signature = await signDetached(canonicalBytes(unsigned), input.signSecretKey);
  return { ...unsigned, signature: toHex(signature) };
}
