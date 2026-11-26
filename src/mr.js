import { execFileSync, execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { help } from './help.js';

const SITE = 'https://www.openlibing.com';
const CODECHECK = `${SITE}/gateway/openlibing-codecheck/ci-portal`;
const FRAMEWORK = `${SITE}/gateway/openlibing-framework`;
const execFileAsync = promisify(execFile);

async function gc(args, options = {}) {
  try {
    return (await execFileAsync('gc', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })).stdout;
  } catch (error) { throw new Error(`GitCode CLI 查询失败：${error.stderr?.trim() || error.message}`); }
}

async function gcJson(args) {
  let value;
  try { value = JSON.parse(await gc(args)); } catch { throw new Error('GitCode CLI 返回的内容不是有效 JSON'); }
  return value;
}

export function parseMrUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的 GitCode MR 链接'); }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname !== 'gitcode.com' || parts.length !== 4 ||
      parts[2] !== 'merge_requests' || !/^\d+$/.test(parts[3])) {
    throw new Error('链接格式应为 https://gitcode.com/组织/仓库/merge_requests/编号');
  }
  return { owner: parts[0].toLowerCase(), repo: parts[1].toLowerCase(), mrId: parts[3] };
}

export function mrFromPrView(number, view) {
  if (Number(view?.number) !== Number(number) || typeof view?.html_url !== 'string')
    throw new Error('GitCode CLI 未返回对应编号的 MR 链接');
  const mr = parseMrUrl(view.html_url);
  if (mr.mrId !== number) throw new Error('GitCode CLI 返回的 MR 编号不匹配');
  return { ...mr, url: view.html_url };
}

async function resolveMr(value) {
  if (!/^\d+$/.test(value)) throw new Error('请在已配置 GitCode 远端的仓库中提供 MR 编号，例如：olb mr report 531');
  const view = await gcJson(['pr', 'view', value, '--json']);
  return mrFromPrView(value, view);
}

export function sameMr(recordUrl, mr) {
  try {
    const other = parseMrUrl(recordUrl);
    return other.owner === mr.owner && other.repo === mr.repo && other.mrId === mr.mrId;
  } catch { return false; }
}

export function reportLinksFromComments(comments) {
  const links = new Map();
  for (const comment of comments) {
    for (const match of String(comment.body ?? '').matchAll(/https:\/\/www\.openlibing\.com\/apps\/entryCheckDashCode\/[^\s<>"'`\\)]+/g)) {
      let url;
      try { url = new URL(match[0]); } catch { continue; }
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.origin !== SITE || parts.length !== 4 || parts[0] !== 'apps' ||
          parts[1] !== 'entryCheckDashCode' || !/^MR_[a-f0-9]+$/i.test(parts[2])) continue;
      if (!/^[a-f0-9]{32}$/i.test(parts[3] ?? '')) continue;
      const projectId = url.searchParams.get('projectId');
      if (!/^\d+$/.test(projectId ?? '')) continue;
      links.set(`${parts[2]}:${parts[3]}`, url.href);
    }
  }
  return links;
}

async function gitcodeReportLinks(mr) {
  const links = new Map();
  for (let page = 1; page <= 10; page++) {
    const comments = await gcJson(['api',
      `repos/${mr.owner}/${mr.repo}/pulls/${mr.mrId}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(comments)) throw new Error('GitCode CLI 未返回 MR 评论列表');
    for (const [key, value] of reportLinksFromComments(comments)) links.set(key, value);
    if (comments.length < 100) break;
    if (page === 10) throw new Error('MR 评论超过 1000 条，无法确认所有报告链接');
  }
  return links;
}

export function codecheckJobs(run) {
  return (run.stages ?? []).flatMap(stage => stage.jobs ?? [])
    .filter(job => job.name === 'CodeCheck' && job.job_type !== 'workflow_call' && job.id);
}

async function gateReportLinks(mr, timing) {
  const repo = `${mr.owner}/${mr.repo}`;
  let started = performance.now();
  const runs = await gcJson(['actions', 'run', 'list', '-R', repo, '--pr', mr.mrId, '--json', '--paginate']);
  timing?.add('门禁流水线列表', performance.now() - started);
  if (!Array.isArray(runs)) throw new Error('GitCode CLI 未返回 MR 流水线列表');
  const links = new Map();
  for (const run of runs) {
    if (!run.workflow_run_id) continue;
    let detail;
    started = performance.now();
    try { detail = await gcJson(['actions', 'run', 'view', run.workflow_run_id, '-R', repo, '--json']); }
    catch { continue; }
    finally { timing?.add('门禁流水线详情', performance.now() - started); }
    for (const job of codecheckJobs(detail)) {
      const dir = await mkdtemp(join(tmpdir(), 'olb-codecheck-'));
      started = performance.now();
      try {
        const archive = join(dir, 'job.zip');
        await gc(['actions', 'job', 'log', run.workflow_run_id, job.id, '-R', repo, '--output', archive]);
        const zip = await readFile(archive);
        if (!zip.length) continue;
        const log = (await execFileAsync('unzip', ['-p', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout;
        for (const [key, value] of reportLinksFromComments([{ body: log }])) links.set(key, value);
      } catch { /* Missing or unavailable job logs can be supplemented by MR comments. */ }
      finally {
        await rm(dir, { recursive: true, force: true });
        timing?.add('CodeCheck 日志', performance.now() - started);
      }
    }
  }
  return links;
}

async function client() {
  let bin;
  try { bin = realpathSync(execFileSync('which', ['openlibing-cli'], { encoding: 'utf8' }).trim()); }
  catch { throw new Error('未找到官方 openlibing-cli，请先安装 @openlibing/openlibing-cli 并完成登录'); }
  const base = dirname(bin);
  const { authedRequest } = await import(pathToFileURL(join(base, 'auth', 'authedRequest.js')).href);
  return async (url, body, method = 'POST') => {
    const response = await authedRequest(url, { method, ...(body === undefined ? {} : { body }) });
    if (response.code !== 200) throw new Error(`站点接口失败 (${response.code})：${response.msg ?? response.message ?? '未知错误'}`);
    return response;
  };
}

export function resolveProjectId(links, explicitId) {
  if (explicitId !== undefined && explicitId !== '') {
    if (!/^\d+$/.test(String(explicitId))) throw new Error('--project-id 必须是数字');
    return String(explicitId);
  }
  const ids = [...new Set([...links.values()].map(link => new URL(link).searchParams.get('projectId')))];
  if (ids.length !== 1) throw new Error('MR 评论中没有唯一的 OpenLiBing 项目 ID；请指定 --project-id');
  return ids[0];
}

async function scans(request, mr, projectId, timing) {
  const body = { pageNum: 1, pageSize: 100, startTime: '', endTime: '', projectId: String(projectId),
    projectName: '', sourceBranch: '', sigName: '', repoNames: [mr.repo], mrId: mr.mrId, result: '' };
  const found = [];
  do {
    const started = performance.now();
    const page = body.pageNum;
    const originalFetch = globalThis.fetch;
    let headerMs = 0;
    let bodyMs = 0;
    let authMs = 0;
    let fetchCount = 0;
    if (timing) globalThis.fetch = async (...args) => {
      const fetchStarted = performance.now();
      const isSummary = String(args[0]).includes('/v1/codecheck/inc/v1/task/result/summary');
      let response;
      try { response = await originalFetch(...args); }
      finally {
        if (isSummary) {
          headerMs += performance.now() - fetchStarted;
          fetchCount++;
        } else authMs += performance.now() - fetchStarted;
      }
      const originalJson = response.json.bind(response);
      response.json = async () => {
        const bodyStarted = performance.now();
        try { return await originalJson(); }
        finally {
          if (isSummary) bodyMs += performance.now() - bodyStarted;
          else authMs += performance.now() - bodyStarted;
        }
      };
      return response;
    };
    let data;
    try {
      data = (await request(`${CODECHECK}/v1/codecheck/inc/v1/task/result/summary`, body)).data;
    } finally {
      if (timing) {
        globalThis.fetch = originalFetch;
        const total = performance.now() - started;
        timing.add(`扫描记录第 ${page} 页：网络至响应头（${fetchCount} 次）`, headerMs);
        timing.add(`扫描记录第 ${page} 页：读取并解析响应体`, bodyMs);
        if (authMs) timing.add(`扫描记录第 ${page} 页：认证相关网络请求`, authMs);
        timing.add(`扫描记录第 ${page} 页：凭据处理及客户端开销`, Math.max(0, total - headerMs - bodyMs - authMs));
      }
    }
    if (!data?.list) throw new Error('站点未返回扫描记录');
    found.push(...data.list.filter(item => sameMr(item.mrUrl, mr)));
    if (body.pageNum * body.pageSize >= data.total) break;
    body.pageNum++;
  } while (body.pageNum <= 100);
  return found.sort((a, b) => Date.parse(b.executeTime ?? b.executeDate) - Date.parse(a.executeTime ?? a.executeDate));
}

async function issues(request, scan, projectId, status = '') {
  const params = new URLSearchParams({ uuid: scan.uuid, taskId: scan.taskId ?? scan.task_id });
  const body = { pageNum: 1, pageSize: 100, defectStatus: status, flag: '1', projectId: String(projectId),
    projectName: scan.projectName ?? '', repoUrl: scan.repoUrl || scan.gitUrl || '', repoName: scan.repoNameEn ?? '',
    branchName: scan.git_branch ?? '', ruleName: '' };
  const all = [];
  do {
    const result = (await request(`${CODECHECK}/v1/event/codecheck/task?${params}`, body)).result;
    if (!result?.defects) throw new Error('站点未返回问题明细');
    all.push(...result.defects);
    if (body.pageNum * body.pageSize >= result.count) break;
    body.pageNum++;
  } while (body.pageNum <= 100);
  return all;
}

function options(args) {
  const out = {};
  const allowed = new Set(['project-id', 'task-id', 'lines', 'reviewer', 'reason', 'shield-type', 'timing']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timing') {
      if (out.timing) throw new Error('重复参数：--timing');
      out.timing = true;
      continue;
    }
    if (!args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数无效：${args[i]}`);
    const key = args[i++].slice(2);
    if (!allowed.has(key) || key in out) throw new Error(`未知或重复参数：--${key}`);
    out[key] = args[i];
  }
  return out;
}

export async function mrCommand(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    if (argv.length > 1) throw new Error(`未知参数：${argv[1]}`);
    console.log(help.mr);
    return;
  }
  const [action, mrNumber, ...rest] = argv;
  if (['report', 'shield'].includes(action) && ['--help', '-h'].includes(mrNumber) && rest.length === 0) {
    console.log(help[action]);
    return;
  }
  if (!['report', 'shield'].includes(action) || !mrNumber) {
    throw new Error('用法：olb mr report <MR 编号> [--project-id 项目ID] [--task-id 扫描ID]；olb mr shield <MR 编号> --task-id 扫描ID --lines 行号,行号 --reviewer 用户名 --reason 理由 --shield-type 类别ID [--project-id 项目ID]');
  }
  const opt = options(rest);
  if (action === 'report' && ['lines', 'reviewer', 'reason', 'shield-type'].some(key => key in opt))
    throw new Error('report 不接受屏蔽参数');
  if (action === 'shield' && opt.timing) throw new Error('--timing 只适用于 report');
  if (action === 'shield') {
    if (!opt.lines || !opt.reviewer || !opt.reason || !opt['task-id'] || !opt['shield-type'])
      throw new Error('屏蔽需要 --task-id、--lines、--reviewer、--reason 和 --shield-type；类别见 olb mr shield --help');
    if (!/^[0-8]$/.test(opt['shield-type'])) throw new Error('--shield-type 必须是 0 到 8 的类别 ID；类别见 olb mr shield --help');
  }
  const startedAt = performance.now();
  const durations = new Map();
  const timing = opt.timing ? { add(name, ms) { durations.set(name, (durations.get(name) ?? 0) + ms); } } : null;
  const measured = async (name, fn) => {
    const start = performance.now();
    try { return await fn(); }
    finally { timing?.add(name, performance.now() - start); }
  };
  const mr = await measured('解析 MR', () => resolveMr(mrNumber));
  const links = await gateReportLinks(mr, timing).catch(() => new Map());
  const gateKeys = new Set(links.keys());
  for (const [key, value] of await measured('MR 评论', () => gitcodeReportLinks(mr))) if (!links.has(key)) links.set(key, value);
  const request = await measured('初始化 OpenLiBing 客户端', () => client());
  const projectId = resolveProjectId(links, opt['project-id'] ?? process.env.OPENLIBING_PROJECT_ID);
  const records = await scans(request, mr, projectId, timing);
  if (!records.length) { console.log('未找到此 MR 的 OpenLiBing 静态检查报告'); return; }
  if (action === 'report') {
    const output = [];
    const selectedRecords = opt['task-id'] ? records.filter(x => (x.taskId ?? x.task_id) === opt['task-id']) : records.slice(0, 10);
    if (!selectedRecords.length) throw new Error('指定扫描 ID 不属于此 MR');
    for (const scan of selectedRecords) {
      const item = { checkedAt: scan.executeDate ?? scan.executeTime, result: scan.result,
        checkStatus: scan.codeCheckStatus, taskId: scan.taskId ?? scan.task_id,
        issueCount: scan.issue_count,
        reportUrl: null, reportUrlSource: null };
      const link = links.get(`${scan.taskId ?? scan.task_id}:${scan.uuid}`);
      if (link && new URL(link).searchParams.get('projectId') === String(projectId)) {
        item.reportUrl = link;
        item.reportUrlSource = gateKeys.has(`${scan.taskId ?? scan.task_id}:${scan.uuid}`) ? 'gitcode-gate-log' : 'gitcode-mr-comment';
      }
      if (scan.result === 'failed') {
        item.issues = await measured('失败问题明细', () => issues(request, scan, projectId));
      }
      output.push(item);
    }
    const latest = opt['task-id'] ? { checkedAt: records[0].executeDate ?? records[0].executeTime,
      result: records[0].result, checkStatus: records[0].codeCheckStatus,
      taskId: records[0].taskId ?? records[0].task_id } : output[0];
    console.log(JSON.stringify({ mrUrl: mr.url, projectId: Number(projectId), latest,
      scanCount: records.length, scans: output }, null, 2));
    if (timing) {
      const total = performance.now() - startedAt;
      console.error(`耗时总计 ${Math.round(total)} ms`);
      for (const [name, ms] of durations) console.error(`${name}: ${Math.round(ms)} ms (${(ms / total * 100).toFixed(1)}%)`);
    }
    return;
  }
  const lines = new Set(opt.lines.split(',').map(x => x.trim()));
  if ([...lines].some(x => !/^\d+$/.test(x))) throw new Error('--lines 应为逗号分隔的行号');
  const target = records.find(x => (x.taskId ?? x.task_id) === opt['task-id']);
  if (!target) throw new Error('指定扫描 ID 不属于此 MR');
  if (target.result !== 'failed') throw new Error('指定扫描不是失败扫描');
  const open = await issues(request, target, projectId, '0');
  const selected = open.filter(x => lines.has(String(x.lineNumber)));
  if (selected.length !== lines.size || new Set(selected.map(x => String(x.lineNumber))).size !== lines.size)
    throw new Error('行号未唯一匹配待处理问题；请先运行 olb mr report 核对');
  if (selected.some(x => x.defectStatus !== '0')) throw new Error('所选问题已有处理状态，不能重复申请屏蔽');
  const candidate = await request(`${FRAMEWORK}/select/get-committer`, {
    projectId: Number(projectId), repoId: target.repoId, productId: 0,
    filePath: [...new Set(selected.map(x => x.fileName))],
  });
  const reviewers = candidate.data?.filter(x => [x.userName, x.gitcodeName].some(n => n?.toLowerCase() === opt.reviewer.toLowerCase())) ?? [];
  if (reviewers.length !== 1 || !reviewers[0].userId || reviewers[0].unboundPlatform) throw new Error(`未找到唯一且可用的审核人：${opt.reviewer}`);
  const body = { reviewerIds: [reviewers[0].userId], shieldType: opt['shield-type'], reason: opt.reason,
    type: 'inc', projectId: Number(projectId), detailsId: selected.map(x => x.id),
    solutionTime: '', repoUrl: target.repoUrl || target.gitUrl, notifyType: reviewers[0].gitcodeName ? 'EMAIL' : 'MESSAGE' };
  await request(`${CODECHECK}/shield/submit`, body);
  let approvalUrl, linkError;
  try {
    const link = await request(`${CODECHECK}/shield/queryShieldUrl`, {
      detailsId: body.detailsId, type: 'inc', applicationType: 'SHIELD', projectId: Number(projectId),
      uuid: target.uuid, defectIds: selected.map(x => x.defectId).filter(Boolean),
      filePath: [...new Set(selected.map(x => x.fileName))],
    });
    approvalUrl = link.result;
  } catch (error) { linkError = error.message; }
  console.log(JSON.stringify({ submitted: true, reviewer: reviewers[0].userName,
    taskId: opt['task-id'], lines: [...lines], shieldType: opt['shield-type'], reason: opt.reason, approvalUrl, linkError }, null, 2));
}
