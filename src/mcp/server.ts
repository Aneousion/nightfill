import { mkdir, readFile, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { canonicalBytes } from "../core/canonical.js";
import { fromHex, toHex } from "../core/codec.js";
import { generateSignKeypair, getSodium, sealTo, signDetached } from "../core/sodium.js";
import type { SealedOrder } from "../core/types.js";

const base = process.env.NIGHTFILL_ENGINE_URL ?? "http://127.0.0.1:8788";

type ToolText = { content: Array<{ type: "text"; text: string }> };

async function loadAgent(): Promise<{ publicKey: string; secretKey: Uint8Array }> {
  const fromEnv = process.env.NIGHTFILL_AGENT_SECRET?.trim();
  if (fromEnv) {
    const secretKey = fromHex(fromEnv);
    const sodium = await getSodium();
    const publicKey = sodium.crypto_sign_ed25519_sk_to_pk(secretKey);
    return { publicKey: toHex(publicKey), secretKey };
  }
  const path = new URL("../../.data/mcp-agent.json", import.meta.url).pathname;
  try {
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      publicKey: string;
      secretKey: string;
    };
    return { publicKey: saved.publicKey, secretKey: fromHex(saved.secretKey) };
  } catch {
    const generated = await generateSignKeypair();
    await mkdir(new URL("../../.data/", import.meta.url).pathname, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        publicKey: toHex(generated.publicKey),
        secretKey: toHex(generated.secretKey),
      }),
      { mode: 0o600 },
    );
    return { publicKey: toHex(generated.publicKey), secretKey: generated.secretKey };
  }
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, init);
  } catch {
    throw new Error(`Nightfill engine is not running at ${base}. Start it with npm run dev.`);
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : text);
  }
  return body;
}

function textResult(value: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const agent = await loadAgent();
const server = new McpServer({ name: "nightfill", version: "0.1.0" });

server.registerTool(
  "submit_sealed_order",
  {
    description:
      "Seal a NEAR/USDC order to the Nightfill engine and submit it. The plaintext is encrypted in this process. The engine is the only party that can open it. Nothing is written to a public book.",
    inputSchema: {
      side: z.enum(["buy", "sell"]).describe("Buy pays USDC for NEAR. Sell does the opposite."),
      size: z.string().describe("Size in NEAR, decimal, up to 6 places."),
      limitPrice: z.string().describe("USDC per NEAR. A buy will not pay more. A sell will not accept less."),
      bandLow: z.string().optional().describe("Optional band low, USDC per NEAR."),
      bandHigh: z.string().optional().describe("Optional band high, USDC per NEAR."),
      minFill: z.string().optional().describe("Minimum fill in NEAR. Defaults to 0."),
      expirySeconds: z.number().optional().describe("Seconds until the order expires. Defaults to 3600."),
      fallback: z.enum(["rest", "intents"]).optional().describe("rest keeps the leftover in the dark book. intents asks NEAR Intents for a dry quote."),
    },
  },
  async (args) => {
    const info = (await call("/v1/info")) as { boxPublicKey: string };
    const order: SealedOrder = {
      v: 1,
      orderId: `mcp-${crypto.randomUUID().slice(0, 8)}`,
      agentPubkey: agent.publicKey,
      pair: "NEAR/USDC",
      side: args.side,
      size: args.size,
      limitPrice: args.limitPrice,
      bandLow: args.bandLow ?? null,
      bandHigh: args.bandHigh ?? null,
      minFill: args.minFill ?? "0",
      expiryMs: Date.now() + (args.expirySeconds ?? 3600) * 1000,
      fallback: args.fallback ?? "rest",
      nonce: crypto.randomUUID(),
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(order));
    const sealed = await sealTo(plaintext, fromHex(info.boxPublicKey));
    const signature = await signDetached(sealed, agent.secretKey);
    const submitted = await call("/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentPubkey: agent.publicKey,
        sealed: Buffer.from(sealed).toString("base64"),
        signature: toHex(signature),
      }),
    });
    return textResult({
      ...((submitted ?? {}) as object),
      orderId: order.orderId,
      note: "The order is sealed. The public API does not show its side, size, or limit.",
    });
  },
);

server.registerTool(
  "cancel_order",
  {
    description: "Cancel the resting size of one of this agent's orders. The filled size stays filled.",
    inputSchema: { orderId: z.string() },
  },
  async ({ orderId }) => {
    const unsigned = {
      v: 1 as const,
      action: "cancel" as const,
      orderId,
      agentPubkey: agent.publicKey,
      timestampMs: Date.now(),
    };
    const signature = toHex(await signDetached(canonicalBytes(unsigned), agent.secretKey));
    return textResult(
      await call("/v1/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...unsigned, signature }),
      }),
    );
  },
);

server.registerTool(
  "get_my_fills",
  {
    description:
      "Read this agent's orders and signed fill receipts. Requires a fresh signature. Does not return anyone else's book.",
    inputSchema: {},
  },
  async () => {
    const unsigned = {
      v: 1 as const,
      action: "read" as const,
      agentPubkey: agent.publicKey,
      timestampMs: Date.now(),
      nonce: crypto.randomUUID(),
    };
    const signature = toHex(await signDetached(canonicalBytes(unsigned), agent.secretKey));
    return textResult(
      await call("/v1/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...unsigned, signature }),
      }),
    );
  },
);

server.registerTool(
  "verify_receipt",
  {
    description:
      "Check an Ed25519 fill receipt and, when a Merkle proof is included, that it sits under a batch root. Verification does not reveal the rest of the book.",
    inputSchema: {
      receipt: z.record(z.string(), z.unknown()),
      signature: z.string(),
      merkleProof: z
        .array(z.object({ sibling: z.string(), position: z.enum(["left", "right"]) }))
        .optional(),
      merkleRoot: z.string().optional(),
    },
  },
  async (args) =>
    textResult(
      await call("/v1/receipts/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    ),
);

server.registerTool(
  "get_public_batch",
  {
    description:
      "Public view: reference price, batch Merkle roots, uniform prices, aggregate volume, and the mock TEE attestation. No order book.",
    inputSchema: {},
  },
  async () => textResult(await call("/v1/public")),
);

const transport = new StdioServerTransport();
await server.connect(transport);
