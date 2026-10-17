#!/usr/bin/env node
// Static lint for skills/<name>/SKILL.md: frontmatter, workctl commands + flags (resolved against the
// built CLI's --help), planned-capability labelling, referenced file paths, secret-looking literals.
// Commands are found in code blocks / inline code written as `workctl …`, and in inline code written
// without the prefix when the first word is a top-level command group (e.g. `deploy release get --id x`).
// Usage: node scripts/skill-lint.mjs [--json]   (needs `npm run build`; uses $WORKCTL_CONFIG for plugins)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist/workctl.js');
const env = { ...process.env, WORKCTL_CONFIG: process.env.WORKCTL_CONFIG ?? join(ROOT, 'demo/environment/workctl.yaml') };
const MAX_DESC = 400;

const helpCache = new Map();
/** Parse `workctl <path> --help` into { commands:Set, options:Set } or null when the path is not a command. */
function help(path) {
  const key = path.join(' ');
  if (helpCache.has(key)) return helpCache.get(key);
  let out = null;
  try {
    const text = execFileSync('node', [CLI, ...path, '--help'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const usage = text.match(/^Usage: workctl(.*)$/m)?.[1] ?? '';
    // commander falls back to the parent's help for unknown subcommands: require the usage line to name the path
    if (path.length && !usage.trim().startsWith(path.join(' '))) out = null;
    else {
      const commands = new Set();
      const options = new Set();
      let section = '';
      for (const line of text.split('\n')) {
        if (/^Options:/.test(line)) section = 'o';
        else if (/^Commands:/.test(line)) section = 'c';
        else if (/^\S/.test(line)) section = '';
        else if (section === 'c') { const m = line.match(/^ {2}(\S+)/); if (m) commands.add(m[1]); }
        else if (section === 'o') for (const f of line.matchAll(/(?:^|[\s,])(--?[a-zA-Z][\w-]*)/g)) options.add(f[1]);
      }
      out = { commands, options };
    }
  } catch { out = null; }
  helpCache.set(key, out);
  return out;
}

const root = help([]);
const GLOBAL = root.options;
const caps = JSON.parse(execFileSync('node', [CLI, 'capability', 'list', '--json'], { env, encoding: 'utf8' })).data.capabilities;
const capByCommand = new Map(caps.map((c) => [c.command, c]));

/** Resolve the longest command path in `tokens`; return { path, rest } or null. */
function resolveCommand(tokens) {
  const path = [];
  let node = root;
  for (const t of tokens) {
    if (!node.commands.has(t)) break;
    path.push(t);
    node = help(path);
    if (!node) return null;
  }
  return path.length ? { path, node } : null;
}

const SECRET = [
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(?!env:|file:|<|\$|\*|"?\$\{)["']?[A-Za-z0-9+/_\-]{6,}/i,
  /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:ghp|glpat|xox[bp])-?[A-Za-z0-9_]{16,}/,
  /:\/\/[^\s/:@]+:[^\s/@<$]{3,}@/,
];

const findings = [];
let checked = 0;
const add = (skill, type, detail) => findings.push({ skill, type, detail });

const skillsDir = join(ROOT, 'skills');
for (const name of readdirSync(skillsDir).sort()) {
  const file = join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  // (a) frontmatter
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) { add(name, 'frontmatter', 'missing YAML frontmatter'); continue; }
  const fmName = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
  if (fmName !== name) add(name, 'frontmatter', `name "${fmName}" != directory`);
  if (!desc) add(name, 'frontmatter', 'missing description');
  else {
    if ([...desc].length > MAX_DESC) add(name, 'description', `${[...desc].length} chars > ${MAX_DESC}`);
    if (!/使用|适用|when|use/i.test(desc)) add(name, 'description', 'does not say when to use it');
    if (!/不(?:用于|适用|负责|做|替代)|而非|不是|not for|改用|→/.test(desc)) add(name, 'description', 'does not say what it is not for');
  }
  const body = text.slice(fm[0].length);
  const lines = body.split('\n');
  // (b) commands: code-block lines and inline code that start with `workctl`; inline code without the
  // prefix whose first word is a top-level command group and that has at least one more token
  const mentions = [];
  let inCode = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return; }
    if (inCode) {
      for (const seg of line.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
        const m = seg.match(/(?:^|\s|\$\s?)(workctl\s.+)$/);
        if (m) mentions.push({ cmd: m[1].replace(/\s+#.*$/, ''), line: i, text: line });
      }
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const code = m[1].trim();
      if (/^workctl\s/.test(code)) { mentions.push({ cmd: code, line: i, text: line }); continue; }
      const [first, second] = code.split(/\s+/);
      if (second !== undefined && root.commands.has(first) && /^(?:[a-z][a-z0-9-]*|--?[a-zA-Z][\w-]*)$/.test(second)) {
        mentions.push({ cmd: `workctl ${code}`, line: i, text: line });
      }
    }
  });
  checked += mentions.length;
  for (const { cmd, line, text: lineText } of mentions) {
    const tokens = cmd.trim().split(/\s+/).slice(1).filter((t) => t !== '\\');
    const words = [];
    for (const t of tokens) { if (/^[a-z][a-z0-9-]*$/.test(t)) words.push(t); else break; }
    if (!words.length) continue;
    // planned capabilities have no command; a mention must be labelled instead of resolving
    const plannedCmd = words.map((_, k) => words.slice(0, k + 1).join(' ')).reverse().find((c) => capByCommand.get(c)?.status === 'planned');
    if (plannedCmd) {
      const ctx = [lines[line - 1] ?? '', lineText, lines[line + 1] ?? ''].join(' ');
      if (!/待接入|planned|未实现|规划|未接入/.test(ctx)) add(name, 'planned', `L${line + 1}: \`${plannedCmd}\` is planned but not labelled 待接入/planned`);
      continue;
    }
    const r = resolveCommand(words);
    if (!r || !r.node) { add(name, 'command', `L${line + 1}: unknown command \`workctl ${words.join(' ')}\``); continue; }
    const command = r.path.join(' ');
    if (r.path.length < words.length && r.node.commands.size) {
      add(name, 'command', `L${line + 1}: \`workctl ${words.join(' ')}\` — "${words[r.path.length]}" is not a subcommand of \`${command}\``);
      continue;
    }
    if (r.node.commands.size && r.path.length === words.length && !/…|\.\.\.|\|/.test(cmd)) {
      // bare group mention (e.g. `workctl mysql ...`) is fine only when written as a family
    }
    const cap = capByCommand.get(command);
    if (cap?.status === 'planned') {
      const ctx = [lines[line - 1] ?? '', lineText, lines[line + 1] ?? ''].join(' ');
      if (!/待接入|planned|未实现|规划/.test(ctx)) add(name, 'planned', `L${line + 1}: \`${command}\` is planned but not labelled 待接入/planned`);
    }
    for (const t of tokens) {
      const f = t.match(/^(--?[a-zA-Z][\w-]*)/)?.[1];
      if (!f) continue;
      if (!r.node.options.has(f) && !GLOBAL.has(f)) add(name, 'flag', `L${line + 1}: \`${command}\` has no flag ${f}`);
    }
  }
  // (c) referenced paths
  for (const m of body.matchAll(/(?<![\w/.-])((?:docs|skills|scripts|demo|plugins)\/[\w./-]*[\w-])/g)) {
    const p = m[1].replace(/[.,)]+$/, '');
    if (/[<*{]/.test(p)) continue;
    if (!existsSync(join(ROOT, p))) add(name, 'path', `missing ${p}`);
  }
  // (d) secrets
  lines.forEach((line, i) => { for (const re of SECRET) if (re.test(line)) add(name, 'secret', `L${i + 1}: secret-looking literal`); });
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ findings }, null, 2) + '\n');
} else if (!findings.length) {
  console.log(`skill-lint: no findings (${checked} workctl command mentions checked)`);
} else {
  const w = Math.max(...findings.map((f) => f.skill.length));
  console.log(`${'skill'.padEnd(w)}  ${'type'.padEnd(11)}  detail`);
  for (const f of findings) console.log(`${f.skill.padEnd(w)}  ${f.type.padEnd(11)}  ${f.detail}`);
  const byType = {};
  for (const f of findings) byType[f.type] = (byType[f.type] ?? 0) + 1;
  console.log(`\n${findings.length} finding(s): ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}
process.exitCode = findings.length ? 1 : 0;
