import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildAttestation } from "./attestation.js";
import { canonicalBytes, canonicalJson } from "./canonical.js";
import { fromBase64, fromHex, sha256Hex, toBase64, toHex } from "./codec.js";
import { formatDecimal, PAIR, parseDecimal } from "./money.js";
import { merkleTree, verifyProof, type ProofStep } from "./merkle.js";
import { matchOrders, type MatchOrder } from "./match.js";
import {
  generateEngineKeys,
  openSeal,
  sealTo,
  signDetached,
  verifyDetached,
  type EngineKeys,
} from "./sodium.js";
import type {
  AnchorResult,
  Attestation,
  Fallback,
  OrderEnvelope,
  PublicBatch,
  Quoter,
  Receipt,
  RouteSummary,
  SealedOrder,
  Side,
  StoredReceipt,
} from "./types.js";

export class NightfillError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "NightfillError";
  }
}

type BookOrder = {
  orderId: string;
  agentPubkey: string;
  commitment: string;
  side: Side;
  size: bigint;
  filled: bigint;
  routed: bigint;
  remaining: bigint;
  limitPrice: bigint;
  bandLow: bigint | null;
  bandHigh: bigint | null;
  minFill: bigint;
  expiryMs: number;
  fallback: Fallback;
  sequence: number;
  status: "open" | "partial" | "filled" | "routed" | "cancelled";
  nonce: string;
};

export type PrivateOrder = {
  orderId: string;
  side: Side;
  size: string;
  limitPrice: string;
  bandLow: string | null;
  bandHigh: string | null;
  minFill: string;
  fallback: Fallback;
  expiryMs: number;
  filled: string;
  routed: string;
  remaining: string;
  status: BookOrder["status"];
  commitment: string;
};

export type PrivateView = {
  agentPubkey: string;
  orders: PrivateOrder[];
  receipts: StoredReceipt[];
};

type AnchorFn = (batch: PublicBatch, signPublicKey: string) => Promise<AnchorResult>;

const ORDER_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const PUBKEY = /^[0-9a-f]{64}$/;

function notAnchored(reason: string): AnchorResult {
  return {
    status: "not_submitted",
    reason,
    txHash: null,
    explorerUrl: null,
    contractId: null,
    network: "testnet",
  };
}

export class NightfillEngine {
  private orders = new Map<string, BookOrder>();
  private receipts = new Map<string, StoredReceipt>();
  private batches: PublicBatch[] = [];
  private sequence = 0;
  private ordersAccepted = 0;
  private matchedBaseTotal = 0n;
  private routedBaseTotal = 0n;
  private batching = false;
  private readNonces = new Set<string>();

  private constructor(
    private readonly keys: EngineKeys,
    private referencePrice: bigint,
    private referenceSource: string,
    private readonly quoter: Quoter,
    private readonly anchor: AnchorFn,
    private readonly now: () => number,
  ) {}

  static async create(options: {
    keys?: EngineKeys;
    referencePrice: bigint;
    referenceSource?: string;
    quoter: Quoter;
    anchor?: AnchorFn;
    now?: () => number;
  }): Promise<NightfillEngine> {
    return new NightfillEngine(
      options.keys ?? (await generateEngineKeys()),
      options.referencePrice,
      options.referenceSource ?? "unspecified",
      options.quoter,
      options.anchor ??
        (async () => notAnchored("No anchor function was configured.")),
      options.now ?? Date.now,
    );
  }

  get boxPublicKeyHex(): string {
    return toHex(this.keys.boxPublicKey);
  }

  get signPublicKeyHex(): string {
    return toHex(this.keys.signPublicKey);
  }

  get reference(): { price: string; source: string } {
    return {
      price: formatDecimal(this.referencePrice),
      source: this.referenceSource,
    };
  }

  setReference(price: bigint, source: string): void {
    if (price <= 0n) throw new NightfillError("reference price must be positive");
    this.referencePrice = price;
    this.referenceSource = source;
  }

  clearOpenOrders(): void {
    for (const order of this.orders.values()) {
      if (order.remaining > 0n && order.status !== "cancelled") {
        order.remaining = 0n;
        order.status = "cancelled";
      }
    }
  }

  async attestation(nonce?: string): Promise<Attestation> {
    return buildAttestation({
      boxPublicKey: this.keys.boxPublicKey,
      signPublicKey: this.keys.signPublicKey,
      signSecretKey: this.keys.signSecretKey,
      nonce,
      now: new Date(this.now()),
    });
  }

  async sealOrder(order: SealedOrder, agentSecretKey: Uint8Array): Promise<OrderEnvelope> {
    const plaintext = new TextEncoder().encode(canonicalJson(order));
    const sealed = await sealTo(plaintext, this.keys.boxPublicKey);
    const signature = await signDetached(sealed, agentSecretKey);
    return {
      agentPubkey: order.agentPubkey,
      sealed: toBase64(sealed),
      signature: toHex(signature),
    };
  }

  async submit(envelope: OrderEnvelope): Promise<{ orderId: string; orderCommitment: string }> {
    if (!PUBKEY.test(envelope.agentPubkey)) {
      throw new NightfillError("agentPubkey must be 32 bytes of hex");
    }
    const ciphertext = fromBase64(envelope.sealed);
    const signature = fromHex(envelope.signature);
    const agentKey = fromHex(envelope.agentPubkey);
    const signed = await verifyDetached(ciphertext, signature, agentKey);
    if (!signed) throw new NightfillError("envelope signature is invalid", 401);

    let opened: Uint8Array;
    try {
      opened = await openSeal(ciphertext, this.keys.boxPublicKey, this.keys.boxSecretKey);
    } catch {
      throw new NightfillError("order was not sealed to this engine");
    }

    let parsed: SealedOrder;
    try {
      parsed = JSON.parse(new TextDecoder().decode(opened)) as SealedOrder;
    } catch {
      throw new NightfillError("sealed order was not JSON");
    }
    const order = validateOrder(parsed, this.now());
    if (order.agentPubkey !== envelope.agentPubkey) {
      throw new NightfillError("sealed order agent does not match the signature");
    }
    if (this.orders.has(order.orderId)) throw new NightfillError("order id already used", 409);

    const commitment = sha256Hex(ciphertext);
    this.sequence += 1;
    this.ordersAccepted += 1;
    this.orders.set(order.orderId, {
      orderId: order.orderId,
      agentPubkey: order.agentPubkey,
      commitment,
      side: order.side,
      size: order.size,
      filled: 0n,
      routed: 0n,
      remaining: order.size,
      limitPrice: order.limitPrice,
      bandLow: order.bandLow,
      bandHigh: order.bandHigh,
      minFill: order.minFill,
      expiryMs: order.expiryMs,
      fallback: order.fallback,
      sequence: this.sequence,
      status: "open",
      nonce: order.nonce,
    });
    return { orderId: order.orderId, orderCommitment: commitment };
  }

  async cancel(body: {
    v: 1;
    action: "cancel";
    orderId: string;
    agentPubkey: string;
    timestampMs: number;
    signature: string;
  }): Promise<{ orderId: string; status: "cancelled" }> {
    await this.assertSigned(body, body.signature, body.agentPubkey, body.timestampMs);
    const order = this.orders.get(body.orderId);
    if (!order || order.agentPubkey !== body.agentPubkey) {
      throw new NightfillError("order not found", 404);
    }
    if (order.remaining === 0n) {
      throw new NightfillError(`order is ${order.status} and has nothing resting`, 409);
    }
    order.remaining = 0n;
    order.status = "cancelled";
    return { orderId: order.orderId, status: "cancelled" };
  }

  async privateView(body: {
    v: 1;
    action: "read";
    agentPubkey: string;
    timestampMs: number;
    nonce: string;
    signature: string;
  }): Promise<PrivateView> {
    if (this.readNonces.has(body.nonce)) {
      throw new NightfillError("read nonce already used", 401);
    }
    await this.assertSigned(body, body.signature, body.agentPubkey, body.timestampMs);
    this.readNonces.add(body.nonce);
    if (this.readNonces.size > 2_000) {
      const first = this.readNonces.values().next().value;
      if (first) this.readNonces.delete(first);
    }
    return this.viewAgent(body.agentPubkey);
  }

  viewAgent(agentPubkey: string): PrivateView {
    const orders = [...this.orders.values()]
      .filter((order) => order.agentPubkey === agentPubkey)
      .sort((a, b) => a.sequence - b.sequence)
      .map(serializeOrder);
    const receipts = [...this.receipts.values()].filter(
      (item) => item.receipt.agentPubkey === agentPubkey,
    );
    return { agentPubkey, orders, receipts };
  }

  async runLocked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.batching) throw new NightfillError("a batch is already running", 409);
    this.batching = true;
    try {
      return await fn();
    } finally {
      this.batching = false;
    }
  }

  async runBatch(
    nested = false,
  ): Promise<{ skipped: true; reason: string } | { skipped: false; batch: PublicBatch }> {
    if (this.batching && !nested) return { skipped: true, reason: "batch in progress" };
    const ownsLock = !this.batching;
    if (ownsLock) this.batching = true;
    try {
      const now = this.now();
      const open = [...this.orders.values()].filter(
        (order) => order.remaining > 0n && order.expiryMs > now && order.status !== "cancelled",
      );
      if (open.length === 0) return { skipped: true, reason: "no open orders" };

      const matched = matchOrders(open.map(toMatchOrder), this.referencePrice, now);
      const fillById = new Map(matched.fills.map((fill) => [fill.orderId, fill.baseFilled]));
      const benchmark = matched.price ?? this.referencePrice;

      const routeTargets: BookOrder[] = [];
      for (const order of open) {
        const fill = fillById.get(order.orderId) ?? 0n;
        if (fill > order.remaining) {
          throw new NightfillError("matcher allocated more than the resting size");
        }
        order.filled += fill;
        order.remaining -= fill;
        if (order.remaining > 0n && order.fallback === "intents") {
          routeTargets.push(order);
        }
      }

      const quotes = await Promise.all(
        routeTargets.map(async (order) => {
          try {
            const route = await this.quoter({
              orderId: order.orderId,
              side: order.side,
              baseAmount: order.remaining,
              benchmarkPrice: benchmark,
            });
            return { order, route, error: null as string | null };
          } catch (error) {
            const message = error instanceof Error ? error.message : "quote failed";
            return { order, route: null, error: message };
          }
        }),
      );

      const routed = new Map<string, RouteSummary>();
      const routedAmount = new Map<string, bigint>();
      for (const item of quotes) {
        const summary =
          item.route ??
          ({
            provider: "near-intents-1click",
            dry: true,
            depositType: "INTENTS",
            confidentiality: "unavailable",
            confidentialityNote: "The quote adapter threw before returning a summary.",
            status: "quote_failed",
            error: item.error,
            correlationId: null,
            baseAmount: formatDecimal(item.order.remaining),
            amountIn: null,
            amountOut: null,
            minAmountIn: null,
            minAmountOut: null,
            amountInFormatted: null,
            amountOutFormatted: null,
            darkNotional: formatDecimal((item.order.remaining * benchmark) / 1_000_000n),
            expectedPublicNotional: null,
            worstPublicNotional: null,
            expectedWorseBps: null,
            worstWorseBps: null,
            illustrative: null,
          } satisfies RouteSummary);
        const amount = item.order.remaining;
        item.order.routed += amount;
        item.order.remaining = 0n;
        routed.set(item.order.orderId, summary);
        routedAmount.set(item.order.orderId, amount);
      }

      for (const order of open) {
        if (order.status === "cancelled") continue;
        if (order.routed > 0n) order.status = "routed";
        else if (order.remaining === 0n) order.status = "filled";
        else if (order.filled > 0n) order.status = "partial";
        else order.status = "open";
      }

      const touched = open.filter(
        (order) => (fillById.get(order.orderId) ?? 0n) > 0n || routed.has(order.orderId),
      );
      if (touched.length === 0) return { skipped: true, reason: "nothing crossed or routed" };

      const batchId = `bt_${randomUUID().replaceAll("-", "")}`;
      const timestampMs = now;
      const measurement = (await this.attestation("batch")).codeMeasurement;
      const receipts: Receipt[] = touched
        .slice()
        .sort((a, b) => a.sequence - b.sequence)
        .map((order) => {
          const baseFilled = fillById.get(order.orderId) ?? 0n;
          const route = routed.get(order.orderId) ?? null;
          const baseRouted = routedAmount.get(order.orderId) ?? 0n;
          const kind =
            baseFilled > 0n && baseRouted > 0n
              ? "fill_and_route"
              : baseFilled > 0n
                ? "fill"
                : "route";
          return {
            v: 1 as const,
            kind,
            receiptId: `rcpt_${randomUUID().replaceAll("-", "")}`,
            batchId,
            pair: PAIR,
            agentPubkey: order.agentPubkey,
            orderId: order.orderId,
            orderCommitment: order.commitment,
            side: order.side,
            uniformPrice: matched.price === null ? null : formatDecimal(matched.price),
            referencePrice: formatDecimal(this.referencePrice),
            baseFilled: formatDecimal(baseFilled),
            quoteFilled: formatDecimal(
              matched.price === null ? 0n : (baseFilled * matched.price) / 1_000_000n,
            ),
            baseRouted: formatDecimal(baseRouted),
            baseRemaining: formatDecimal(order.remaining),
            fallback: order.fallback,
            timestampMs,
            route,
          };
        });

      const leaves = receipts.map((receipt) => canonicalJson(receipt));
      const tree = merkleTree(leaves);
      const stored: StoredReceipt[] = [];
      for (let index = 0; index < receipts.length; index += 1) {
        const receipt = receipts[index];
        const signature = toHex(
          await signDetached(canonicalBytes(receipt), this.keys.signSecretKey),
        );
        const bundle: StoredReceipt = {
          receipt,
          signature,
          merkleProof: tree.proofs[index],
          merkleRoot: tree.root,
          batchId,
        };
        this.receipts.set(receipt.receiptId, bundle);
        stored.push(bundle);
      }

      const matchedBase = matched.fills
        .filter((fill) => {
          const order = this.orders.get(fill.orderId);
          return order?.side === "buy";
        })
        .reduce((sum, fill) => sum + fill.baseFilled, 0n);
      const matchedQuote =
        matched.price === null ? 0n : (matchedBase * matched.price) / 1_000_000n;
      const routedBase = [...routedAmount.values()].reduce((sum, amount) => sum + amount, 0n);
      this.matchedBaseTotal += matchedBase;
      this.routedBaseTotal += routedBase;

      const draft: PublicBatch = {
        batchId,
        pair: PAIR,
        uniformPrice: matched.price === null ? null : formatDecimal(matched.price),
        referencePrice: formatDecimal(this.referencePrice),
        referenceSource: this.referenceSource,
        matchedBase: formatDecimal(matchedBase),
        matchedQuote: formatDecimal(matchedQuote),
        routedBase: formatDecimal(routedBase),
        fillCount: matched.fills.length,
        routeCount: routed.size,
        receiptCount: receipts.length,
        ordersConsidered: open.length,
        merkleRoot: tree.root,
        codeMeasurement: measurement,
        timestampMs,
        anchor: notAnchored("pending"),
      };
      let anchor: AnchorResult;
      try {
        anchor = await this.anchor(draft, this.signPublicKeyHex);
      } catch (error) {
        anchor = {
          status: "failed",
          reason: error instanceof Error ? error.message : "anchor failed",
          txHash: null,
          explorerUrl: null,
          contractId: process.env.NIGHTFILL_CONTRACT_ID ?? null,
          network: "testnet",
        };
      }
      const batch = { ...draft, anchor };
      this.batches.push(batch);
      return { skipped: false, batch };
    } finally {
      if (ownsLock) this.batching = false;
    }
  }

  async verifyReceipt(input: {
    receipt: Receipt;
    signature: string;
    merkleProof?: ProofStep[];
    merkleRoot?: string;
    signPublicKey?: string;
  }): Promise<{
    signatureValid: boolean;
    proofValid: boolean | null;
    merkleRoot: string | null;
    signPublicKey: string;
  }> {
    const signPublicKey = input.signPublicKey ?? this.signPublicKeyHex;
    let signatureValid = false;
    try {
      signatureValid = await verifyDetached(
        canonicalBytes(input.receipt),
        fromHex(input.signature),
        fromHex(signPublicKey),
      );
    } catch {
      signatureValid = false;
    }
    const root =
      input.merkleRoot ??
      this.batches.find((batch) => batch.batchId === input.receipt.batchId)?.merkleRoot ??
      null;
    const proofValid =
      input.merkleProof && root
        ? verifyProof(canonicalJson(input.receipt), input.merkleProof, root)
        : null;
    return { signatureValid, proofValid, merkleRoot: root, signPublicKey };
  }

  publicState(): {
    pair: "NEAR/USDC";
    referencePrice: string;
    referenceSource: string;
    ordersAccepted: number;
    ordersOpen: number;
    matchedBaseTotal: string;
    routedBaseTotal: string;
    boxPublicKey: string;
    signPublicKey: string;
    batches: PublicBatch[];
  } {
    const ordersOpen = [...this.orders.values()].filter((order) => order.remaining > 0n).length;
    return {
      pair: PAIR,
      referencePrice: formatDecimal(this.referencePrice),
      referenceSource: this.referenceSource,
      ordersAccepted: this.ordersAccepted,
      ordersOpen,
      matchedBaseTotal: formatDecimal(this.matchedBaseTotal),
      routedBaseTotal: formatDecimal(this.routedBaseTotal),
      boxPublicKey: this.boxPublicKeyHex,
      signPublicKey: this.signPublicKeyHex,
      batches: this.batches,
    };
  }

  private async assertSigned(
    payload: object,
    signatureHex: string,
    agentPubkey: string,
    timestampMs: number,
  ): Promise<void> {
    if (!PUBKEY.test(agentPubkey)) throw new NightfillError("bad agent key", 401);
    const age = Math.abs(this.now() - timestampMs);
    if (age > 5 * 60 * 1000) throw new NightfillError("signature timestamp is stale", 401);
    const { signature: _ignored, ...unsigned } = payload as { signature?: string };
    const ok = await verifyDetached(
      canonicalBytes(unsigned),
      fromHex(signatureHex),
      fromHex(agentPubkey),
    );
    if (!ok) throw new NightfillError("signature is invalid", 401);
  }
}

function toMatchOrder(order: BookOrder): MatchOrder {
  return {
    orderId: order.orderId,
    side: order.side,
    remaining: order.remaining,
    limitPrice: order.limitPrice,
    bandLow: order.bandLow,
    bandHigh: order.bandHigh,
    minFill: order.minFill,
    expiryMs: order.expiryMs,
    sequence: order.sequence,
  };
}

function serializeOrder(order: BookOrder): PrivateOrder {
  return {
    orderId: order.orderId,
    side: order.side,
    size: formatDecimal(order.size),
    limitPrice: formatDecimal(order.limitPrice),
    bandLow: order.bandLow === null ? null : formatDecimal(order.bandLow),
    bandHigh: order.bandHigh === null ? null : formatDecimal(order.bandHigh),
    minFill: formatDecimal(order.minFill),
    fallback: order.fallback,
    expiryMs: order.expiryMs,
    filled: formatDecimal(order.filled),
    routed: formatDecimal(order.routed),
    remaining: formatDecimal(order.remaining),
    status: order.status,
    commitment: order.commitment,
  };
}

type ValidOrder = {
  orderId: string;
  agentPubkey: string;
  side: Side;
  size: bigint;
  limitPrice: bigint;
  bandLow: bigint | null;
  bandHigh: bigint | null;
  minFill: bigint;
  expiryMs: number;
  fallback: Fallback;
  nonce: string;
};

function validateOrder(order: SealedOrder, now: number): ValidOrder {
  if (order.v !== 1) throw new NightfillError("unsupported order version");
  if (!ORDER_ID.test(order.orderId ?? "")) throw new NightfillError("bad order id");
  if (!PUBKEY.test(order.agentPubkey ?? "")) throw new NightfillError("bad agent key inside order");
  if (order.pair !== PAIR) throw new NightfillError("this pool trades NEAR/USDC only");
  if (order.side !== "buy" && order.side !== "sell") throw new NightfillError("side must be buy or sell");
  const size = parseDecimal(order.size);
  const limitPrice = parseDecimal(order.limitPrice);
  const minFill = parseDecimal(order.minFill ?? "0");
  if (size <= 0n) throw new NightfillError("size must be positive");
  if (size > parseDecimal("1000000")) throw new NightfillError("size is above the demo limit");
  if (limitPrice <= 0n) throw new NightfillError("limit price must be positive");
  if (minFill < 0n || minFill > size) throw new NightfillError("min fill must be between 0 and size");
  if (!Number.isFinite(order.expiryMs)) throw new NightfillError("bad expiry");
  if (order.expiryMs <= now) throw new NightfillError("order is already expired");
  if (order.expiryMs > now + 7 * 24 * 60 * 60 * 1000) {
    throw new NightfillError("expiry is more than 7 days out");
  }
  if (order.fallback !== "rest" && order.fallback !== "intents") {
    throw new NightfillError("fallback must be rest or intents");
  }
  const bandLow = order.bandLow === null ? null : parseDecimal(order.bandLow);
  const bandHigh = order.bandHigh === null ? null : parseDecimal(order.bandHigh);
  if ((bandLow === null) !== (bandHigh === null)) {
    throw new NightfillError("band low and high must both be set");
  }
  if (bandLow !== null && bandHigh !== null) {
    if (bandLow > bandHigh) throw new NightfillError("band low is above band high");
    if (order.side === "buy" && bandLow > limitPrice) {
      throw new NightfillError("buy band does not overlap the limit");
    }
    if (order.side === "sell" && bandHigh < limitPrice) {
      throw new NightfillError("sell band does not overlap the limit");
    }
  }
  if (typeof order.nonce !== "string" || order.nonce.length < 4 || order.nonce.length > 80) {
    throw new NightfillError("nonce is required");
  }
  return {
    orderId: order.orderId,
    agentPubkey: order.agentPubkey,
    side: order.side,
    size,
    limitPrice,
    bandLow,
    bandHigh,
    minFill,
    expiryMs: order.expiryMs,
    fallback: order.fallback,
    nonce: order.nonce,
  };
}

export async function loadOrCreateKeys(path: string): Promise<EngineKeys> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    return {
      boxPublicKey: fromHex(parsed.boxPublicKey),
      boxSecretKey: fromHex(parsed.boxSecretKey),
      signPublicKey: fromHex(parsed.signPublicKey),
      signSecretKey: fromHex(parsed.signSecretKey),
    };
  } catch {
    const keys = await generateEngineKeys();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        boxPublicKey: toHex(keys.boxPublicKey),
        boxSecretKey: toHex(keys.boxSecretKey),
        signPublicKey: toHex(keys.signPublicKey),
        signSecretKey: toHex(keys.signSecretKey),
      }),
      { mode: 0o600 },
    );
    return keys;
  }
}

export async function signAgentPayload(
  payload: object,
  secretKey: Uint8Array,
): Promise<string> {
  return toHex(await signDetached(canonicalBytes(payload), secretKey));
}
