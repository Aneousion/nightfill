import type { Side } from "./match.js";

export type { Side };

export type Fallback = "rest" | "intents";

export type SealedOrder = {
  v: 1;
  orderId: string;
  agentPubkey: string;
  pair: "NEAR/USDC";
  side: Side;
  size: string;
  limitPrice: string;
  bandLow: string | null;
  bandHigh: string | null;
  minFill: string;
  expiryMs: number;
  fallback: Fallback;
  nonce: string;
};

export type OrderEnvelope = {
  agentPubkey: string;
  sealed: string;
  signature: string;
};

export type IllustrativeSlippage = {
  label: string;
  publicNotional: string;
  worseBps: string;
  poolBase: string;
  feeBps: string;
};

export type RouteSummary = {
  provider: "near-intents-1click";
  dry: true;
  depositType: "INTENTS";
  confidentiality: "basic" | "public" | "unavailable";
  confidentialityNote: string;
  status: "quoted" | "quote_failed";
  error: string | null;
  correlationId: string | null;
  baseAmount: string;
  amountIn: string | null;
  amountOut: string | null;
  minAmountIn: string | null;
  minAmountOut: string | null;
  amountInFormatted: string | null;
  amountOutFormatted: string | null;
  darkNotional: string;
  expectedPublicNotional: string | null;
  worstPublicNotional: string | null;
  expectedWorseBps: string | null;
  worstWorseBps: string | null;
  illustrative: IllustrativeSlippage | null;
};

export type Receipt = {
  v: 1;
  kind: "fill" | "route" | "fill_and_route";
  receiptId: string;
  batchId: string;
  pair: "NEAR/USDC";
  agentPubkey: string;
  orderId: string;
  orderCommitment: string;
  side: Side;
  uniformPrice: string | null;
  referencePrice: string;
  baseFilled: string;
  quoteFilled: string;
  baseRouted: string;
  baseRemaining: string;
  fallback: Fallback;
  timestampMs: number;
  route: RouteSummary | null;
};

export type ProofStep = {
  sibling: string;
  position: "left" | "right";
};

export type StoredReceipt = {
  receipt: Receipt;
  signature: string;
  merkleProof: ProofStep[];
  merkleRoot: string;
  batchId: string;
};

export type AnchorResult = {
  status: "submitted" | "not_submitted" | "failed";
  reason: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  contractId: string | null;
  network: "testnet";
};

export type PublicBatch = {
  batchId: string;
  pair: "NEAR/USDC";
  uniformPrice: string | null;
  referencePrice: string;
  referenceSource: string;
  matchedBase: string;
  matchedQuote: string;
  routedBase: string;
  fillCount: number;
  routeCount: number;
  receiptCount: number;
  ordersConsidered: number;
  merkleRoot: string;
  codeMeasurement: string;
  timestampMs: number;
  anchor: AnchorResult;
};

export type QuoteRequest = {
  orderId: string;
  side: Side;
  baseAmount: bigint;
  benchmarkPrice: bigint;
};

export type Quoter = (request: QuoteRequest) => Promise<RouteSummary>;

export const ATTESTATION_WARNING =
  "SIMULATED ATTESTATION. This is not a hardware quote from Intel TDX, AMD SEV-SNP, or a NEAR Shade Agent. The signature is the engine's own Ed25519 key. It proves this process produced the document. It does not prove the process ran inside a TEE.";

export type Attestation = {
  kind: "nightfill.mock-attestation/v1";
  warning: string;
  simulatedEnvironment: "NEAR Shade Agent / NEAR AI confidential compute";
  nonce: string;
  codeMeasurement: string;
  measurementAlgorithm: "sha256";
  measuredFiles: string[];
  boxPublicKey: string;
  signPublicKey: string;
  pair: "NEAR/USDC";
  generatedAt: string;
  signature: string;
};
