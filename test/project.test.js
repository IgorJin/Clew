import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ClewService } from '../src/control-service.js';
import { validateProject } from '../src/domain.js';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../src/migrations.js';
import { detectProject } from '../src/project.js';
import { Store } from '../src/store.js';

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });

    return true;
  } catch {
    return false;
  }
}

function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'clew-project-'));

  execFileSync('git', ['init', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@clew.local'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'clew-test'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'init'], { stdio: ['ignore', 'pipe', 'pipe'] });

  return dir;
}

function makeService() {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-project-svc-'));

  mkdirSync(join(cwd, '.clew'));
  const store = new Store(join(cwd, '.clew', 'clew.sqlite'));
  const service = new ClewService({ cwd, store, config: DEFAULT_CONFIG });

  return { cwd, store, service };
}

test('validateProject enforces the project contract', () => {
  assert.throws(() => validateProject(null), /project must be an object/);
  assert.throws(
    () => validateProject({ id: 'PRJ-1', localPath: '/x', repositoryRoot: '/x' }),
    /project\.name is required/,
  );
  assert.throws(
    () =>
      validateProject({
        id: 'bad id!',
        name: 'X',
        localPath: '/x',
        repositoryRoot: '/x',
        defaultBranch: 'main',
      }),
    /project\.id must contain/,
  );
  const record = validateProject({
    id: 'PRJ-ABC123',
    name: '  Clew  ',
    localPath: '/tmp/clew',
    repositoryRoot: '/tmp/clew',
    defaultBranch: 'main',
  });

  assert.equal(record.name, 'Clew');
});

test('detectProject detects repository metadata', { skip: !hasGit() }, () => {
  const dir = makeGitRepo();
  const current = execFileSync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  try {
    const detected = detectProject(dir);

    assert.equal(detected.repositoryRoot, realpathSync(dir));
    assert.equal(detected.defaultBranch, current);
    assert.ok(detected.name.length > 0);
    assert.equal(detected.localPath, realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectProject detects a repository from a subfolder', { skip: !hasGit() }, () => {
  const dir = makeGitRepo();
  const sub = join(dir, 'packages', 'ui');

  mkdirSync(sub, { recursive: true });
  try {
    const detected = detectProject(sub);

    assert.equal(detected.repositoryRoot, realpathSync(dir));
    assert.equal(detected.localPath, realpathSync(sub));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectProject rejects invalid folders', { skip: !hasGit() }, () => {
  const plain = mkdtempSync(join(tmpdir(), 'clew-project-plain-'));

  try {
    assert.throws(() => detectProject(plain), /not a git repository/);
    assert.throws(
      () => detectProject(join(tmpdir(), 'clew-project-missing-definitely')),
      /does not exist/,
    );
    const file = join(plain, 'file.txt');

    writeFileSync(file, 'x');
    assert.throws(() => detectProject(file), /not a directory/);
    assert.throws(() => detectProject('  '), /project folder is required/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('detectProject reports a missing git binary distinctly', { skip: !hasGit() }, () => {
  const dir = makeGitRepo();
  const previousPath = process.env.PATH;

  process.env.PATH = join(tmpdir(), 'clew-no-git-here');
  try {
    assert.throws(() => detectProject(dir), /git executable is not available on PATH/);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projects persist across store reopen and reject duplicate repositories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-project-store-'));
  const file = join(dir, 'clew.sqlite');
  const first = new Store(file);

  try {
    const created = first.createProject({
      id: 'PRJ-1',
      name: 'Clew',
      localPath: '/tmp/clew',
      repositoryRoot: '/tmp/clew',
      defaultBranch: 'main',
    });

    assert.equal(created.id, 'PRJ-1');
    assert.equal(first.listProjects().length, 1);
    assert.throws(
      () =>
        first.createProject({
          id: 'PRJ-2',
          name: 'Duplicate',
          localPath: '/tmp/other',
          repositoryRoot: '/tmp/clew',
          defaultBranch: 'main',
        }),
      /project already exists: PRJ-1/,
    );
  } finally {
    first.close();
  }
  const second = new Store(file);

  try {
    assert.equal(second.getProject('PRJ-1').name, 'Clew');
    assert.equal(second.getProject('UNKNOWN'), null);
    assert.equal(second.listProjects().length, 1);
  } finally {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy databases without project columns upgrade transparently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-project-legacy-'));
  const file = join(dir, 'clew.sqlite');
  const legacy = new DatabaseSync(file);

  legacy.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, contract TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, tags TEXT DEFAULT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES
      (18,'2026-01-01T00:00:00.000Z'),(19,'2026-01-01T00:00:00.000Z'),
      (20,'2026-01-01T00:00:00.000Z'),(21,'2026-01-01T00:00:00.000Z');
    INSERT INTO tasks VALUES ('LEGACY-PRJ', '{"id":"LEGACY-PRJ","title":"Legacy","goal":"Preserve","acceptance":[{"id":"AC-1","criterion":"works"}],"profile":"quick","base_ref":"HEAD"}', 'READY', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
  `);
  legacy.close();
  const store = new Store(file);

  try {
    const task = store.getTask('LEGACY-PRJ');

    assert.equal(task.contract.title, 'Legacy');
    assert.equal(task.project_id, null);
    assert.equal(store.listTasks()[0].project_id, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project migration assigns legacy unscoped tasks to the oldest project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-project-scope-migration-'));
  const file = join(dir, 'clew.sqlite');
  const database = new DatabaseSync(file);
  const at = '2026-01-01T00:00:00.000Z';

  applyMigrations(database, { through: 22 });
  database
    .prepare(
      'INSERT INTO projects (id,name,local_path,repository_root,default_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run('PRJ-FIRST', 'First', '/tmp/first', '/tmp/first', 'main', at, at);
  database
    .prepare(
      'INSERT INTO projects (id,name,local_path,repository_root,default_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run('PRJ-SECOND', 'Second', '/tmp/second', '/tmp/second', 'main', at, at);
  database
    .prepare(
      'INSERT INTO tasks (id,contract,state,created_at,updated_at,project_id) VALUES (?,?,?,?,?,NULL)',
    )
    .run(
      'LEGACY-SCOPE',
      JSON.stringify({ id: 'LEGACY-SCOPE', title: 'Legacy', goal: 'Preserve scope' }),
      'DRAFT',
      at,
      at,
    );
  database.close();

  const store = new Store(file);

  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 23);
    assert.equal(store.getTask('LEGACY-SCOPE').project_id, 'PRJ-FIRST');
    assert.equal(store.getTask('LEGACY-SCOPE').contract.projectId, 'PRJ-FIRST');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adding the first project claims existing unscoped tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-project-first-scope-'));
  const store = new Store(join(dir, 'clew.sqlite'));

  try {
    store.createTask({ id: 'UNSCOPED-1', title: 'Unscoped', goal: 'Attach on project add' });
    store.createProject({
      id: 'PRJ-FIRST',
      name: 'First',
      localPath: '/tmp/first',
      repositoryRoot: '/tmp/first',
      defaultBranch: 'main',
    });

    assert.equal(store.getTask('UNSCOPED-1').project_id, 'PRJ-FIRST');
    assert.equal(store.getTask('UNSCOPED-1').contract.projectId, 'PRJ-FIRST');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project lifecycle flows through the shared service boundary', async () => {
  const { cwd, store } = makeService();
  const service = new ClewService({
    cwd,
    store,
    config: DEFAULT_CONFIG,
    folderPicker: async () => '/tmp/chosen-repository',
  });

  try {
    assert.equal(service.supports(['project', 'add']), true);
    assert.equal(service.supports(['project', 'browse']), true);
    assert.equal(service.supports(['project', 'list']), true);
    assert.equal(service.supports(['project', 'show']), true);
    assert.deepEqual(await service.execute(['project', 'browse']), {
      folder: '/tmp/chosen-repository',
    });
    assert.deepEqual(await service.execute(['project', 'list']), []);
    await assert.rejects(() => service.execute(['project', 'show', 'PRJ-X']), /project not found/);
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test(
  'service binds tasks to projects and snapshots carry the association',
  { skip: !hasGit() },
  async () => {
    const repo = makeGitRepo();
    const { cwd, store, service } = makeService();

    try {
      const project = await service.execute(['project', 'add', repo, '--name', 'Fixture']);

      assert.match(project.id, /^PRJ-/);
      assert.equal(project.repository_root, realpathSync(repo));
      assert.equal((await service.execute(['project', 'list'])).length, 1);
      assert.equal((await service.execute(['project', 'show', project.id])).name, 'Fixture');
      await assert.rejects(
        () => service.execute(['project', 'add', repo]),
        /project already exists/,
      );

      const bound = await service.execute([
        'task',
        'create',
        '--id',
        'PRJ-TASK-1',
        '--title',
        'Bound task',
        '--goal',
        'belongs to project',
        '--project',
        project.id,
        '--accept',
        'bound',
      ]);

      assert.equal(bound.projectId, project.id);
      const rows = await service.execute(['task', 'list']);

      assert.equal(rows.find((row) => row.id === 'PRJ-TASK-1').project_id, project.id);
      assert.equal((await service.execute(['task', 'show', 'PRJ-TASK-1'])).project_id, project.id);

      const unbound = await service.execute([
        'task',
        'create',
        '--id',
        'PRJ-TASK-2',
        '--title',
        'Unbound task',
        '--goal',
        'no project',
        '--accept',
        'unbound',
      ]);

      assert.equal(unbound.projectId, undefined);
      assert.equal(store.getTask('PRJ-TASK-2').project_id, null);

      await assert.rejects(
        () =>
          service.execute([
            'task',
            'create',
            '--id',
            'PRJ-TASK-3',
            '--title',
            'Missing project',
            '--goal',
            'unknown',
            '--project',
            'PRJ-UNKNOWN',
            '--accept',
            'missing',
          ]),
        /project not found: PRJ-UNKNOWN/,
      );

      const snapshot = service.snapshot();

      assert.equal(snapshot.version, 1);
      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.projects[0].id, project.id);
      assert.equal(snapshot.tasks.length, 2);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
);
