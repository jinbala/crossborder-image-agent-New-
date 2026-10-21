// Mechanical JSX-only migration and an explicit coverage report. No runtime DOM rewriting.
// Never rewrites business data or enum values. --expressions opts into explicit UI message calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { english } from '../src/i18n/messages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chinese = /[\u3400-\u9fff]/;
const attributes = new Set(['title', 'label', 'description', 'placeholder', 'aria-label', 'alt', 'subtitle', 'emptyMessage']);
function walk(node, parents, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, parents);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'extra', 'comments', 'tokens', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, [...parents, node], visit));
    else if (value && typeof value === 'object') walk(value, [...parents, node], visit);
  }
}
function jsxText(value) {
  const lines = value.split(/\r\n|\n|\r/); let lastNonEmpty = 0;
  lines.forEach((line, index) => { if (/[^ \t]/.test(line)) lastNonEmpty = index; });
  return lines.map((line, index) => {
    let text = line.replace(/\t/g, ' ');
    if (index > 0) text = text.replace(/^ +/, '');
    if (index < lines.length - 1) text = text.replace(/ +$/, '');
    if (text && index !== lastNonEmpty) text += ' ';
    return text;
  }).join('');
}
function literalCandidates(expression, add) {
  if (!expression) return;
  if (expression.type === 'StringLiteral') add(expression);
  else if (expression.type === 'ConditionalExpression') { literalCandidates(expression.consequent, add); literalCandidates(expression.alternate, add); }
  else if (expression.type === 'LogicalExpression') literalCandidates(expression.right, add);
}
async function filesAt(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? filesAt(path.join(directory, entry.name)) : entry.name.endsWith('.jsx') ? [path.join(directory, entry.name)] : []))).flat();
}
const apply = process.argv.includes('--apply');
const expressions = process.argv.includes('--expressions');
const argumentsFiles = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (apply && !argumentsFiles.length) throw new Error('--apply requires an explicit list of JSX files');
const files = argumentsFiles.length ? argumentsFiles.map((file) => path.resolve(root, file)) : await filesAt(path.join(root, 'src'));
const report = [];
for (const file of files) {
  if (!file.startsWith(`${path.join(root, 'src')}${path.sep}`) || !file.endsWith('.jsx')) throw new Error('Only frontend/src JSX files are allowed');
  const source = await fs.readFile(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const candidates = new Map(), missing = new Set(), functions = new Set();
  function candidate(node, parents, value, replacement) {
    if (!chinese.test(value)) return;
    // Native language names and bilingual selector identity are intentionally not translated.
    if (parents.some((parent) => parent.type === 'JSXElement' && parent.openingElement.attributes.some((attribute) => attribute.name?.name === 'data-i18n-skip'))) return;
    const owner = [...parents].reverse().find((ancestor) => ancestor.type === 'FunctionDeclaration' && /^[A-Z]/.test(ancestor.id?.name));
    if (!owner) return;
    candidates.set(node.start, { start: node.start, end: node.end, text: value.trim(), replacement }); functions.add(owner);
  }
  function displayExpression(expression, parents) {
    if (!expression) return;
    if (expression.type === 'StringLiteral') candidate(expression, parents, expression.value, `t(${JSON.stringify(expression.value)})`);
    else if (expression.type === 'TemplateLiteral') {
      const text = expression.quasis.map((part, index) => `${part.value.cooked ?? part.value.raw}${index < expression.expressions.length ? `{value${index}}` : ''}`).join('');
      const parameters = expression.expressions.map((value, index) => `value${index}: (${source.slice(value.start, value.end)})`).join(', ');
      candidate(expression, parents, text, `t(${JSON.stringify(text)}${parameters ? `, { ${parameters} }` : ''})`);
    } else if (expression.type === 'ConditionalExpression') { displayExpression(expression.consequent, parents); displayExpression(expression.alternate, parents); }
    else if (expression.type === 'LogicalExpression') displayExpression(expression.right, parents);
  }
  walk(ast, [], (node, parents) => {
    if (node.type === 'JSXText') {
      const value = jsxText(node.value), trimmed = value.trim();
      const leading = value.match(/^\s*/)[0], trailing = value.match(/\s*$/)[0];
      const expression = `${leading ? `${JSON.stringify(leading)} + ` : ''}t(${JSON.stringify(trimmed)})${trailing ? ` + ${JSON.stringify(trailing)}` : ''}`;
      candidate(node, parents, value, `{${expression}}`);
    }
    if (node.type === 'JSXAttribute' && attributes.has(node.name?.name) && node.value?.type === 'StringLiteral') candidate(node.value, parents, node.value.value, `{t(${JSON.stringify(node.value.value)})}`);
    if (node.type === 'JSXExpressionContainer' && (parents.at(-1)?.type !== 'JSXAttribute' || attributes.has(parents.at(-1).name?.name))) {
      if (expressions) displayExpression(node.expression, parents);
      else literalCandidates(node.expression, (literal) => candidate(literal, parents, literal.value, `t(${JSON.stringify(literal.value)})`));
    }
    if (expressions && ((node.type === 'CallExpression' && ((node.callee.type === 'Identifier' && ['setMessage', 'setNotice', 'setError'].includes(node.callee.name)) || (node.callee.type === 'MemberExpression' && node.callee.object.name === 'window' && node.callee.property.name === 'confirm'))) || (node.type === 'NewExpression' && node.callee.name === 'Error'))) displayExpression(node.arguments[0], parents);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 't' && node.arguments[0]?.type === 'StringLiteral' && chinese.test(node.arguments[0].value) && !Object.hasOwn(english, node.arguments[0].value)) missing.add(node.arguments[0].value);
  });
  report.push({ file: path.relative(root, file).replaceAll('\\', '/'), unlocalized: [...candidates.values()].map(({ text }) => text), missing: [...missing] });
  if (apply && candidates.size) {
    const edits = [...candidates.values()];
    for (const owner of functions) if (!source.slice(owner.body.start, owner.body.end).match(/\bconst\s*\{[^}]*\bt\b[^}]*\}\s*=\s*useLocale\(/)) edits.push({ start: owner.body.start + 1, end: owner.body.start + 1, replacement: '\n  const { t } = useLocale();' });
    if (!source.includes("import { useLocale }")) edits.push({ start: 0, end: 0, replacement: `import { useLocale } from '${path.relative(path.dirname(file), path.join(root, 'src/i18n/LocaleProvider.jsx')).replaceAll('\\', '/').replace(/^(?!\.)/, './')}';\n` });
    let output = source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
    await fs.writeFile(file, output);
  }
}
console.log(JSON.stringify({ scope: expressions ? 'JSX display templates plus explicit UI messages/confirmations; data-derived labels and backend messages require separate review' : 'static JSX text/attributes and literal display fallbacks only; data-derived labels and backend messages require separate review', files: report.filter((item) => item.unlocalized.length || item.missing.length), unlocalizedCount: report.reduce((sum, item) => sum + item.unlocalized.length, 0), missingCount: report.reduce((sum, item) => sum + item.missing.length, 0) }, null, 2));
if (process.argv.includes('--check') && report.some((item) => item.unlocalized.length || item.missing.length)) process.exitCode = 1;
