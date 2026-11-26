import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseMrUrl, mrFromPrView, sameMr, resolveProjectId, reportLinksFromComments, codecheckJobs } from '../src/mr.js';

test('MR number resolves from the URL returned by GitCode CLI', () => {
  assert.deepEqual(mrFromPrView('531', {
    number: 531, html_url: 'https://gitcode.com/CANN/pto-as/merge_requests/531',
  }), { owner: 'cann', repo: 'pto-as', mrId: '531',
    url: 'https://gitcode.com/CANN/pto-as/merge_requests/531' });
  assert.throws(() => mrFromPrView('531', { number: 532,
    html_url: 'https://gitcode.com/CANN/pto-as/merge_requests/532' }));
});

test('GitCode MR URLs are parsed and matched by repository and number', () => {
  const mr = parseMrUrl('https://gitcode.com/CANN/pto-as/merge_requests/531?x=1');
  assert.deepEqual(mr, { owner: 'cann', repo: 'pto-as', mrId: '531' });
  assert.ok(sameMr('https://gitcode.com/CANN/pto-as/merge_requests/531', mr));
  assert.equal(sameMr('https://gitcode.com/OTHER/pto-as/merge_requests/531', mr), false);
  assert.equal(sameMr('https://gitcode.com/CANN/pto-as/merge_requests/532', mr), false);
  for (const url of ['https://example.com/CANN/pto-as/merge_requests/531',
    'https://gitcode.com/CANN/pto-as/issues/531', 'https://gitcode.com/CANN/pto-as/merge_requests/no']) {
    assert.throws(() => parseMrUrl(url));
  }
});

test('project ID comes from a retrieved report URL, with an explicit fallback', () => {
  const links = new Map([['task:uuid', 'https://www.openlibing.com/apps/entryCheckDashCode/task/uuid?projectId=300033']]);
  assert.equal(resolveProjectId(links), '300033');
  assert.equal(resolveProjectId(new Map(), '123'), '123');
  assert.throws(() => resolveProjectId(new Map()), /--project-id/);
  assert.throws(() => resolveProjectId(new Map([...links, ['other:uuid',
    'https://www.openlibing.com/apps/entryCheckDashCode/other/uuid?projectId=999']])), /--project-id/);
});

test('report links come from MR comments and require an exact task and UUID', () => {
  const task = 'MR_7b9e007721a04d6c8f9e9b5ff13dd979';
  const uuid = 'e8ec423fab45bb55aacecc55e11d9049';
  const link = `https://www.openlibing.com/apps/entryCheckDashCode/${task}/${uuid}?projectId=300033&codeHostingPlatformFlag=gitcode`;
  const links = reportLinksFromComments([{ body: `报告：[查看](${link})` },
    { body: `忽略 https://example.com/apps/entryCheckDashCode/${task}/${uuid}?projectId=300033` }]);
  assert.equal(links.get(`${task}:${uuid}`), link);
  assert.equal(links.get(`${task}:other`), undefined);
  assert.equal(reportLinksFromComments([{ body: '没有报告链接' }]).size, 0);
});

test('only executable CodeCheck jobs are selected from gate details', () => {
  assert.deepEqual(codecheckJobs({ stages: [{ jobs: [
    { id: 'parent', name: 'CodeCheck', job_type: 'workflow_call' },
    { id: 'real', name: 'CodeCheck', job_type: 'normal' },
    { id: 'style', name: 'CodeCheck_style', job_type: 'normal' },
  ] }] }).map(job => job.id), ['real']);
});
