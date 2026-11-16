// Estimated cost at API list price, from LiteLLM's public price file (cached for 7 days).
// Unknown model: null, and the UI says "n/a" instead of inventing a number.
import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import type { Tokens } from "./parse";

const URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
type Price = { input_cost_per_token?: number; output_cost_per_token?: number; cache_read_input_token_cost?: number; cache_creation_input_token_cost?: number };
let table: Record<string, Price> = {};

export async function loadPrices(home: string) {
  const file = join(home, "prices.json");
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < 7 * 86400e3;
  if (existsSync(file)) try { table = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (fresh) return;
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(15000) });
    if (r.ok) { const txt = await r.text(); table = JSON.parse(txt); writeFileSync(file, txt); }
  } catch { /* offline: keep the cached table */ }
}

export function priceFor(model: string): Price | null {
  if (!model) return null;
  const m = model.replace(/^(anthropic|openai)\//, "");
  const tries = [m, "anthropic/" + m, "openai/" + m, m.replace(/-\d{8}$/, ""), m.replace(/\[.*\]$/, "")];
  for (const k of tries) if (table[k]?.input_cost_per_token != null) return table[k];
  return null;
}

export function costOf(model: string, t: Tokens): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const inp = p.input_cost_per_token ?? 0;
  return t.input * inp + t.output * (p.output_cost_per_token ?? 0)
    + t.cache_read * (p.cache_read_input_token_cost ?? inp * 0.1)
    + t.cache_write * (p.cache_creation_input_token_cost ?? inp * 1.25);
}

export function setTableForTest(t: Record<string, Price>) { table = t; }
