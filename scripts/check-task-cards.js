import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const taskDir = fileURLToPath(new URL('../tasks/', import.meta.url));
const allowedStatuses = new Set([
  'planned',
  'ready',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
  'superseded',
]);
const requiredFields = [
  'id',
  'title',
  'status',
  'release',
  'priority',
  'size',
  'depends_on',
  'parallel_group',
  'owner',
  'updated',
];

function parseValue(value) {
  const trimmed = value.trim();

  if (trimmed === 'null') return null;
  if (trimmed.startsWith('[') && trimmed.endsWith(']'))
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  return trimmed;
}

function parseCard(file) {
  const text = readFileSync(`${taskDir}/${file}`, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);

  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const metadata = {};

  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');

    if (separator < 1) throw new Error(`${file}: invalid frontmatter line: ${line}`);
    metadata[line.slice(0, separator)] = parseValue(line.slice(separator + 1));
  }
  for (const field of requiredFields)
    if (!(field in metadata)) throw new Error(`${file}: missing ${field}`);

  return { file, text, ...metadata };
}

const cards = readdirSync(taskDir)
  .filter((file) => /^CLEW-\d{3}\.md$/.test(file))
  .sort()
  .map(parseCard);
const byId = new Map(cards.map((card) => [card.id, card]));

for (const card of cards) {
  if (`${card.id}.md` !== card.file) throw new Error(`${card.file}: id does not match filename`);
  if (!allowedStatuses.has(card.status))
    throw new Error(`${card.file}: unsupported status ${card.status}`);
  if (!Array.isArray(card.depends_on))
    throw new Error(`${card.file}: depends_on must use inline array syntax`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(card.updated))
    throw new Error(`${card.file}: updated must be YYYY-MM-DD`);
  if (card.status === 'blocked' && /## Blockers\n\nNone\./.test(card.text))
    throw new Error(`${card.file}: blocked task must explain its blocker`);
  if (card.status === 'done' && /## Completion record\n\nNot completed\./.test(card.text))
    throw new Error(`${card.file}: done task needs a completion record`);
  if (card.status === 'ready')
    for (const dependency of card.depends_on) {
      const dependencyCard = byId.get(dependency);

      if (dependencyCard && dependencyCard.status !== 'done')
        throw new Error(
          `${card.file}: ready task depends on ${dependency} (${dependencyCard.status})`,
        );
    }
}

console.log(`Validated ${cards.length} Clew task cards`);
