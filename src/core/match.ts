export type Side = "buy" | "sell";

export type MatchOrder = {
  orderId: string;
  side: Side;
  remaining: bigint;
  limitPrice: bigint;
  bandLow: bigint | null;
  bandHigh: bigint | null;
  minFill: bigint;
  expiryMs: number;
  sequence: number;
};

export type FillAllocation = {
  orderId: string;
  baseFilled: bigint;
};

export type MatchResult = {
  price: bigint | null;
  fills: FillAllocation[];
};

export function eligible(order: MatchOrder, price: bigint, now: number): boolean {
  if (order.expiryMs <= now || order.remaining <= 0n || price <= 0n) return false;
  if (order.bandLow !== null && price < order.bandLow) return false;
  if (order.bandHigh !== null && price > order.bandHigh) return false;
  return order.side === "buy" ? price <= order.limitPrice : price >= order.limitPrice;
}

function volumeAt(orders: MatchOrder[], price: bigint, now: number): bigint {
  let buy = 0n;
  let sell = 0n;
  for (const order of orders) {
    if (!eligible(order, price, now)) continue;
    if (order.side === "buy") buy += order.remaining;
    else sell += order.remaining;
  }
  return buy < sell ? buy : sell;
}

function closestPrice(candidates: bigint[], reference: bigint): bigint {
  return candidates.reduce((best, price) => {
    const bestDistance = best > reference ? best - reference : reference - best;
    const distance = price > reference ? price - reference : reference - price;
    if (distance < bestDistance) return price;
    if (distance > bestDistance) return best;
    return price < best ? price : best;
  });
}

function choosePrice(
  orders: MatchOrder[],
  reference: bigint,
  now: number,
): bigint | null {
  const candidates = new Set<bigint>([reference]);
  for (const order of orders) {
    if (order.expiryMs <= now || order.remaining <= 0n) continue;
    candidates.add(order.limitPrice);
    if (order.bandLow !== null) candidates.add(order.bandLow);
    if (order.bandHigh !== null) candidates.add(order.bandHigh);
  }

  let bestVolume = 0n;
  const atBest: bigint[] = [];
  for (const price of candidates) {
    if (price <= 0n) continue;
    const volume = volumeAt(orders, price, now);
    if (volume > bestVolume) {
      bestVolume = volume;
      atBest.length = 0;
      atBest.push(price);
    } else if (volume === bestVolume && volume > 0n) {
      atBest.push(price);
    }
  }
  if (bestVolume === 0n) return null;
  return closestPrice(atBest, reference);
}

function allocate(orders: MatchOrder[], exec: bigint): Map<string, bigint> {
  const total = orders.reduce((sum, order) => sum + order.remaining, 0n);
  const fills = new Map<string, bigint>();
  const sorted = [...orders].sort((a, b) =>
    a.sequence - b.sequence || a.orderId.localeCompare(b.orderId),
  );
  let used = 0n;
  for (const order of sorted) {
    const fill = (exec * order.remaining) / total;
    fills.set(order.orderId, fill);
    used += fill;
  }
  let dust = exec - used;
  for (const order of sorted) {
    if (dust === 0n) break;
    const room = order.remaining - (fills.get(order.orderId) ?? 0n);
    if (room <= 0n) continue;
    const add = dust < room ? dust : room;
    fills.set(order.orderId, (fills.get(order.orderId) ?? 0n) + add);
    dust -= add;
  }
  return fills;
}

/**
 * Uniform-price cross. Among prices that maximize matched size, pick the one
 * closest to the reference. The reference itself wins when it is inside that
 * set. Buys pay at most their limit. Sells receive at least their limit.
 * A band, when set, must contain the clearing price. Fills below minFill are
 * dropped and the cross is recomputed. The heavy side is filled pro-rata.
 */
export function matchOrders(
  orders: MatchOrder[],
  reference: bigint,
  now: number,
): MatchResult {
  let active = orders.filter((order) => order.remaining > 0n && order.expiryMs > now);
  for (let attempt = 0; attempt < active.length + 2; attempt += 1) {
    const price = choosePrice(active, reference, now);
    if (price === null) return { price: null, fills: [] };
    const buys = active.filter((order) => order.side === "buy" && eligible(order, price, now));
    const sells = active.filter((order) => order.side === "sell" && eligible(order, price, now));
    const buyVolume = buys.reduce((sum, order) => sum + order.remaining, 0n);
    const sellVolume = sells.reduce((sum, order) => sum + order.remaining, 0n);
    const exec = buyVolume < sellVolume ? buyVolume : sellVolume;
    if (exec === 0n) return { price: null, fills: [] };

    const buyFills = allocate(buys, exec);
    const sellFills = allocate(sells, exec);
    const blocked = new Set<string>();
    for (const order of [...buys, ...sells]) {
      const fill = (order.side === "buy" ? buyFills : sellFills).get(order.orderId) ?? 0n;
      if (fill > 0n && fill < order.minFill) blocked.add(order.orderId);
    }
    if (blocked.size === 0) {
      const fills: FillAllocation[] = [];
      for (const [orderId, baseFilled] of [...buyFills, ...sellFills]) {
        if (baseFilled > 0n) fills.push({ orderId, baseFilled });
      }
      return { price, fills };
    }
    const next = active.filter((order) => !blocked.has(order.orderId));
    if (next.length === active.length) return { price: null, fills: [] };
    active = next;
  }
  return { price: null, fills: [] };
}
