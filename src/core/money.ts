export const SCALE = 1_000_000n;
export const PAIR = "NEAR/USDC" as const;

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

export function parseDecimal(input: string, scale = SCALE): bigint {
  const trimmed = input.trim();
  const match = DECIMAL.exec(trimmed);
  if (!match) {
    throw new Error(`invalid decimal "${input}"`);
  }
  const fraction = match[2] ?? "";
  if (fraction.length > 6) {
    throw new Error(`"${input}" has more than 6 decimal places`);
  }
  const whole = BigInt(match[1]);
  const frac = BigInt(fraction.padEnd(6, "0") || "0");
  return whole * scale + frac;
}

export function formatDecimal(value: bigint, scale = SCALE): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(6, "0").replace(/0+$/, "");
  const text = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${text}` : text;
}

export function microNearToYocto(micro: bigint): string {
  return (micro * 10n ** 18n).toString();
}
