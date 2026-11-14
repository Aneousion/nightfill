import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/core/canonical.js";
import { merkleTree, verifyProof } from "../src/core/merkle.js";
import { generateEngineKeys, openSeal, sealTo } from "../src/core/sodium.js";
import { NightfillEngine } from "../src/core/engine.js";
import { formatDecimal, parseDecimal } from "../src/core/money.js";
import { runScenario } from "../src/demo/scenario.js";
import { startHttp } from "../src/server/http.js";
import type { Quoter } from "../src/core/types.js";
import { illustrativeSlippage } from "../src/intents/amm.js";
import { buildQuoteBody, requestIntentsQuote } from "../src/intents/quote.js";

const fakeQuoter: Quoter = async (request) => ({
  provider: "near-intents-1click",
  dry: true,
  depositType: "INTENTS",
  confidentiality: "public",
  confidentialityNote: "test double",
  status: "quoted",
  error: null,
  correlationId: "test",
  baseAmount: formatDecimal(request.baseAmount),
  amountIn: null,
  amountOut: null,
  minAmountIn: null,
  minAmountOut: null,
  amountInFormatted: null,
  amountOutFormatted: null,
  darkNotional: formatDecimal((request.baseAmount * request.benchmarkPrice) / 1_000_000n),
  expectedPublicNotional: formatDecimal((request.baseAmount * request.benchmarkPrice) / 1_000_000n),
  worstPublicNotional: null,
  expectedWorseBps: "0",
  worstWorseBps: null,
  illustrative: null,
});

describe("sealed boxes and receipts", () => {
  it("round-trips a sealed box and rejects the wrong key", async () => {
    const engine = await generateEngineKeys();
    const other = await generateEngineKeys();
    const message = new TextEncoder().encode("side,size,limit");
    const sealed = await sealTo(message, engine.boxPublicKey);
    const opened = await openSeal(sealed, engine.boxPublicKey, engine.boxSecretKey);
    expect(new TextDecoder().decode(opened)).toBe("side,size,limit");
    await expect(openSeal(sealed, other.boxPublicKey, other.boxSecretKey)).rejects.toThrow(
      /could not be opened/,
    );
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(openSeal(tampered, engine.boxPublicKey, engine.boxSecretKey)).rejects.toThrow(
      /could not be opened/,
    );
  });

  it("proves inclusion for every leaf and rejects a swapped sibling", () => {
    const leaves = ["ada", "bo", "chi"];
    const tree = merkleTree(leaves);
    for (let index = 0; index < leaves.length; index += 1) {
      expect(verifyProof(leaves[index], tree.proofs[index], tree.root)).toBe(true);
    }
    const broken = tree.proofs[0].map((step, index) =>
      index === 0 ? { ...step, sibling: "ab".repeat(32) } : step,
    );
    expect(verifyProof(leaves[0], broken, tree.root)).toBe(false);
    expect(merkleTree([]).root).toBe(merkleTree([]).root);
  });

  it("crosses a scripted night, signs receipts, and keeps the book off the public record", async () => {
    const engine = await NightfillEngine.create({
      referencePrice: parseDecimal("3.5"),
      referenceSource: "test",
      quoter: fakeQuoter,
    });
    const result = await runScenario(engine);
    expect(result.batch.uniformPrice).toBe("3.5");
    expect(result.batch.matchedBase).toBe("8");
    expect(result.batch.routedBase).toBe("21");
    expect(result.batch.receiptCount).toBe(4);

    const ada = result.views.Ada.receipts[0];
    const verdict = await engine.verifyReceipt(ada);
    expect(verdict.signatureValid).toBe(true);
    expect(verdict.proofValid).toBe(true);

    const tampered = { ...ada.receipt, baseFilled: "3.1" };
    const bad = await engine.verifyReceipt({ ...ada, receipt: tampered });
    expect(bad.signatureValid).toBe(false);

    const swapped = {
      ...ada,
      merkleProof: ada.merkleProof.map((step, index) =>
        index === 0 ? { ...step, position: step.position === "left" ? "right" as const : "left" as const } : step,
      ),
    };
    if (ada.merkleProof.length > 0) {
      const proof = await engine.verifyReceipt(swapped);
      expect(proof.proofValid).toBe(false);
    }

    const pub = canonicalJson(engine.publicState());
    expect(pub).not.toContain(result.agents[0].pubkey);
    expect(pub).not.toContain(result.views.Ada.orders[0].limitPrice);
    expect(engine.publicState().batches[0].anchor.status).toBe("not_submitted");
  });

  it("serves a private agent view only with the demo session", async () => {
    const engine = await NightfillEngine.create({
      referencePrice: parseDecimal("3.5"),
      referenceSource: "test",
      quoter: fakeQuoter,
    });
    const http = await startHttp(engine, 0);
    try {
      const health = await fetch(`${http.url}/v1/health`);
      expect(health.status).toBe(200);
      const run = await fetch(`${http.url}/v1/demo/run`, { method: "POST" });
      expect(run.status).toBe(200);
      const body = (await run.json()) as {
        sessionToken: string;
        agents: Array<{ name: string; pubkey: string }>;
        batch: { merkleRoot: string };
      };
      const denied = await fetch(`${http.url}/v1/demo/agents/Noor`);
      expect(denied.status).toBe(401);
      const noor = await fetch(`${http.url}/v1/demo/agents/Noor`, {
        headers: { authorization: `Bearer ${body.sessionToken}` },
      });
      expect(noor.status).toBe(200);
      const privateView = (await noor.json()) as {
        orders: Array<{ side: string; routed: string; limitPrice: string }>;
        receipts: Array<{ signature: string }>;
      };
      expect(privateView.orders[0].side).toBe("sell");
      expect(privateView.orders[0].routed).toBe("6");
      expect(privateView.receipts[0].signature).toMatch(/^[0-9a-f]{128}$/);

      const pub = await fetch(`${http.url}/v1/public`);
      const publicBody = await pub.text();
      expect(publicBody).toContain("SIMULATED ATTESTATION");
      expect(publicBody).not.toContain(body.agents[0].pubkey);
      expect(publicBody).not.toContain(privateView.orders[0].limitPrice);
      expect(publicBody).toContain(body.batch.merkleRoot);
    } finally {
      await http.close();
    }
  });
});

describe("intents quote adapter", () => {
  it("always sends a dry quote and skips confidential mode without a JWT", async () => {
    const previous = process.env.ONECLICK_JWT;
    delete process.env.ONECLICK_JWT;
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          correlationId: "corr",
          quote: {
            amountIn: "6000000000000000000000000",
            amountOut: "19000000",
            minAmountIn: "6000000000000000000000000",
            minAmountOut: "18900000",
            amountInFormatted: "6",
            amountOutFormatted: "19",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    try {
      const summary = await requestIntentsQuote(
        {
          orderId: "noor",
          side: "sell",
          baseAmount: parseDecimal("6"),
          benchmarkPrice: parseDecimal("3.22"),
        },
        fetchImpl,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].dry).toBe(true);
      expect(calls[0].confidentiality).toBe("public");
      expect(calls[0].depositType).toBe("INTENTS");
      expect(calls[0].swapType).toBe("EXACT_INPUT");
      expect(summary.status).toBe("quoted");
      expect(summary.dry).toBe(true);
      expect(summary.illustrative).toBeNull();
      expect(Number(summary.expectedWorseBps)).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.ONECLICK_JWT;
      else process.env.ONECLICK_JWT = previous;
    }
  });

  it("falls back to a public dry quote when the confidential quote is refused", async () => {
    const previous = process.env.ONECLICK_JWT;
    process.env.ONECLICK_JWT = "test-jwt";
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { confidentiality: string; dry: boolean };
      expect(body.dry).toBe(true);
      if (calls === 1) {
        expect(body.confidentiality).toBe("basic");
        return new Response(JSON.stringify({ message: "auth required" }), { status: 401 });
      }
      expect(body.confidentiality).toBe("public");
      return new Response(
        JSON.stringify({
          correlationId: "corr",
          quote: {
            amountIn: "48451832",
            amountOut: "15000000000000000000000000",
            minAmountIn: "48209572",
            minAmountOut: "15000000000000000000000000",
            amountInFormatted: "48.451832",
            amountOutFormatted: "15",
          },
        }),
        { status: 200 },
      );
    };
    try {
      const summary = await requestIntentsQuote(
        {
          orderId: "chi",
          side: "buy",
          baseAmount: parseDecimal("15"),
          benchmarkPrice: parseDecimal("3.22"),
        },
        fetchImpl,
      );
      expect(calls).toBe(2);
      expect(summary.confidentiality).toBe("public");
      expect(summary.confidentialityNote).toMatch(/refused/i);
      expect(summary.expectedPublicNotional).toBe("48.209572");
    } finally {
      if (previous === undefined) delete process.env.ONECLICK_JWT;
      else process.env.ONECLICK_JWT = previous;
    }
  });

  it("builds a body that cannot execute", () => {
    const body = buildQuoteBody(
      {
        orderId: "x",
        side: "buy",
        baseAmount: parseDecimal("1"),
        benchmarkPrice: parseDecimal("3"),
      },
      "public",
      "nightfill.near",
      Date.parse("2026-11-14T12:00:00Z"),
    );
    expect(body.dry).toBe(true);
    expect(body.swapType).toBe("EXACT_OUTPUT");
    expect(body.amount).toBe("1000000000000000000000000");
  });

  it("labels the illustrative pool as worse than the dark print because of the fee", () => {
    const estimate = illustrativeSlippage("sell", parseDecimal("6"), parseDecimal("3.22"));
    expect(estimate.label).toMatch(/Not a live market/);
    expect(Number(estimate.worseBps)).toBeGreaterThan(0);
  });
});
