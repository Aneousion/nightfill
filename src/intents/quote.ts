import { formatDecimal, microNearToYocto, parseDecimal } from "../core/money.js";
import type { QuoteRequest, RouteSummary } from "../core/types.js";
import { darkNotional, illustrativeSlippage, worseBps } from "./amm.js";

export const NEAR_ASSET = "nep141:wrap.near";
export const USDC_ASSET =
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const ONECLICK_QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";

type FetchLike = typeof fetch;

type QuoteBody = {
  amountIn?: string;
  amountOut?: string;
  minAmountIn?: string;
  minAmountOut?: string;
  amountInFormatted?: string;
  amountOutFormatted?: string;
};

function failed(
  request: QuoteRequest,
  error: string,
  confidentiality: RouteSummary["confidentiality"],
  confidentialityNote: string,
): RouteSummary {
  const dark = darkNotional(request.baseAmount, request.benchmarkPrice);
  return {
    provider: "near-intents-1click",
    dry: true,
    depositType: "INTENTS",
    confidentiality,
    confidentialityNote,
    status: "quote_failed",
    error,
    correlationId: null,
    baseAmount: formatDecimal(request.baseAmount),
    amountIn: null,
    amountOut: null,
    minAmountIn: null,
    minAmountOut: null,
    amountInFormatted: null,
    amountOutFormatted: null,
    darkNotional: formatDecimal(dark),
    expectedPublicNotional: null,
    worstPublicNotional: null,
    expectedWorseBps: null,
    worstWorseBps: null,
    illustrative: illustrativeSlippage(
      request.side,
      request.baseAmount,
      request.benchmarkPrice,
    ),
  };
}

export function buildQuoteBody(
  request: QuoteRequest,
  confidentiality: "basic" | "public",
  account: string,
  now = Date.now(),
): Record<string, unknown> {
  const sellingNear = request.side === "sell";
  return {
    dry: true,
    swapType: sellingNear ? "EXACT_INPUT" : "EXACT_OUTPUT",
    slippageTolerance: 50,
    originAsset: sellingNear ? NEAR_ASSET : USDC_ASSET,
    depositType: "INTENTS",
    destinationAsset: sellingNear ? USDC_ASSET : NEAR_ASSET,
    amount: microNearToYocto(request.baseAmount),
    recipient: account,
    recipientType: "INTENTS",
    refundTo: account,
    refundType: "INTENTS",
    deadline: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    confidentiality,
    referral: "nightfill",
    quoteWaitingTimeMs: 0,
  };
}

function usdcAmount(raw: string | undefined): bigint | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

export async function requestIntentsQuote(
  request: QuoteRequest,
  fetchImpl: FetchLike = fetch,
): Promise<RouteSummary> {
  const account = process.env.NIGHTFILL_INTENTS_ACCOUNT || "nightfill.near";
  const jwt = process.env.ONECLICK_JWT?.trim();
  let confidentiality: RouteSummary["confidentiality"] = "public";
  let confidentialityNote =
    "Confidential Intents (confidentiality=basic) requires a 1Click partner JWT. ONECLICK_JWT is not set, so this is a public dry quote on the Intents balance rail. No funds move.";

  if (jwt) {
    const basic = await postQuote(request, "basic", account, jwt, fetchImpl);
    if (basic.ok) {
      confidentiality = "basic";
      confidentialityNote =
        "Dry quote requested with confidentiality=basic. No funds move. Execution is a separate step this MVP does not take.";
      return summarize(request, basic, confidentiality, confidentialityNote);
    }
    confidentialityNote = `Confidential quote was refused (${basic.error}). Fell back to a public dry quote. No funds move.`;
  }

  const pub = await postQuote(request, "public", account, jwt, fetchImpl);
  if (!pub.ok) {
    return failed(
      request,
      pub.error,
      jwt ? "unavailable" : "public",
      `${confidentialityNote} Public quote also failed: ${pub.error}`,
    );
  }
  return summarize(request, pub, confidentiality, confidentialityNote);
}

async function postQuote(
  request: QuoteRequest,
  confidentiality: "basic" | "public",
  account: string,
  jwt: string | undefined,
  fetchImpl: FetchLike,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "nightfill-hackathon/0.1",
  };
  if (jwt && confidentiality === "basic") headers.authorization = `Bearer ${jwt}`;
  try {
    const response = await fetchImpl(ONECLICK_QUOTE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(buildQuoteBody(request, confidentiality, account)),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { message: text.slice(0, 240) };
    }
    if (!response.ok) {
      const message =
        typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`;
      return { ok: false, error: message };
    }
    return { ok: true, body: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "quote request failed";
    return { ok: false, error: message };
  }
}

function summarize(
  request: QuoteRequest,
  result: { ok: true; body: Record<string, unknown> },
  confidentiality: RouteSummary["confidentiality"],
  confidentialityNote: string,
): RouteSummary {
  const quote = (result.body.quote ?? null) as QuoteBody | null;
  const dark = darkNotional(request.baseAmount, request.benchmarkPrice);
  if (!quote) {
    return failed(request, "quote response had no quote object", confidentiality, confidentialityNote);
  }
  const amountIn = usdcAmount(quote.amountIn);
  const amountOut = usdcAmount(quote.amountOut);
  const minAmountIn = usdcAmount(quote.minAmountIn);
  const minAmountOut = usdcAmount(quote.minAmountOut);
  const expected =
    request.side === "buy" ? (minAmountIn ?? amountIn) : amountOut;
  const worst = request.side === "buy" ? amountIn : (minAmountOut ?? amountOut);
  return {
    provider: "near-intents-1click",
    dry: true,
    depositType: "INTENTS",
    confidentiality,
    confidentialityNote,
    status: "quoted",
    error: null,
    correlationId:
      typeof result.body.correlationId === "string" ? result.body.correlationId : null,
    baseAmount: formatDecimal(request.baseAmount),
    amountIn: quote.amountIn ?? null,
    amountOut: quote.amountOut ?? null,
    minAmountIn: quote.minAmountIn ?? null,
    minAmountOut: quote.minAmountOut ?? null,
    amountInFormatted: quote.amountInFormatted ?? null,
    amountOutFormatted: quote.amountOutFormatted ?? null,
    darkNotional: formatDecimal(dark),
    expectedPublicNotional: expected === null ? null : formatDecimal(expected),
    worstPublicNotional: worst === null ? null : formatDecimal(worst),
    expectedWorseBps:
      expected === null ? null : worseBps(dark, expected, request.side).toString(),
    worstWorseBps: worst === null ? null : worseBps(dark, worst, request.side).toString(),
    illustrative: null,
  };
}

export function parseUsdc(decimal: string): bigint {
  return parseDecimal(decimal);
}
