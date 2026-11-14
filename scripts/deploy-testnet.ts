import { toHex } from "../src/core/codec.js";
import { loadOrCreateKeys } from "../src/core/engine.js";
import { deployContract } from "../src/near/anchor.js";

const wasmPath = process.argv[2] ?? "contract/nightfill.wasm";
const keys = await loadOrCreateKeys(".data/engine-keys.json");
const txHash = await deployContract(wasmPath, toHex(keys.signPublicKey));
console.log(`deployed ${process.env.NIGHTFILL_CONTRACT_ID}`);
console.log(`engine sign key ${toHex(keys.signPublicKey)}`);
console.log(`tx ${txHash}`);
console.log(`https://testnet.nearblocks.io/txns/${txHash}`);
