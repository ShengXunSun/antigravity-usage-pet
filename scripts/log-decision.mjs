import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultLog = resolve(__dirname, '..', 'decisions.tsv');

function sanitizeCell(val) {
  const clean = String(val ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
  if (/^[=+\-@]/.test(clean)) {
    return `'${clean}`;
  }
  return clean;
}

const args = process.argv.slice(2);
if (args.length < 5) {
  console.error('Usage: node scripts/log-decision.mjs [logfile] <phase> <decision> <why> <evidence> <result>');
  process.exit(1);
}

const hasExplicitFile = args.length >= 6;
const logPath = hasExplicitFile ? resolve(args[0]) : defaultLog;
const [phase, decision, why, evidence, result] = hasExplicitFile ? args.slice(1, 6) : args.slice(0, 5);

if (!existsSync(logPath)) {
  writeFileSync(logPath, 'ts\tphase\tdecision\twhy\tevidence\tresult\n', 'utf-8');
}

const ts = new Date().toISOString();
const row = [ts, phase, decision, why, evidence, result].map(sanitizeCell).join('\t') + '\n';
appendFileSync(logPath, row, 'utf-8');
console.log(`Logged [${phase}]: ${decision}`);
