import { readFile } from "node:fs/promises";
import { canonicalBytes, canonicalJson } from "../core/canonical.js";
import { fromHex } from "../core/codec.js";
import { verifyProof, type ProofStep } from "../core/merkle.js";
import { verifyDetached } from "../core/sodium.js";
import type { Receipt } from "../core/types.js";

type Saved = {
  signPublicKey: string;
  receipts: Array<{
    name: string;
    receipt: Receipt;
    signature: string;
    merkleProof: ProofStep[];
    merkleRoot: string;
  }>;
};

const path = process.argv[2] ?? new URL("../../demo/last-run.json", import.meta.url).pathname;
const saved = JSON.parse(await readFile(path, "utf8")) as Saved;
let failed = 0;
for (const item of saved.receipts) {
  const signatureValid = await verifyDetached(
    canonicalBytes(item.receipt),
    fromHex(item.signature),
    fromHex(saved.signPublicKey),
  );
  const proofValid = verifyProof(
    canonicalJson(item.receipt),
    item.merkleProof,
    item.merkleRoot,
  );
  const ok = signatureValid && proofValid;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "ok" : "FAIL"}  ${item.name}  ${item.receipt.kind}  ${item.receipt.baseFilled} filled  ${item.receipt.baseRouted} routed`,
  );
}
if (failed > 0) {
  console.error(`${failed} receipt(s) failed verification`);
  process.exit(1);
}
console.log(`Verified ${saved.receipts.length} receipts against ${saved.signPublicKey}.`);
