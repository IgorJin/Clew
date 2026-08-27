import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

test('all published schemas and fixtures are valid JSON', () => {
  for (const directory of [
    'schemas',
    'fixtures/contracts',
    'fixtures/plans',
    'fixtures/profiles',
    'fixtures/reviews',
  ]) {
    const files = readdirSync(join(projectRoot, directory)).filter((file) =>
      file.endsWith('.json'),
    );

    assert.ok(files.length > 0, `${directory} must contain versioned JSON artifacts`);
    for (const file of files)
      assert.doesNotThrow(() =>
        JSON.parse(readFileSync(join(projectRoot, directory, file), 'utf8')),
      );
  }
});
