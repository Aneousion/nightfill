import { formatDecimal, SCALE } from "../core/money.js";
import type { Side } from "../core/match.js";
import type { IllustrativeSlippage } from "../core/types.js";

export const ILLUSTRATIVE_POOL_BASE = 50_000n * SCALE;
export const ILLUSTRATIVE_FEE_BPS = 30n;

export function worseBps(dark: bigint, publicNotional: bigint, side: Side): bigint {
  if (dark <= 0n) return 0n;
  if (side === "buy") return ((publicNotional - dark) * 10_000n) / dark;
  return ((dark - publicNotional) * 10_000n) / dark;
}

export function darkNotional(base: bigint, price: bigint): bigint {
  return (base * price) / SCALE;
}

/** Constant-product estimate used only when the live quote does not return. */
export function illustrativeSlippage(
  side: Side,
  base: bigint,
  price: bigint,
): IllustrativeSlippage {
  const quoteReserve = (ILLUSTRATIVE_POOL_BASE * price) / SCALE;
  const dark = darkNotional(base, price);
  let publicNotional: bigint;
  if (side === "sell") {
    const amountInWithFee = (base * (10_000n - ILLUSTRATIVE_FEE_BPS)) / 10_000n;
    publicNotional =
      (quoteReserve * amountInWithFee) / (ILLUSTRATIVE_POOL_BASE + amountInWithFee);
  } else {
    if (base >= ILLUSTRATIVE_POOL_BASE) {
      throw new Error("illustrative pool is smaller than the order");
    }
    const beforeFee = (quoteReserve * base) / (ILLUSTRATIVE_POOL_BASE - base);
    publicNotional = (beforeFee * 10_000n) / (10_000n - ILLUSTRATIVE_FEE_BPS);
  }
  return {
    label:
      "Illustrative constant-product pool, 50,000 NEAR deep, 30 bps fee. Not a live market and not a 1Click quote.",
    publicNotional: formatDecimal(publicNotional),
    worseBps: worseBps(dark, publicNotional, side).toString(),
    poolBase: "50000",
    feeBps: "30",
  };
}
