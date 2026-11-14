import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NightfillEngine, NightfillError } from "../core/engine.js";
import { runScenario, publicAgentCards } from "../demo/scenario.js";
import { viewAnchoredBatch } from "../near/anchor.js";
import type { Receipt } from "../core/types.js";
import type { ProofStep } from "../core/merkle.js";

type Session = {
  expiresAt: number;
  agents: Map<string, { pubkey: string; role: string; side: string; fallback: string }>;
};

const sessions = new Map<string, Session>();

export function startHttp(
  engine: NightfillEngine,
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      await route(engine, req, res);
    } catch (error) {
      const status = error instanceof NightfillError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal error";
      send(res, status, { error: message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}`,
        close: () =>
          new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

async function route(
  engine: NightfillEngine,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/v1/health") {
    send(res, 200, { ok: true, service: "nightfill", pair: "NEAR/USDC" });
    return;
  }
  if (method === "GET" && (path === "/v1/info" || path === "/v1/public")) {
    const attestation = await engine.attestation(url.searchParams.get("nonce") ?? undefined);
    send(res, 200, { ...engine.publicState(), attestation });
    return;
  }
  if (method === "GET" && path === "/v1/attestation") {
    send(res, 200, await engine.attestation(url.searchParams.get("nonce") ?? undefined));
    return;
  }
  if (method === "GET" && path === "/v1/batches") {
    send(res, 200, { batches: engine.publicState().batches });
    return;
  }
  if (method === "GET" && path.startsWith("/v1/batches/")) {
    const id = decodeURIComponent(path.slice("/v1/batches/".length));
    const batch = engine.publicState().batches.find((item) => item.batchId === id);
    if (!batch) return send(res, 404, { error: "batch not found" });
    send(res, 200, batch);
    return;
  }
  if (method === "POST" && path === "/v1/orders") {
    const body = await readJson(req);
    const result = await engine.submit(asRecord(body) as never);
    send(res, 200, result);
    return;
  }
  if (method === "POST" && path === "/v1/orders/cancel") {
    const result = await engine.cancel(asRecord(await readJson(req)) as never);
    send(res, 200, result);
    return;
  }
  if (method === "POST" && path === "/v1/me") {
    const result = await engine.privateView(asRecord(await readJson(req)) as never);
    send(res, 200, result);
    return;
  }
  if (method === "POST" && path === "/v1/batches/run") {
    send(res, 200, await engine.runBatch());
    return;
  }
  if (method === "POST" && path === "/v1/receipts/verify") {
    const body = asRecord(await readJson(req));
    const verdict = await engine.verifyReceipt({
      receipt: body.receipt as Receipt,
      signature: String(body.signature ?? ""),
      merkleProof: body.merkleProof as ProofStep[] | undefined,
      merkleRoot: typeof body.merkleRoot === "string" ? body.merkleRoot : undefined,
      signPublicKey: typeof body.signPublicKey === "string" ? body.signPublicKey : undefined,
    });
    const chain = body.receipt
      ? await viewAnchoredBatch((body.receipt as Receipt).batchId)
      : { checked: false, root: null, error: null, contractId: null };
    const rootMatches =
      chain.checked && chain.root && verdict.merkleRoot
        ? chain.root.toLowerCase() === verdict.merkleRoot.toLowerCase()
        : null;
    send(res, 200, { ...verdict, chain: { ...chain, rootMatches } });
    return;
  }
  if (method === "POST" && path === "/v1/demo/run") {
    const result = await runScenario(engine);
    const token = randomBytes(32).toString("hex");
    const cards = publicAgentCards(result);
    sessions.set(token, {
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
      agents: new Map(
        cards.map((card) => [
          card.name,
          { pubkey: card.pubkey, role: card.role, side: card.side, fallback: card.fallback },
        ]),
      ),
    });
    send(res, 200, {
      sessionToken: token,
      agents: cards,
      batch: result.batch,
      lines: result.lines,
      signPublicKey: engine.signPublicKeyHex,
    });
    return;
  }
  if (method === "GET" && path === "/v1/demo/agents") {
    const session = requireSession(req);
    send(res, 200, {
      agents: [...session.agents.entries()].map(([name, agent]) => ({ name, ...agent })),
    });
    return;
  }
  if (method === "GET" && path.startsWith("/v1/demo/agents/")) {
    const session = requireSession(req);
    const name = decodeURIComponent(path.slice("/v1/demo/agents/".length));
    const agent = session.agents.get(name);
    if (!agent) return send(res, 404, { error: "that demo agent is not in this session" });
    send(res, 200, { name, role: agent.role, ...engine.viewAgent(agent.pubkey) });
    return;
  }

  send(res, 404, { error: "not found" });
}

function requireSession(req: IncomingMessage): Session {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    throw new NightfillError("demo session is missing or expired", 401);
  }
  return session;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 262_144) throw new NightfillError("body too large", 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new NightfillError("invalid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NightfillError("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

export function newDemoId(): string {
  return randomUUID();
}
