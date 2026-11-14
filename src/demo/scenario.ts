import { randomUUID } from "node:crypto";
import { formatDecimal, parseDecimal } from "../core/money.js";
import { NightfillEngine, type PrivateView } from "../core/engine.js";
import { canonicalJson } from "../core/canonical.js";
import { toHex } from "../core/codec.js";
import { generateSignKeypair } from "../core/sodium.js";
import type { Fallback, PublicBatch, SealedOrder, Side } from "../core/types.js";

export type ScriptedAgent = {
  name: string;
  role: string;
  pubkey: string;
  secretKey: Uint8Array;
  side: Side;
  size: string;
  limitPrice: string;
  bandLow: string | null;
  bandHigh: string | null;
  minFill: string;
  fallback: Fallback;
  orderId: string;
};

export type ScenarioResult = {
  agents: ScriptedAgent[];
  batch: PublicBatch;
  views: Record<string, PrivateView>;
  lines: string[];
};

function bps(price: bigint, bpsDelta: bigint): bigint {
  return (price * bpsDelta) / 10_000n;
}

export async function runScenario(engine: NightfillEngine): Promise<ScenarioResult> {
  return engine.runLocked(() => runScenarioUnlocked(engine));
}

async function runScenarioUnlocked(engine: NightfillEngine): Promise<ScenarioResult> {
  engine.clearOpenOrders();
  const reference = parseDecimal(engine.reference.price);
  const run = randomUUID().slice(0, 8);
  const specs: Array<Omit<ScriptedAgent, "pubkey" | "secretKey" | "orderId"> & { orderId: string }> = [
    {
      name: "Ada",
      role: "buyer who rests the leftover",
      side: "buy",
      size: "12",
      limitPrice: formatDecimal(bps(reference, 10_300n)),
      bandLow: formatDecimal(bps(reference, 9_500n)),
      bandHigh: formatDecimal(bps(reference, 10_300n)),
      minFill: "1",
      fallback: "rest",
      orderId: `ada-${run}`,
    },
    {
      name: "Bo",
      role: "seller who gets filled",
      side: "sell",
      size: "8",
      limitPrice: formatDecimal(bps(reference, 9_700n)),
      bandLow: formatDecimal(bps(reference, 9_700n)),
      bandHigh: formatDecimal(bps(reference, 11_000n)),
      minFill: "0.5",
      fallback: "rest",
      orderId: `bo-${run}`,
    },
    {
      name: "Chi",
      role: "buyer whose leftover is quoted",
      side: "buy",
      size: "20",
      limitPrice: formatDecimal(bps(reference, 10_100n)),
      bandLow: null,
      bandHigh: null,
      minFill: "1",
      fallback: "intents",
      orderId: `chi-${run}`,
    },
    {
      name: "Noor",
      role: "seller with no cross",
      side: "sell",
      size: "6",
      limitPrice: formatDecimal(bps(reference, 12_500n)),
      bandLow: null,
      bandHigh: null,
      minFill: "0.5",
      fallback: "intents",
      orderId: `noor-${run}`,
    },
  ];

  const agents: ScriptedAgent[] = [];
  for (const spec of specs) {
    const keys = await generateSignKeypair();
    const agent: ScriptedAgent = {
      ...spec,
      pubkey: toHex(keys.publicKey),
      secretKey: keys.secretKey,
    };
    const order: SealedOrder = {
      v: 1,
      orderId: agent.orderId,
      agentPubkey: agent.pubkey,
      pair: "NEAR/USDC",
      side: agent.side,
      size: agent.size,
      limitPrice: agent.limitPrice,
      bandLow: agent.bandLow,
      bandHigh: agent.bandHigh,
      minFill: agent.minFill,
      expiryMs: Date.now() + 60 * 60 * 1000,
      fallback: agent.fallback,
      nonce: randomUUID(),
    };
    const envelope = await engine.sealOrder(order, agent.secretKey);
    await engine.submit(envelope);
    agents.push(agent);
  }

  const result = await engine.runBatch(true);
  if (result.skipped) {
    throw new Error(`scenario produced no batch: ${result.reason}`);
  }
  const views: Record<string, PrivateView> = {};
  for (const agent of agents) views[agent.name] = engine.viewAgent(agent.pubkey);

  await assertStory(result.batch, views, engine);
  const lines = reportLines(engine, result.batch, views, agents);
  return { agents, batch: result.batch, views, lines };
}

async function assertStory(
  batch: PublicBatch,
  views: Record<string, PrivateView>,
  engine: NightfillEngine,
): Promise<void> {
  if (batch.matchedBase !== "8") {
    throw new Error(`expected 8 NEAR matched, got ${batch.matchedBase}`);
  }
  const expect = (
    name: string,
    filled: string,
    routed: string,
    remaining: string,
  ) => {
    const order = views[name].orders.at(-1);
    if (!order) throw new Error(`${name} has no order`);
    if (order.filled !== filled || order.routed !== routed || order.remaining !== remaining) {
      throw new Error(
        `${name} expected filled ${filled} routed ${routed} remaining ${remaining}, got ${order.filled} / ${order.routed} / ${order.remaining}`,
      );
    }
    const bundle = views[name].receipts.at(-1);
    if (!bundle) throw new Error(`${name} has no receipt`);
  };
  expect("Ada", "3", "0", "9");
  expect("Bo", "8", "0", "0");
  expect("Chi", "5", "15", "0");
  expect("Noor", "0", "6", "0");

  const publicJson = canonicalJson(batch);
  for (const view of Object.values(views)) {
    if (publicJson.includes(view.agentPubkey)) {
      throw new Error("public batch leaked an agent key");
    }
    for (const order of view.orders) {
      if (publicJson.includes(order.orderId) || publicJson.includes(`"${order.limitPrice}"`)) {
        throw new Error("public batch leaked an order id or limit");
      }
    }
  }
  for (const view of Object.values(views)) {
    for (const bundle of view.receipts) {
      const check = await engine.verifyReceipt(bundle);
      if (!check.signatureValid || check.proofValid !== true) {
        throw new Error(`receipt ${bundle.receipt.receiptId} failed verification`);
      }
    }
  }
}

function reportLines(
  engine: NightfillEngine,
  batch: PublicBatch,
  views: Record<string, PrivateView>,
  agents: ScriptedAgent[],
): string[] {
  const lines = [
    "Nightfill  ·  built at NEAR HACKATHON",
    `Reference ${engine.reference.price} USDC per NEAR (${engine.reference.source}).`,
    "Four agents sealed orders to the engine X25519 key. The plaintext did not sit on a public book.",
  ];
  for (const agent of agents) {
    lines.push(
      `${agent.name} sealed a ${agent.side} of ${agent.size} NEAR, limit ${agent.limitPrice}, fallback ${agent.fallback}.`,
    );
  }
  lines.push(
    `Dark cross: ${batch.matchedBase} NEAR at ${batch.uniformPrice} USDC. Merkle root ${batch.merkleRoot}.`,
  );
  lines.push("Ada bought 3 and left 9 resting. Bo sold 8 and is done. Chi bought 5.");
  lines.push("Chi's other 15 NEAR and all of Noor's 6 NEAR were quoted on NEAR Intents. Dry run: no funds moved.");
  for (const name of ["Chi", "Noor"] as const) {
    const route = views[name].receipts.at(-1)?.receipt.route;
    if (!route) continue;
    if (route.status === "quoted") {
      const direction = name === "Chi" ? "pay" : "receive";
      lines.push(
        `${name}: 1Click dry quote would ${direction} ${route.expectedPublicNotional} USDC versus a dark print of ${route.darkNotional} USDC (${route.expectedWorseBps} bps; positive means the public route is worse). ${route.confidentialityNote}`,
      );
    } else {
      lines.push(
        `${name}: 1Click quote failed (${route.error}). Illustrative pool slippage is ${route.illustrative?.worseBps ?? "n/a"} bps. ${route.confidentialityNote}`,
      );
    }
  }
  lines.push(
    batch.anchor.status === "submitted"
      ? `Anchored on NEAR testnet: ${batch.anchor.explorerUrl}`
      : `Chain anchor: ${batch.anchor.status}. ${batch.anchor.reason ?? ""}`.trim(),
  );
  lines.push(
    "What the chain is asked to store: the Merkle root, the uniform price, and counts. Not the book.",
  );
  return lines;
}

export function publicAgentCards(result: ScenarioResult): Array<{
  name: string;
  role: string;
  pubkey: string;
  side: Side;
  fallback: Fallback;
}> {
  return result.agents.map((agent) => ({
    name: agent.name,
    role: agent.role,
    pubkey: agent.pubkey,
    side: agent.side,
    fallback: agent.fallback,
  }));
}
