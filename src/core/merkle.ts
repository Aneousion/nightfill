import { sha256 } from "./codec.js";

export type ProofStep = {
  sibling: string;
  position: "left" | "right";
};

const EMPTY_LABEL = "nightfill-empty-batch";

export function leafHash(canonical: string): Buffer {
  return sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(canonical)]));
}

export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

export function emptyRoot(): string {
  return sha256(EMPTY_LABEL).toString("hex");
}

export function merkleTree(canonicalLeaves: string[]): {
  root: string;
  proofs: ProofStep[][];
} {
  if (canonicalLeaves.length === 0) {
    return { root: emptyRoot(), proofs: [] };
  }

  const proofs: ProofStep[][] = canonicalLeaves.map(() => []);
  let nodes = canonicalLeaves.map((leaf) => leafHash(leaf));
  let indexOf = new Map<number, number>();
  canonicalLeaves.forEach((_, index) => indexOf.set(index, index));

  while (nodes.length > 1) {
    const next: Buffer[] = [];
    const nextIndex = new Map<number, number>();
    for (let i = 0; i < nodes.length; i += 2) {
      const position = next.length;
      if (i + 1 === nodes.length) {
        next.push(nodes[i]);
        for (const [origin, at] of indexOf) {
          if (at === i) nextIndex.set(origin, position);
        }
        continue;
      }
      next.push(nodeHash(nodes[i], nodes[i + 1]));
      for (const [origin, at] of indexOf) {
        if (at === i) {
          proofs[origin].push({
            sibling: nodes[i + 1].toString("hex"),
            position: "right",
          });
          nextIndex.set(origin, position);
        } else if (at === i + 1) {
          proofs[origin].push({
            sibling: nodes[i].toString("hex"),
            position: "left",
          });
          nextIndex.set(origin, position);
        }
      }
    }
    nodes = next;
    indexOf = nextIndex;
  }

  return { root: nodes[0].toString("hex"), proofs };
}

export function verifyProof(
  canonical: string,
  proof: ProofStep[],
  root: string,
): boolean {
  let hash = leafHash(canonical);
  for (const step of proof) {
    if (!/^[0-9a-f]{64}$/i.test(step.sibling)) return false;
    const sibling = Buffer.from(step.sibling, "hex");
    hash =
      step.position === "right"
        ? nodeHash(hash, sibling)
        : nodeHash(sibling, hash);
  }
  return hash.toString("hex") === root.toLowerCase();
}
