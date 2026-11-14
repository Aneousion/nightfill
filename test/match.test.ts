import { describe, expect, it } from "vitest";
import { formatDecimal, parseDecimal } from "../src/core/money.js";
import { matchOrders, type MatchOrder } from "../src/core/match.js";

const now = 1_700_000_000_000;

function order(partial: Partial<MatchOrder> & Pick<MatchOrder, "orderId" | "side" | "remaining" | "limitPrice">): MatchOrder {
  return {
    bandLow: null,
    bandHigh: null,
    minFill: 0n,
    expiryMs: now + 60_000,
    sequence: 1,
    ...partial,
  };
}

describe("uniform price matching", () => {
  it("clears at the reference when it sits inside the cross", () => {
    const result = matchOrders(
      [
        order({ orderId: "buy", side: "buy", remaining: parseDecimal("5"), limitPrice: parseDecimal("4"), sequence: 1 }),
        order({ orderId: "sell", side: "sell", remaining: parseDecimal("5"), limitPrice: parseDecimal("3"), sequence: 2 }),
      ],
      parseDecimal("3.5"),
      now,
    );
    expect(formatDecimal(result.price!)).toBe("3.5");
    expect(result.fills).toHaveLength(2);
  });

  it("moves to the nearest feasible price when the reference is outside the cross", () => {
    const result = matchOrders(
      [
        order({ orderId: "buy", side: "buy", remaining: parseDecimal("5"), limitPrice: parseDecimal("3"), sequence: 1 }),
        order({ orderId: "sell", side: "sell", remaining: parseDecimal("5"), limitPrice: parseDecimal("2.5"), sequence: 2 }),
      ],
      parseDecimal("4"),
      now,
    );
    expect(formatDecimal(result.price!)).toBe("3");
    expect(result.fills.map((fill) => formatDecimal(fill.baseFilled))).toEqual(["5", "5"]);
  });

  it("does not invent a cross when limits do not overlap", () => {
    const result = matchOrders(
      [
        order({ orderId: "buy", side: "buy", remaining: parseDecimal("5"), limitPrice: parseDecimal("3") }),
        order({ orderId: "sell", side: "sell", remaining: parseDecimal("5"), limitPrice: parseDecimal("4") }),
      ],
      parseDecimal("3.5"),
      now,
    );
    expect(result.price).toBeNull();
    expect(result.fills).toEqual([]);
  });

  it("fills the heavy side pro-rata, including a leftover micro unit", () => {
    const result = matchOrders(
      [
        order({ orderId: "a", side: "buy", remaining: parseDecimal("12"), limitPrice: parseDecimal("4"), sequence: 1 }),
        order({ orderId: "b", side: "buy", remaining: parseDecimal("20"), limitPrice: parseDecimal("4"), sequence: 2 }),
        order({ orderId: "s", side: "sell", remaining: parseDecimal("8"), limitPrice: parseDecimal("3"), sequence: 3 }),
      ],
      parseDecimal("3.4"),
      now,
    );
    const byId = Object.fromEntries(result.fills.map((fill) => [fill.orderId, formatDecimal(fill.baseFilled)]));
    expect(byId).toEqual({ a: "3", b: "5", s: "8" });

    const dusty = matchOrders(
      [
        order({ orderId: "a", side: "buy", remaining: parseDecimal("1"), limitPrice: parseDecimal("4"), sequence: 1 }),
        order({ orderId: "b", side: "buy", remaining: parseDecimal("2"), limitPrice: parseDecimal("4"), sequence: 2 }),
        order({ orderId: "s", side: "sell", remaining: parseDecimal("1"), limitPrice: parseDecimal("3"), sequence: 3 }),
      ],
      parseDecimal("3.4"),
      now,
    );
    const filled = dusty.fills
      .filter((fill) => fill.orderId !== "s")
      .reduce((sum, fill) => sum + fill.baseFilled, 0n);
    expect(filled).toBe(parseDecimal("1"));
  });

  it("drops a fill under minFill and gives the size to the other order", () => {
    const result = matchOrders(
      [
        order({ orderId: "picky", side: "buy", remaining: parseDecimal("10"), limitPrice: parseDecimal("4"), minFill: parseDecimal("6"), sequence: 1 }),
        order({ orderId: "easy", side: "buy", remaining: parseDecimal("10"), limitPrice: parseDecimal("4"), minFill: parseDecimal("1"), sequence: 2 }),
        order({ orderId: "sell", side: "sell", remaining: parseDecimal("10"), limitPrice: parseDecimal("3"), sequence: 3 }),
      ],
      parseDecimal("3.4"),
      now,
    );
    const byId = Object.fromEntries(result.fills.map((fill) => [fill.orderId, formatDecimal(fill.baseFilled)]));
    expect(byId.picky).toBeUndefined();
    expect(byId.easy).toBe("10");
    expect(byId.sell).toBe("10");
  });

  it("ignores an expired order and respects a price band", () => {
    const expired = matchOrders(
      [
        order({ orderId: "buy", side: "buy", remaining: parseDecimal("2"), limitPrice: parseDecimal("4") }),
        order({ orderId: "sell", side: "sell", remaining: parseDecimal("2"), limitPrice: parseDecimal("3"), expiryMs: now }),
      ],
      parseDecimal("3.5"),
      now,
    );
    expect(expired.price).toBeNull();

    const banded = matchOrders(
      [
        order({
          orderId: "buy",
          side: "buy",
          remaining: parseDecimal("4"),
          limitPrice: parseDecimal("3.5"),
          bandLow: parseDecimal("3"),
          bandHigh: parseDecimal("3.2"),
        }),
        order({
          orderId: "sell",
          side: "sell",
          remaining: parseDecimal("4"),
          limitPrice: parseDecimal("3"),
          bandLow: parseDecimal("3"),
          bandHigh: parseDecimal("3.4"),
        }),
      ],
      parseDecimal("3.4"),
      now,
    );
    expect(formatDecimal(banded.price!)).toBe("3.2");
  });
});
