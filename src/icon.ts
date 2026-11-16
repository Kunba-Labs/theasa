// Find a project's own icon in its repo.
// Order: native app icon, apple-touch-icon, large PNG icons, icons a page links, SVG marks, favicons.
// Framework placeholders (Rails red circle, Vite, React logos) are skipped.
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, dirname, extname, basename } from "path";
import { createHash } from "crypto";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "tmp", "vendor", "Pods", ".claude", ".next", ".nuxt",
  "coverage", "storybook-static", "mini-sites", "mini-sites-source", "fixtures", "test", "tests", "spec",
  "DerivedData", ".venv", "venv", "target", "intermediates", "cache", ".cache", "contracts", "lib",
]);
const PLACEHOLDER_SHA = new Set([
  "2e29c62b03e514c5a15f289f8fdc0abca6e22d0e91970503c9e2b7e0552c911c", // Rails 8 public/icon.png
  "4a748afd443918bb16591c834c401dae33e87861ab5dbad0811c3a3b4a9214fb", // Vite vite.svg
]);
const MIME: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".webp": "image/webp" };

export function score(rel: string): number {
  const n = basename(rel).toLowerCase();
  if (/appicon\.appiconset\/.*1024/i.test(rel) || n === "app_icon_1024.png") return 100;
  if (n.startsWith("apple-touch-icon") && n.endsWith(".png")) return 90;
  if (/^(icon|icon-512|icon-192|android-chrome-512x512|android-chrome-192x192)\.png$/i.test(n)) return 80;
  if (/^(icon|favicon|logo-mark|mark)\.svg$/.test(n)) return 70;
  if (/^favicon(-\d+(x\d+)?)?\.png$/.test(n)) return 60 + Math.min(9, (Number(n.match(/\d+/)?.[0] ?? 0) / 64) | 0);
  if (n === "favicon.ico") return 40;
  return 0;
}

function isPlaceholder(buf: Buffer, path: string): boolean {
  if (PLACEHOLDER_SHA.has(createHash("sha256").update(buf).digest("hex"))) return true;
  if (path.endsWith(".svg")) {
    const s = buf.toString("utf8");
    if (/<circle[^>]*fill="red"/.test(s) && !/<path/.test(s)) return true; // Rails icon.svg
    if (/react/i.test(basename(path))) return true;
  }
  return false;
}

function linkedIcons(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link[^>]+rel=["'](?:shortcut )?(?:icon|apple-touch-icon)["'][^>]*>/gi)) {
    const href = m[0].match(/href=["']([^"'?#]+)/)?.[1];
    if (!href || /^(https?:|data:|<%)/.test(href)) continue;
    const p = href.replace(/^\//, "");
    for (const dir of [base, join(base, "public"), join(dirname(base), "public"), join(base, "..", "..", "public")]) {
      const f = join(dir, p);
      if (existsSync(f)) out.push(f);
    }
  }
  return out;
}

export function findIcon(root: string, maxDepth = 7): { path: string; mime: string; data: Buffer } | null {
  const cands: { path: string; s: number }[] = [];
  const linked = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && depth < maxDepth) walk(p, depth + 1);
      } else if (e.isFile()) {
        const s = score(p.slice(root.length + 1));
        if (s) cands.push({ path: p, s });
        if (e.name === "index.html" || /layouts\/application\.html\.erb$/.test(p)) {
          try { for (const f of linkedIcons(readFileSync(p, "utf8"), dir)) linked.add(f); } catch {}
        }
      }
    }
  };
  walk(root, 0);
  for (const c of cands) {
    if (linked.has(c.path)) c.s += 5;
    c.s -= c.path.split("/").length * 0.01; // shallower wins a tie
  }
  cands.sort((a, b) => b.s - a.s);
  for (const c of cands) {
    try {
      if (statSync(c.path).size > 1_000_000) continue;
      const data = readFileSync(c.path);
      if (isPlaceholder(data, c.path)) continue;
      return { path: c.path, mime: MIME[extname(c.path).toLowerCase()] ?? "application/octet-stream", data };
    } catch {}
  }
  return null;
}
