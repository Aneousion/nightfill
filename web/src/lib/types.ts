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

export type Attestation = {
  warning: string;
  codeMeasurement: string;
  measuredFiles: string[];
  boxPublicKey: string;
  signPublicKey: string;
  nonce: string;
  signature: string;
  simulatedEnvironment: string;
};

export type PublicState = {
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
  attestation: Attestation;
};

export type RouteSummary = {
  status: "quoted" | "quote_failed";
  error: string | null;
  confidentiality: string;
  confidentialityNote: string;
  baseAmount: string;
  darkNotional: string;
  expectedPublicNotional: string | null;
  worstPublicNotional: string | null;
  expectedWorseBps: string | null;
  worstWorseBps: string | null;
  amountInFormatted: string | null;
  amountOutFormatted: string | null;
  correlationId: string | null;
  dry: true;
  illustrative: { label: string; publicNotional: string; worseBps: string } | null;
};

export type Receipt = {
  kind: string;
  receiptId: string;
  batchId: string;
  side: "buy" | "sell";
  orderId: string;
  uniformPrice: string | null;
  referencePrice: string;
  baseFilled: string;
  quoteFilled: string;
  baseRouted: string;
  baseRemaining: string;
  route: RouteSummary | null;
};

export type PrivateOrder = {
  orderId: string;
  side: "buy" | "sell";
  size: string;
  limitPrice: string;
  bandLow: string | null;
  bandHigh: string | null;
  minFill: string;
  fallback: "rest" | "intents";
  filled: string;
  routed: string;
  remaining: string;
  status: string;
};

export type AgentView = {
  name: string;
  role: string;
  agentPubkey: string;
  orders: PrivateOrder[];
  receipts: Array<{
    receipt: Receipt;
    signature: string;
    merkleProof: Array<{ sibling: string; position: "left" | "right" }>;
    merkleRoot: string;
  }>;
};

export type DemoRun = {
  sessionToken: string;
  lines: string[];
  batch: PublicBatch;
  signPublicKey: string;
  agents: Array<{ name: string; role: string; pubkey: string; side: string; fallback: string }>;
};

export type VerifyResult = {
  signatureValid: boolean;
  proofValid: boolean | null;
  merkleRoot: string | null;
  signPublicKey: string;
  chain: {
    checked: boolean;
    root: string | null;
    rootMatches: boolean | null;
    error: string | null;
    contractId: string | null;
  };
};
