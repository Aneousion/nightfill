import { parseDecimal } from "./core/money.js";

const TOKENS_URL = "https://1click.chaindefuser.com/v0/tokens";
const NEAR_ASSET = "nep141:wrap.near";

export async function fetchReferencePrice(
  fetchImpl: typeof fetch = fetch,
): Promise<{ price: bigint; source: string }> {
  const frozen = process.env.NIGHTFILL_REFERENCE_PRICE?.trim();
  if (frozen) {
    return { price: parseDecimal(frozen), source: "env:NIGHTFILL_REFERENCE_PRICE" };
  }
  const response = await fetchImpl(TOKENS_URL, {
    headers: {
      accept: "application/json",
      "user-agent": "nightfill-hackathon/0.1",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`token list HTTP ${response.status}`);
  }
  const tokens = (await response.json()) as Array<{ assetId?: string; price?: number }>;
  const near = tokens.find((token) => token.assetId === NEAR_ASSET);
  if (!near || typeof near.price !== "number" || !Number.isFinite(near.price) || near.price <= 0) {
    throw new Error("wNEAR price missing from the 1Click token list");
  }
  return {
    price: parseDecimal(near.price.toFixed(6)),
    source: "1click-tokens:wNEAR",
  };
}

export async function referenceOrFallback(
  fetchImpl: typeof fetch = fetch,
): Promise<{ price: bigint; source: string }> {
  try {
    return await fetchReferencePrice(fetchImpl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "oracle unavailable";
    return { price: parseDecimal("3.22"), source: `fallback:3.22 (${message})` };
  }
}
