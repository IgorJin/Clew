import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const taskDir = fileURLToPath(new URL('../tasks/', import.meta.url));
const allowedStatuses = new Set([
  'planned',
  'ready',
  'in_progress',
  'in_review',
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
  'evidence_policy',
];
const legacyEvidenceCards = new Set([
  'CLEW-042',
  'CLEW-043',
  'CLEW-067',
  'CLEW-068',
  'CLEW-069',
  'CLEW-070',
  'CLEW-071',
  'CLEW-072',
  'CLEW-074',
  'CLEW-075',
  'CLEW-076',
]);

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

function section(text, heading) {
  const match = text.match(new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`));

  return match?.[1] ?? null;
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
  if (!['legacy', 'v1'].includes(card.evidence_policy))
    throw new Error(`${card.file}: unsupported evidence_policy ${card.evidence_policy}`);
  if (card.evidence_policy === 'legacy' && !legacyEvidenceCards.has(card.id))
    throw new Error(`${card.file}: new task cards must use evidence_policy: v1`);
  if (card.status === 'in_review' && card.evidence_policy !== 'v1')
    throw new Error(`${card.file}: in_review requires evidence_policy: v1`);
  if (card.evidence_policy === 'v1') {
    const acceptance = section(card.text, 'Acceptance criteria');
    const evidence = section(card.text, 'Acceptance evidence');
    const review = section(card.text, 'Review record');
    const criteria = acceptance?.match(/^\d+\./gm) ?? [];

    if (!criteria.length)
      throw new Error(`${card.file}: evidence policy requires acceptance criteria`);
    if (!evidence) throw new Error(`${card.file}: evidence policy requires Acceptance evidence`);
    if (!review) throw new Error(`${card.file}: evidence policy requires Review record`);
    for (let index = 1; index <= criteria.length; index += 1)
      if (!new RegExp(`\\|\\s*AC-${index}\\s*\\|`).test(evidence))
        throw new Error(`${card.file}: AC-${index} is missing from Acceptance evidence`);
    if (card.status === 'done') {
      if (/\b(?:pending|missing|failed|not covered)\b/i.test(evidence))
        throw new Error(`${card.file}: done task has incomplete acceptance evidence`);
      if (!/Verdict:\s*pass\b/i.test(review))
        throw new Error(`${card.file}: done task requires a passing review verdict`);
    }
  }
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
