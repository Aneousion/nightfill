import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NightfillEngine } from "../core/engine.js";
import { requestIntentsQuote } from "../intents/quote.js";
import { anchorOnTestnet } from "../near/anchor.js";
import { referenceOrFallback } from "../oracle.js";
import { runScenario } from "./scenario.js";

const reference = await referenceOrFallback();
const engine = await NightfillEngine.create({
  referencePrice: reference.price,
  referenceSource: reference.source,
  quoter: requestIntentsQuote,
  anchor: anchorOnTestnet,
});

try {
  const result = await runScenario(engine);
  for (const line of result.lines) console.log(line);
  const ada = result.views.Ada.receipts.at(-1);
  if (!ada) throw new Error("Ada has no receipt");
  const tampered = { ...ada.receipt, baseFilled: `${ada.receipt.baseFilled}9` };
  const broken = await engine.verifyReceipt({ ...ada, receipt: tampered });
  if (broken.signatureValid) throw new Error("tampered receipt should not verify");
  console.log("Tampered Ada's fill size. Signature check failed, as it should.");

  const output = {
    signPublicKey: engine.signPublicKeyHex,
    boxPublicKey: engine.boxPublicKeyHex,
    reference: engine.reference,
    batch: result.batch,
    lines: result.lines,
    receipts: Object.entries(result.views).map(([name, view]) => ({
      name,
      ...view.receipts.at(-1),
    })),
  };
  const path = new URL("../../demo/last-run.json", import.meta.url);
  await mkdir(dirname(path.pathname), { recursive: true });
  await writeFile(path, JSON.stringify(output, null, 2));
  console.log("Wrote demo/last-run.json (no agent secret keys).");
  console.log("Verify it with: npm run verify-receipt");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
