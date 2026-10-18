#!/usr/bin/env node
// Render docs/presentation/workctl-overview.html to a 5-page A4-landscape PDF with Chromium.
// Fonts (Noto Sans SC, JetBrains Mono) are fetched once from Google Fonts into a local cache and
// embedded via @font-face, so the PDF does not depend on fonts installed on the machine.
// Usage: node docs/presentation/build.mjs [--out docs/presentation/workctl-overview.pdf]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const args = process.argv.slice(2);
const OUT = resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/presentation/workctl-overview.pdf');
const CACHE = join(ROOT, 'node_modules/.cache/presentation-fonts');
const FAMILIES = 'family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@400;500';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function curl(url, out) {
  const a = ['-sSfL', '--max-time', '60', '-A', UA, url];
  return out ? execFileSync('curl', [...a, '-o', out]) : execFileSync('curl', a, { encoding: 'utf8' });
}

function fontCss() {
  mkdirSync(CACHE, { recursive: true });
  const cssFile = join(CACHE, 'fonts.css');
  if (!existsSync(cssFile)) {
    let css = curl(`https://fonts.googleapis.com/css2?${FAMILIES}&display=block`);
    const urls = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) ?? [])];
    urls.forEach((u, i) => {
      const f = `f${i}.woff2`;
      curl(u, join(CACHE, f));
      css = css.split(u).join(f);
    });
    writeFileSync(cssFile, css);
  }
  // absolute file:// URLs so the page (in docs/presentation) can load them from the cache
  return readFileSync(cssFile, 'utf8').replace(/url\((f\d+\.woff2)\)/g, (_, f) => `url(${pathToFileURL(join(CACHE, f)).href})`);
}

async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const req = createRequire(join(g, 'noop.js'));
  return import(pathToFileURL(req.resolve('playwright')).href);
}

function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (existsSync(join(base, d, rel))) return join(base, d, rel);
  }
  return undefined;
}

const src = join(HERE, 'workctl-overview.html');
const html = readFileSync(src, 'utf8').replace('/*FONTS*/', fontCss());
const tmp = join(HERE, '.render.html');
writeFileSync(tmp, html);
const pw = await loadPlaywright();
const chromium = pw.chromium ?? pw.default?.chromium;
const browser = await chromium.launch({ executablePath: chromiumPath() });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(tmp).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: OUT, format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  if (args.includes('--png')) {
    await page.setViewportSize({ width: 1123, height: 794 });
    await page.screenshot({ path: OUT.replace(/\.pdf$/, '.preview.png'), fullPage: true });
  }
} finally {
  await browser.close();
  try { (await import('node:fs')).unlinkSync(tmp); } catch {}
}
console.log(`wrote ${OUT}`);
