import { formatDecimal } from "../core/money.js";
import { NightfillEngine, loadOrCreateKeys } from "../core/engine.js";
import { requestIntentsQuote } from "../intents/quote.js";
import { anchorOnTestnet } from "../near/anchor.js";
import { referenceOrFallback } from "../oracle.js";
import { startHttp } from "./http.js";

const port = Number(process.env.NIGHTFILL_PORT ?? 8788);
const batchMs = Number(process.env.NIGHTFILL_BATCH_MS ?? 20_000);
const keys = await loadOrCreateKeys(new URL("../../.data/engine-keys.json", import.meta.url).pathname);
const reference = await referenceOrFallback();
const engine = await NightfillEngine.create({
  keys,
  referencePrice: reference.price,
  referenceSource: reference.source,
  quoter: requestIntentsQuote,
  anchor: anchorOnTestnet,
});

const http = await startHttp(engine, port);
console.log(`nightfill engine  ${http.url}`);
console.log(`pair              NEAR/USDC`);
console.log(`reference         ${formatDecimal(reference.price)} USDC  ${reference.source}`);
console.log(`seal key          ${engine.boxPublicKeyHex}`);
console.log(`receipt key       ${engine.signPublicKeyHex}`);
console.log("attestation       MOCK — not a hardware TEE quote");

setInterval(() => {
  void engine.runBatch().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "batch failed";
    console.error(`batch error: ${message}`);
  });
}, batchMs);

setInterval(() => {
  void referenceOrFallback().then((next) => {
    engine.setReference(next.price, next.source);
  });
}, 60_000);
