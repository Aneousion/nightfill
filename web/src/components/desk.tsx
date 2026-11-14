"use client";

import { useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AgentView, DemoRun, PublicState, RouteSummary, VerifyResult } from "@/lib/types";

const STORAGE_KEY = "nightfill.demo.v1";

type StoredDemo = {
  token: string;
  lines: string[];
  agents: DemoRun["agents"];
  selected: string;
};

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { error?: string }) : {};
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `The engine returned HTTP ${response.status}`);
  }
  return body as T;
}

function shortHash(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function slippageText(route: RouteSummary): string {
  if (route.status !== "quoted" || route.expectedWorseBps === null || route.expectedPublicNotional === null) {
    if (route.illustrative) {
      return `The live quote failed (${route.error ?? "no detail"}). An illustrative 50,000 NEAR pool with a 30 bps fee would be ${route.illustrative.worseBps} bps worse, at ${route.illustrative.publicNotional} USDC. That figure is not a 1Click quote.`;
    }
    return `The live quote failed. ${route.error ?? ""}`;
  }
  const bps = Number(route.expectedWorseBps);
  const relation = bps > 0 ? "worse" : bps < 0 ? "better" : "flat";
  return `NEAR Intents would ${relation === "flat" ? "match" : `be ${Math.abs(bps)} bps ${relation} than`} the dark print: ${route.expectedPublicNotional} USDC against ${route.darkNotional} USDC. Worst case inside the quote tolerance is ${route.worstWorseBps ?? "unknown"} bps. Dry quote, no funds moved.`;
}

export function Desk() {
  const [state, setState] = useState<PublicState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [demo, setDemo] = useState<StoredDemo | null>(null);
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [receiptText, setReceiptText] = useState("");
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [running, startRun] = useTransition();
  const [checking, startCheck] = useTransition();

  useEffect(() => {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      setDemo(JSON.parse(raw) as StoredDemo);
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await getJson<PublicState>("/engine/v1/public");
        if (!cancelled) {
          setState(next);
          setLoadError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "The engine is not answering.");
        }
      }
    }
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!demo) return;
    const controller = new AbortController();
    setAgentError(null);
    void getJson<AgentView>(`/engine/v1/demo/agents/${encodeURIComponent(demo.selected)}`, {
      headers: { authorization: `Bearer ${demo.token}` },
      signal: controller.signal,
    })
      .then((view) => setAgent(view))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAgent(null);
        setAgentError(error instanceof Error ? error.message : "Could not open that agent's view.");
      });
    return () => controller.abort();
  }, [demo]);

  function selectAgent(name: string) {
    if (!demo) return;
    const next = { ...demo, selected: name };
    setDemo(next);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setVerify(null);
  }

  function runNight() {
    setDemoError(null);
    startRun(async () => {
      try {
        const result = await getJson<DemoRun>("/engine/v1/demo/run", { method: "POST" });
        const stored: StoredDemo = {
          token: result.sessionToken,
          lines: result.lines,
          agents: result.agents,
          selected: "Ada",
        };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        setDemo(stored);
        setState((current) => {
          if (!current || current.batches.some((batch) => batch.batchId === result.batch.batchId)) {
            return current;
          }
          return { ...current, batches: [...current.batches, result.batch] };
        });
      } catch (error) {
        setDemoError(error instanceof Error ? error.message : "The cross failed.");
      }
    });
  }

  function loadReceipt() {
    const bundle = agent?.receipts.at(-1);
    if (!bundle) return;
    setReceiptText(JSON.stringify({ receipt: bundle.receipt, signature: bundle.signature, merkleProof: bundle.merkleProof, merkleRoot: bundle.merkleRoot }, null, 2));
    setVerify(null);
    setVerifyError(null);
  }

  function checkReceipt(raw: string) {
    setVerifyError(null);
    startCheck(async () => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const result = await getJson<VerifyResult>("/engine/v1/receipts/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed),
        });
        setVerify(result);
      } catch (error) {
        setVerify(null);
        setVerifyError(error instanceof Error ? error.message : "Could not verify that receipt.");
      }
    });
  }

  function tamper() {
    if (!receiptText) return;
    try {
      const parsed = JSON.parse(receiptText) as { receipt?: { baseFilled?: string } };
      if (!parsed.receipt?.baseFilled) throw new Error("Load a receipt first.");
      parsed.receipt.baseFilled = `${parsed.receipt.baseFilled}9`;
      const next = JSON.stringify(parsed, null, 2);
      setReceiptText(next);
      checkReceipt(next);
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "Could not tamper with that JSON.");
    }
  }

  const latest = state?.batches.at(-1) ?? null;

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 md:px-8 md:py-10">
      <header className="flex flex-col gap-6 border-b border-border pb-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">NEAR / USDC</p>
          <h1 className="display mt-1 text-5xl leading-none text-foreground md:text-6xl">Nightfill</h1>
          <p className="mt-3 max-w-md text-sm text-muted-foreground">
            Agents seal orders. A matcher crosses them at one price. The chain publishes a root, not a book.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 md:items-end">
          <Badge variant="warning">mock attestation</Badge>
          <p className="text-sm text-muted-foreground">
            Reference {state?.referencePrice ?? "—"} USDC
            <span className="block text-xs">{state?.referenceSource ?? "waiting for the engine"}</span>
          </p>
          <Button type="button" onClick={runNight} disabled={running}>
            {running ? "Crossing…" : "Cross four agents"}
          </Button>
        </div>
      </header>

      {demoError ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {demoError}
        </p>
      ) : null}
      {loadError && state ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          The engine stopped answering. {loadError}
        </p>
      ) : null}

      {loadError && !state ? (
        <section role="alert" className="mt-8 border border-destructive/40 bg-card p-5">
          <h2 className="text-lg">The matching engine is not answering.</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            From the repo root, run <code className="text-foreground">npm run dev</code>. This page reads the engine through <code className="text-foreground">/engine</code>.
          </p>
          <p className="mt-2 text-sm text-destructive">{loadError}</p>
        </section>
      ) : null}

      {!state && !loadError ? (
        <div className="mt-8 space-y-3" aria-busy="true">
          <p className="text-sm text-muted-foreground">Reading the public record…</p>
          <div className="h-24 animate-pulse bg-muted" />
          <div className="h-24 animate-pulse bg-muted" />
        </div>
      ) : null}

      {state ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <section className="min-w-0 border border-border bg-card p-4 md:p-5" aria-labelledby="chain-heading">
            <h2 id="chain-heading" className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              What the chain sees
            </h2>
            {latest ? (
              <div className="mt-4 space-y-5">
                <p className="display text-4xl text-primary">{latest.uniformPrice ?? "no cross"}</p>
                <p className="text-xs text-muted-foreground">uniform price, USDC per NEAR</p>
                <dl className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-[11px] uppercase tracking-widest text-muted-foreground">Matched</dt>
                    <dd className="mt-1">{latest.matchedBase} NEAR</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-widest text-muted-foreground">Routed</dt>
                    <dd className="mt-1">{latest.routedBase} NEAR</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-widest text-muted-foreground">Receipts</dt>
                    <dd className="mt-1">{latest.receiptCount}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-widest text-muted-foreground">Orders in the batch</dt>
                    <dd className="mt-1">{latest.ordersConsidered} counted, none shown</dd>
                  </div>
                </dl>
                <CopyValue label="Merkle root" value={latest.merkleRoot} />
                <CopyValue label="Code measurement" value={latest.codeMeasurement} />
                <p className="text-sm text-muted-foreground">
                  {latest.anchor.status === "submitted" && latest.anchor.explorerUrl ? (
                    <a className="text-primary underline" href={latest.anchor.explorerUrl}>
                      Anchored on NEAR testnet
                    </a>
                  ) : (
                    <>Anchor: {latest.anchor.status}. {latest.anchor.reason}</>
                  )}
                </p>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                No batch yet. Sealed orders can sit in the engine and the chain still has nothing to publish. {state.ordersAccepted} orders have been accepted. {state.ordersOpen} still rest. The counts are public. The orders are not.
              </p>
            )}
            <div className="mt-6 border border-dashed border-amber/70 p-3 text-sm">
              <p className="text-amber">Simulated TEE. Not a hardware quote.</p>
              <p className="mt-2 text-muted-foreground">{state.attestation.warning}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Measurement {shortHash(state.attestation.codeMeasurement)} over {state.attestation.measuredFiles.length} engine files. Signed by the receipt key, which only proves this process wrote the document.
              </p>
            </div>
          </section>

          <section className="min-w-0 border border-border bg-card p-4 md:p-5" aria-labelledby="agent-heading">
            <h2 id="agent-heading" className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              What one agent sees
            </h2>
            {demo ? (
              <>
                <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Scripted agents">
                  {demo.agents.map((card) => (
                    <Button
                      key={card.name}
                      type="button"
                      size="sm"
                      variant={card.name === demo.selected ? "default" : "outline"}
                      onClick={() => selectAgent(card.name)}
                      aria-pressed={card.name === demo.selected}
                    >
                      {card.name}
                    </Button>
                  ))}
                </div>
                {agentError ? (
                  <p role="alert" className="mt-4 text-sm text-destructive">
                    {agentError} Run the cross again if the engine was restarted. The session lives in this browser only.
                  </p>
                ) : null}
                {!agent && !agentError ? <p className="mt-4 text-sm text-muted-foreground">Opening the private view…</p> : null}
                {agent ? <AgentBody agent={agent} onLoad={loadReceipt} /> : null}
              </>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                This column stays empty until you run the night. Four scripted agents will seal orders. You then open one of them. A stranger calling the public API does not get this view.
              </p>
            )}
          </section>
        </div>
      ) : null}

      <section className="mt-4 border border-border bg-card p-4 md:p-5" aria-labelledby="verify-heading">
        <h2 id="verify-heading" className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
          Check a receipt without the book
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Paste a fill receipt. The signature is the engine key. The Merkle proof ties it to a batch root. Neither check needs anyone else's order.
        </p>
        <label className="mt-4 block text-xs text-muted-foreground" htmlFor="receipt">
          Receipt JSON
        </label>
        <Textarea
          id="receipt"
          className="mt-2 font-mono text-xs"
          value={receiptText}
          onChange={(event) => setReceiptText(event.target.value)}
          placeholder='{"receipt": { ... }, "signature": "...", "merkleProof": [], "merkleRoot": "..."}'
          spellCheck={false}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" onClick={() => checkReceipt(receiptText)} disabled={checking || receiptText.length === 0}>
            {checking ? "Checking…" : "Verify"}
          </Button>
          <Button type="button" variant="outline" onClick={tamper} disabled={receiptText.length === 0}>
            Flip a digit
          </Button>
        </div>
        {verifyError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {verifyError}
          </p>
        ) : null}
        {verify ? (
          <div className="mt-3 flex flex-wrap gap-2" aria-live="polite">
            <Badge variant={verify.signatureValid ? "good" : "bad"}>
              signature {verify.signatureValid ? "valid" : "invalid"}
            </Badge>
            <Badge variant={verify.proofValid ? "good" : "bad"}>
              inclusion {verify.proofValid === null ? "not checked" : verify.proofValid ? "valid" : "invalid"}
            </Badge>
            {verify.chain.checked ? (
              <Badge variant={verify.chain.rootMatches ? "good" : "bad"}>
                testnet root {verify.chain.rootMatches ? "matches" : "does not match"}
              </Badge>
            ) : (
              <Badge variant="outline">testnet root not queried</Badge>
            )}
          </div>
        ) : null}
      </section>

      {demo && demo.lines.length > 0 ? (
        <details className="mt-4 border border-border p-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Script log. This is the operator who launched the four agents, not the public chain.
          </summary>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-foreground">
            {demo.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </details>
      ) : null}

      <footer className="mt-8 flex flex-col gap-1 text-xs text-muted-foreground md:flex-row md:justify-between">
        <p>built at NEAR HACKATHON</p>
        <p>Seal key {state ? shortHash(state.boxPublicKey) : "—"}</p>
      </footer>
    </main>
  );
}

function AgentBody({ agent, onLoad }: { agent: AgentView; onLoad: () => void }) {
  const order = agent.orders.at(-1);
  const bundle = agent.receipts.at(-1);
  if (!order) return <p className="mt-4 text-sm text-muted-foreground">This agent has no order in the current book.</p>;
  return (
    <div className="mt-4 space-y-4 text-sm">
      <p className="text-muted-foreground">{agent.role}</p>
      <p>
        <span className="text-primary">{order.side}</span> {order.size} NEAR, limit {order.limitPrice} USDC
        {order.bandLow && order.bandHigh ? `, band ${order.bandLow}–${order.bandHigh}` : ""}. Minimum fill {order.minFill}. Fallback {order.fallback}.
      </p>
      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-[11px] uppercase tracking-widest text-muted-foreground">Filled</dt>
          <dd>{order.filled}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-widest text-muted-foreground">Routed</dt>
          <dd>{order.routed}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-widest text-muted-foreground">Resting</dt>
          <dd>{order.remaining}</dd>
        </div>
      </dl>
      {bundle ? (
        <>
          {bundle.receipt.kind === "route" ? (
          <p>
            No dark fill. This order was quoted out. The batch cleared other orders
            {bundle.receipt.uniformPrice ? ` at ${bundle.receipt.uniformPrice}` : ""}.
          </p>
        ) : (
          <p>
            Receipt {bundle.receipt.kind}. Filled {bundle.receipt.baseFilled} NEAR for {bundle.receipt.quoteFilled} USDC
            {bundle.receipt.uniformPrice ? ` at ${bundle.receipt.uniformPrice}` : ""}.
          </p>
        )}
          {bundle.receipt.route ? <p className="text-muted-foreground">{slippageText(bundle.receipt.route)}</p> : null}
          {bundle.receipt.route ? <p className="text-xs text-muted-foreground">{bundle.receipt.route.confidentialityNote}</p> : null}
          <Button type="button" size="sm" variant="outline" onClick={onLoad}>
            Load this receipt into the checker
          </Button>
        </>
      ) : (
        <p className="text-muted-foreground">No receipt yet. Resting orders do not get one until something happens to them.</p>
      )}
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="block max-w-full text-left"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span className="block text-[11px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="mt-1 block break-all font-mono text-sm">
        {shortHash(value)} <span className="text-xs text-muted-foreground">{copied ? "copied" : "copy"}</span>
      </span>
    </button>
  );
}
