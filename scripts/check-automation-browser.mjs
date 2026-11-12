import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guiRequire = createRequire(join(root, 'apps/gui/package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { createServer } = await import(pathToFileURL(guiRequire.resolve('vite')).href);
const { chromium } = serverRequire('playwright');
const { CreateAutomationRequestSchema, UpdateAutomationRequestSchema, AutomationScheduleKind } =
  await import(pathToFileURL(guiRequire.resolve('@kairos/contracts')).href);
const { fromBinary } = await import(
  pathToFileURL(
    createRequire(guiRequire.resolve('@kairos/contracts')).resolve('@bufbuild/protobuf'),
  ).href
);
const artifacts = await mkdtemp(join(tmpdir(), 'kairos-automation-browser-'));
const child = spawn(
  process.execPath,
  ['--import', 'tsx', 'apps/server/src/integration/settings-browser-fixture.ts'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } },
);
let fixtureError = '';
child.stderr.on('data', (chunk) => {
  fixtureError += chunk;
});
let vite;
let browser;
try {
  const fixture = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(fixtureError || 'Fixture startup timed out.')),
      15000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(fixtureError || 'Fixture exited.'));
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split('\n').find((item) => item.startsWith('{'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
  });
  vite = await createServer({
    root: join(root, 'apps/gui'),
    configFile: join(root, 'apps/gui/vite.config.ts'),
    logLevel: 'error',
    server: {
      port: 0,
      strictPort: false,
      proxy: {
        '/api': {
          target: fixture.baseUrl,
          changeOrigin: true,
          headers: { origin: 'http://127.0.0.1:4317' },
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  });
  await vite.listen();
  const baseUrl = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'Asia/Shanghai',
  });
  await context.addCookies([{ name: 'kairos_session', value: 'test-session-token', url: baseUrl }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await page.getByRole('button', { name: '新建定时任务', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('select').count(), 0);
  assert.ok(!(await dialog.textContent()).includes('cron'));
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('每周摘要');
  await dialog
    .getByRole('textbox', { name: '每次执行的 prompt', exact: true })
    .fill('仅在测试环境总结工作。');
  await dialog.getByRole('checkbox', { name: '保存后启用定时规则' }).uncheck();

  async function choose(label, option) {
    await dialog.getByRole('button', { name: label, exact: true }).click();
    const menu = dialog.getByRole('listbox');
    await menu.waitFor();
    await menu.getByRole('option', { name: option, exact: true }).click();
  }
  await choose('重复', '每周');
  await dialog.getByRole('checkbox', { name: '周三', exact: true }).check();
  await dialog.getByLabel('时间', { exact: true }).fill('08:30');
  await dialog.getByRole('button', { name: '时区', exact: true }).click();
  const search = dialog.getByRole('searchbox', { name: '搜索时区' });
  await search.fill('no-matching-zone');
  assert.equal(await dialog.getByRole('listbox').getByRole('option').count(), 0);
  await search.fill('America/New_York');
  await dialog.getByRole('option', { name: /America\/New_York/ }).click();
  await dialog.getByRole('button', { name: '重复', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByRole('listbox').count(), 0);
  for (const target of ['主对话', '已有话题', '每次新建普通话题', '每次新建定时专属话题']) {
    await choose('执行目标', target);
  }
  const createdRequest = page.waitForRequest((request) =>
    request.url().endsWith('/CreateAutomation'),
  );
  await dialog.getByRole('button', { name: '创建定时任务', exact: true }).click();
  const payload = fromBinary(
    CreateAutomationRequestSchema,
    (await createdRequest).postDataBuffer(),
  );
  assert.equal(payload.schedule.kind, AutomationScheduleKind.CRON);
  assert.equal(payload.schedule.cronExpression, '30 8 * * 1,3');
  assert.equal(payload.schedule.timeZone, 'America/New_York');
  await page.getByRole('heading', { name: '每周摘要', exact: true }).waitFor();
  assert.ok(
    (await page.locator('.automation-definition-heading').textContent()).includes(
      '每周一、三 08:30',
    ),
  );
  await page.getByRole('button', { name: '立即执行', exact: true }).click();
  const history = page.locator('.automation-history');
  await history.getByRole('button', { name: '查看对话', exact: true }).waitFor();
  const historyText = await history.textContent();
  assert.ok(historyText.includes('新话题'));
  assert.ok(historyText.includes('每周摘要'));
  for (const text of ['按接受顺序', 'fire ', 'prompt', '目标', 'Thread', '仅在测试环境总结工作。'])
    assert.ok(!historyText.includes(text));
  await history.getByRole('button', { name: '查看对话', exact: true }).click();
  await page.locator('.conversation-automation').waitFor();
  assert.equal(await page.locator('.conversation-automation .session-compose').count(), 0);
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await page.locator('.automation-row-main').filter({ hasText: '每周摘要' }).click();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  assert.equal(await dialog.getByLabel('时间', { exact: true }).inputValue(), '08:30');
  assert.equal(await dialog.getByRole('checkbox', { name: '周三', exact: true }).isChecked(), true);
  assert.ok(
    (await dialog.getByRole('button', { name: '时区', exact: true }).textContent()).includes(
      'America/New_York',
    ),
  );

  await choose('重复', '每月');
  await choose('日期', '31 日');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await dialog.getByRole('button', { name: '日期', exact: true }).click();
      const menu = dialog.getByRole('listbox');
      await menu.waitFor();
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1000);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: join(artifacts, `monthly-${theme}-${width}.png`),
        fullPage: true,
      });
      await page.keyboard.press('Escape');
    }
  }
  await choose('重复', '每小时');
  await choose('时间', '第 15 分钟');
  const hourlyRequest = page.waitForRequest((request) =>
    request.url().endsWith('/UpdateAutomation'),
  );
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  assert.equal(
    fromBinary(UpdateAutomationRequestSchema, (await hourlyRequest).postDataBuffer()).schedule
      .cronExpression,
    '15 * * * *',
  );
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await choose('重复', '单次执行');
  await dialog.getByLabel('时间', { exact: true }).fill('2050-11-10T09:30');
  const onceRequest = page.waitForRequest((request) => request.url().endsWith('/UpdateAutomation'));
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  const onceSchedule = fromBinary(
    UpdateAutomationRequestSchema,
    (await onceRequest).postDataBuffer(),
  ).schedule;
  assert.equal(onceSchedule.kind, AutomationScheduleKind.ONCE);
  assert.equal(onceSchedule.runAt.seconds, BigInt(Date.parse('2050-11-10T14:30:00Z') / 1000));
  await dialog.waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  assert.equal(await dialog.getByLabel('时间', { exact: true }).inputValue(), '2050-11-10T09:30');
  assert.deepEqual(errors, []);
  process.stdout.write(
    `${JSON.stringify({ status: 'passed', checks: ['repeat-time-create', 'weekly-edit', 'timezone-search', 'modal-dropdown-click', 'keyboard-escape', 'four-targets', 'human-history', 'readonly-conversation', 'monthly-date', 'hourly-save', 'once-timezone-save', 'refresh', 'light-dark', '390px'], artifacts })}\n`,
  );
} finally {
  await browser?.close();
  await vite?.close();
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
}
