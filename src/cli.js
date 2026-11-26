import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright';
import { help } from './help.js';

export const DEFAULT_URL = 'https://www.openlibing.com/apps/entryCheckDashCode/MR_1658a685f7de45ceaf584732ce794d7a/2d4400d60537dc3b46b98f764f7b3a62?projectId=300033&codeHostingPlatformFlag=gitcode';
const ORIGIN = 'https://www.openlibing.com';
const SESSION_NAME = 'session.json';

export function targetUrl(value = DEFAULT_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的 openLiBing 页面 URL'); }
  if (url.origin !== ORIGIN) throw new Error(`只允许访问 ${ORIGIN} 的页面`);
  return url.href;
}

export function profilePath(value) {
  return resolve(value ?? join(homedir(), '.config', 'openlibing-cli', 'browser'));
}

function parseArgs(args) {
  const command = args.shift() ?? 'help';
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile' || arg === '--url' || arg === '--file') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} 需要一个值`);
      options[arg.slice(2)] = args[++i];
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { command, options };
}

async function hasProfile(path) {
  try { return (await readdir(path)).length > 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function browserSession(url, profile, command) {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      ...(process.env.OLB_BROWSER_PATH ? { executablePath: process.env.OLB_BROWSER_PATH } : {}),
    });
  } catch (error) {
    if (error.message.includes("Executable doesn't exist")) throw new Error('未找到浏览器，请运行 npx playwright install chromium，或设置 OLB_BROWSER_PATH 指向本机 Chromium');
    if (error.message.includes('error while loading shared libraries')) throw new Error('浏览器缺少系统库，请运行 npx playwright install-deps chromium，或使用已安装的本机 Chromium');
    if (error.message.includes('Missing X server') || error.message.includes('no DISPLAY')) throw new Error('当前终端没有图形桌面，请在有桌面环境的终端运行 olb login');
    throw error;
  }
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`浏览器已打开：${page.url()}`);
    if (command === 'login') console.log('请在浏览器中按站点提示完成登录。');
    console.log('完成后回到终端按 Enter，浏览器会话会保存在本机。');
    const input = createInterface({ input: stdin, output: stdout });
    try { await input.question('按 Enter 关闭浏览器…'); }
    finally { input.close(); }
    if (command === 'login') return await captureSession(context, page);
  } finally {
    await context.close();
  }
}

function allowedCookie(cookie) {
  return /(^|\.)openlibing\.com$/.test(cookie.domain.replace(/^\./, ''));
}

async function captureSession(context, page) {
  const state = await context.storageState({ indexedDB: true });
  const sessionStorage = new URL(page.url()).origin === ORIGIN
    ? await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)))
    : {};
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    storageState: {
      cookies: state.cookies.filter(allowedCookie),
      origins: state.origins.filter(origin => origin.origin === ORIGIN),
    },
    sessionStorage,
  };
}

function validateSession(value) {
  if (value?.version !== 1 || !Array.isArray(value.storageState?.cookies) ||
      !Array.isArray(value.storageState?.origins) ||
      !value.storageState.cookies.every(allowedCookie) ||
      !value.storageState.origins.every(origin => origin.origin === ORIGIN) ||
      typeof value.sessionStorage !== 'object' || value.sessionStorage === null ||
      Array.isArray(value.sessionStorage)) throw new Error('会话文件格式无效');
  return value;
}

async function saveSession(file, session) {
  await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(session, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
    await chmod(file, 0o600);
  } finally { await rm(temp, { force: true }); }
}

async function checkSession(file, url) {
  const session = validateSession(JSON.parse(await readFile(file, 'utf8')));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.OLB_BROWSER_PATH ? { executablePath: process.env.OLB_BROWSER_PATH } : {}),
  });
  try {
    const context = await browser.newContext({ storageState: session.storageState });
    await context.addInitScript(({ origin, items }) => {
      if (location.origin === origin) for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, value);
    }, { origin: ORIGIN, items: session.sessionStorage });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`HTTP ${response?.status() ?? '未知'}  ${page.url()}`);
    console.log(`页面标题：${await page.title()}`);
    if (response?.status() === 418) console.log('站点防护拦截了当前机器的请求，不能由此判断会话是否有效。');
  } finally { await browser.close(); }
}

export async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    if (argv.length > 1 && argv[0] !== 'help') throw new Error(`未知参数：${argv[1]}`);
    const topic = argv[1] ?? 'root';
    if (!(topic in help) || argv.length > 2) throw new Error(`未知帮助主题：${topic}`);
    console.log(help[topic]);
    return;
  }
  if (argv[0] === 'mr') {
    const { mrCommand } = await import('./mr.js');
    return mrCommand(argv.slice(1));
  }
  const { command, options } = parseArgs([...argv]);
  if (!['login', 'export', 'import', 'check', 'open', 'status', 'logout'].includes(command)) throw new Error(`未知命令：${command}`);
  if (options.url && !['login', 'export', 'check', 'open'].includes(command)) throw new Error('--url 只适用于 login、export、check 和 open');
  if (options.file && !['export', 'import'].includes(command)) throw new Error('--file 只适用于 export 和 import');
  const profile = profilePath(options.profile);
  const sessionFile = join(profile, SESSION_NAME);
  if (command === 'export' || command === 'import') {
    if (!options.file) throw new Error('请用 --file 指定会话文件');
    const file = resolve(options.file);
    if (command === 'export') {
      const session = await browserSession(targetUrl(options.url), profile, 'login');
      await saveSession(file, session);
      console.log(`会话已导出：${file}`);
    } else {
      const session = validateSession(JSON.parse(await readFile(file, 'utf8')));
      await saveSession(sessionFile, session);
      console.log(`会话已导入：${sessionFile}`);
    }
    return;
  }
  if (command === 'check') {
    await checkSession(sessionFile, targetUrl(options.url));
    return;
  }
  if (command === 'status') {
    console.log(await hasProfile(profile) ? `本机会话目录已存在：${profile}
是否仍已登录，请运行 olb open 或 olb check 确认。` : `尚无本机会话：${profile}`);
    return;
  }
  if (command === 'logout') {
    await rm(profile, { recursive: true, force: true });
    console.log(`已删除本机会话：${profile}`);
    return;
  }
  if (command === 'open' && !(await hasProfile(profile))) throw new Error('尚无本机会话，请先运行 olb login');
  const session = await browserSession(targetUrl(options.url), profile, command);
  if (command === 'login') await saveSession(sessionFile, session);
}
