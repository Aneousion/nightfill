import { readFile } from "node:fs/promises";
import {
  Account,
  JsonRpcProvider,
  actions,
  teraToGas,
  type KeyPairString,
} from "near-api-js";
import type { AnchorResult, PublicBatch } from "../core/types.js";

const DEFAULT_RPC = "https://rpc.testnet.near.org";

export function anchorConfig(): {
  accountId: string;
  privateKey: string;
  contractId: string;
  rpcUrl: string;
} | null {
  const accountId = process.env.NEAR_ACCOUNT_ID?.trim();
  const privateKey = process.env.NEAR_PRIVATE_KEY?.trim();
  const contractId = process.env.NIGHTFILL_CONTRACT_ID?.trim();
  if (!accountId || !privateKey || !contractId) return null;
  return {
    accountId,
    privateKey,
    contractId,
    rpcUrl: process.env.NEAR_RPC_URL?.trim() || DEFAULT_RPC,
  };
}

export function missingAnchorReason(): string {
  return "Batch root is stored in this process only. Set NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY, and NIGHTFILL_CONTRACT_ID to anchor it on NEAR testnet. See README.";
}

export async function anchorOnTestnet(
  batch: PublicBatch,
  _signPublicKey: string,
): Promise<AnchorResult> {
  const config = anchorConfig();
  if (!config) {
    return {
      status: "not_submitted",
      reason: missingAnchorReason(),
      txHash: null,
      explorerUrl: null,
      contractId: null,
      network: "testnet",
    };
  }
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const account = new Account(config.accountId, provider, config.privateKey as KeyPairString);
  const args = {
    batch_id: batch.batchId,
    merkle_root_hex: batch.merkleRoot,
    receipt_count: batch.receiptCount,
    pair: batch.pair,
    uniform_price: batch.uniformPrice ?? "",
    matched_base: batch.matchedBase,
    routed_base: batch.routedBase,
    code_measurement: batch.codeMeasurement,
  };
  const outcome = await account.signAndSendTransaction({
    receiverId: config.contractId,
    actions: [actions.functionCall("anchor_batch", args, teraToGas("30"), 0n)],
    waitUntil: "EXECUTED",
  });
  const txHash = outcome.transaction_outcome?.id ?? null;
  return {
    status: "submitted",
    reason: null,
    txHash,
    explorerUrl: txHash ? `https://testnet.nearblocks.io/txns/${txHash}` : null,
    contractId: config.contractId,
    network: "testnet",
  };
}

export async function viewAnchoredBatch(batchId: string): Promise<{
  checked: boolean;
  root: string | null;
  error: string | null;
  contractId: string | null;
}> {
  const contractId = process.env.NIGHTFILL_CONTRACT_ID?.trim();
  if (!contractId) {
    return { checked: false, root: null, error: null, contractId: null };
  }
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || DEFAULT_RPC;
  try {
    const provider = new JsonRpcProvider({ url: rpcUrl });
    const record = (await provider.callFunction({
      contractId,
      method: "get_batch",
      args: { batch_id: batchId },
    })) as { merkle_root_hex?: string; merkleRootHex?: string } | null;
    const root = record?.merkle_root_hex ?? record?.merkleRootHex ?? null;
    return { checked: true, root, error: null, contractId };
  } catch (error) {
    return {
      checked: true,
      root: null,
      error: error instanceof Error ? error.message : "view call failed",
      contractId,
    };
  }
}

export async function deployContract(wasmPath: string, engineSignPublicKey: string): Promise<string> {
  const config = anchorConfig();
  if (!config) throw new Error(missingAnchorReason());
  const wasm = new Uint8Array(await readFile(wasmPath));
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const account = new Account(config.accountId, provider, config.privateKey as KeyPairString);
  const outcome = await account.signAndSendTransaction({
    receiverId: config.contractId,
    actions: [
      actions.deployContract(wasm),
      actions.functionCall(
        "new",
        { engine_sign_public_key: engineSignPublicKey },
        teraToGas("30"),
        0n,
      ),
    ],
    waitUntil: "EXECUTED",
  });
  const txHash = outcome.transaction_outcome?.id;
  if (!txHash) throw new Error("deploy transaction returned no hash");
  return txHash;
}
