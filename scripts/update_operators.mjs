import fs from 'node:fs';
import path from 'node:path';

const v5Path = path.resolve('../aha_operator_cards_v5.md');
const content = fs.readFileSync(v5Path, 'utf8');
const lines = content.split('\n');

const families = {};
let currentFamily = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line.startsWith('## ') && !line.includes('用法与设计规范')) {
    currentFamily = line.replace('## ', '').trim();
    families[currentFamily] = [];
  } else if (line.startsWith('### ') && currentFamily) {
    const parts = line.replace('### ', '').trim().split(/\s+/);
    const operator_id = parts[0];
    const name = parts.slice(1).join(' ');
    let pLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('### ') || lines[j].startsWith('## ') || lines[j].startsWith('---')) break;
      pLines.push(lines[j]);
    }
    const prompt = pLines.join('\n').trim();
    families[currentFamily].push([operator_id, name, prompt]);
  }
}

const fileHeader = "import { sampleOperators as sampleFromPool } from './varina/operator_pool.mjs';\nexport { random } from './varina/operator_pool.mjs';\n\nexport const OPERATOR_VERSION = 'operators-v5';\nconst families = ";
const fileFooter = `;\nexport const operators = Object.entries(families).flatMap(([family, rows]) => rows.map(([operator_id, name, prompt]) => ({ operator_id, family, name, prompt, enabled: true })));
export function sampleOperators(rng, pool = operators) {
  return sampleFromPool(rng, pool);
}
`;

const output = fileHeader + JSON.stringify(families, null, 2) + fileFooter;
fs.writeFileSync('src/operators.mjs', output, 'utf8');
console.log('OK! Families:', Object.keys(families).length, 'Operators:', Object.values(families).reduce((acc, r) => acc + r.length, 0));
