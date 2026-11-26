import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_URL, targetUrl } from '../src/cli.js';

test('help shows an actionable MR workflow without using login credentials', () => {
  const run = (...args) => spawnSync(process.execPath, ['bin/openlibing-staticcheck.js', ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' },
  });
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /openlibing-staticcheck mr report/);
    assert.match(result.stdout, /openlibing-cli auth login/);
    assert.match(result.stdout, /gc auth login/);
  }
  for (const args of [['mr'], ['mr', '--help'], ['mr', 'report', '--help'], ['mr', 'shield', '--help']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /openlibing-staticcheck mr/);
  }
  assert.match(run('mr', 'report', '--help').stdout, /reportUrlSource/);
  assert.match(run('mr', 'shield', '--help').stdout, /approvalUrl/);
  assert.doesNotMatch(run('--help').stdout, /完整链接|GitCode MR 链接/);
});

test('MR commands require a number and reject a URL before contacting GitCode', () => {
  const url = 'https://gitcode.com/CANN/pto-as/merge_requests/531';
  for (const action of ['report', 'shield']) {
    const args = action === 'shield' ? ['--task-id', 'MR_example', '--lines', '1785',
      '--reviewer', 'Zhendong404', '--reason', '误报', '--shield-type', '2'] : [];
    const result = spawnSync(process.execPath, ['bin/openlibing-staticcheck.js', 'mr', action, url, ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /提供 MR 编号/);
    assert.doesNotMatch(result.stderr, /GitCode CLI 查询失败/);
  }
});

test('shield requires an explicit valid category before contacting GitCode', () => {
  const run = (...args) => spawnSync(process.execPath, [
    'bin/openlibing-staticcheck.js', 'mr', 'shield', '531', '--task-id', 'MR_example',
    '--lines', '1785', '--reviewer', 'Zhendong404', '--reason', '误报', ...args,
  ], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });
  assert.match(run().stderr, /--shield-type/);
  assert.match(run('--shield-type', '9').stderr, /0 到 8/);
  const withCategory = run('--shield-type', '2');
  assert.equal(withCategory.status, 1);
  assert.match(withCategory.stderr, /GitCode CLI/);
});

test('only the expected HTTPS origin is accepted', () => {
  assert.equal(targetUrl(), DEFAULT_URL);
  assert.equal(targetUrl('https://www.openlibing.com/other'), 'https://www.openlibing.com/other');
  for (const url of ['http://www.openlibing.com/', 'https://example.com/', 'invalid']) {
    assert.throws(() => targetUrl(url));
  }
});

test('status, open and logout handle a missing session', async () => {
  const testRoot = join(process.cwd(), '.work', 'tests');
  await mkdir(testRoot, { recursive: true });
  const dir = await mkdtemp(join(testRoot, 'openlibing-staticcheck-test-'));
  const profile = join(dir, 'browser');
  const run = (...args) => spawnSync(process.execPath, ['bin/openlibing-staticcheck.js', ...args, '--profile', profile], { encoding: 'utf8' });
  try {
    assert.match(run('status').stdout, /尚无本机会话/);
    const open = run('open');
    assert.equal(open.status, 1);
    assert.match(open.stderr, /请先运行 openlibing-staticcheck login/);
    assert.equal(run('logout').status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('import accepts a site-scoped session and rejects other origins', async () => {
  const testRoot = join(process.cwd(), '.work', 'tests');
  await mkdir(testRoot, { recursive: true });
  const dir = await mkdtemp(join(testRoot, 'openlibing-staticcheck-import-'));
  const file = join(dir, 'transfer.json');
  const profile = join(dir, 'browser');
  const run = () => spawnSync(process.execPath, ['bin/openlibing-staticcheck.js', 'import', '--file', file, '--profile', profile], { encoding: 'utf8' });
  const session = { version: 1, storageState: { cookies: [], origins: [{ origin: 'https://www.openlibing.com', localStorage: [] }] }, sessionStorage: {} };
  try {
    await writeFile(file, JSON.stringify(session));
    assert.equal(run().status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'session.json'), 'utf8')), session);
    assert.equal((await stat(join(profile, 'session.json'))).mode & 0o777, 0o600);
    session.storageState.origins[0].origin = 'https://example.com';
    await writeFile(file, JSON.stringify(session));
    assert.equal(run().status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
