// Per-run Anthropic cost accounting for the ingest pipeline. The turn-cost hook
// measures the Claude Code conversation; these calls bill separately, so this
// gives the only visibility into ingest inference spend.

// W63 — `| null` because that is what the SDK's own `Usage` declares for the two cache counters:
// absent on a non-cached call, not zero. Callers pass `message.usage` straight through, so a
// number-or-undefined-only shape rejected every real call site — invisible until scripts/ was
// type-checked.
export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

// List prices, USD per 1M tokens: [input, output, cacheWrite(5m), cacheRead], for the models
// `inference.config.json` configures, checked against the vendor's published list on 2026-09-21.
//
// Matched by FAMILY substring so dated/aliased ids both resolve, which means a price here is only
// right for as long as the family's current model carries it: Opus was $15/$75 through 4.1 and is
// $5/$25 from 4.5 on, and this table billed every Opus call at the old price until that was caught.
// Re-check it when a feature moves to a new generation — `tests/unit/inference-cost.test.ts` pins
// that every configured model still resolves to a row, not that the row is current.
const PRICES: { match: string; in: number; out: number; cw: number; cr: number }[] = [
  { match: "opus", in: 5, out: 25, cw: 6.25, cr: 0.5 },
  { match: "sonnet", in: 3, out: 15, cw: 3.75, cr: 0.3 },
  { match: "haiku", in: 1, out: 5, cw: 1.25, cr: 0.1 },
];

function priceFor(model: string) {
  return PRICES.find((p) => model.toLowerCase().includes(p.match)) ?? null;
}

export function costOf(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  if (!p) return 0;
  const M = 1_000_000;
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.output_tokens ?? 0) * p.out +
      (u.cache_creation_input_tokens ?? 0) * p.cw +
      (u.cache_read_input_tokens ?? 0) * p.cr) /
    M
  );
}

interface Tally {
  calls: number;
  input: number;
  output: number;
  cw: number;
  cr: number;
  cost: number;
}

export class UsageAccumulator {
  private byModel = new Map<string, Tally>();

  record(model: string, u: TokenUsage | null | undefined): void {
    if (!u) return;
    const t = this.byModel.get(model) ?? { calls: 0, input: 0, output: 0, cw: 0, cr: 0, cost: 0 };
    t.calls += 1;
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cw += u.cache_creation_input_tokens ?? 0;
    t.cr += u.cache_read_input_tokens ?? 0;
    t.cost += costOf(model, u);
    this.byModel.set(model, t);
  }

  totalCost(): number {
    let c = 0;
    for (const t of this.byModel.values()) c += t.cost;
    return c;
  }

  // Multi-line summary, or empty string if nothing was recorded.
  summary(mode?: string): string {
    if (this.byModel.size === 0) return "";
    const lines: string[] = [`Inference cost${mode ? ` (${mode} mode)` : ""}:`];
    for (const [model, t] of this.byModel) {
      lines.push(
        `  ${model}: ${t.calls} call(s) · in ${t.input} · cache-w ${t.cw} · cache-r ${t.cr} · out ${t.output} tok · $${t.cost.toFixed(4)}`,
      );
    }
    lines.push(`  total: $${this.totalCost().toFixed(4)}`);
    return lines.join("\n");
  }
}
