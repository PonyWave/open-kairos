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
const artifacts = await mkdtemp(join(tmpdir(), 'kairos-settings-browser-'));
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
      () => reject(new Error(`Fixture startup timed out: ${fixtureError}`)),
      15000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited: ${fixtureError}`));
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'kairos_session', value: 'test-session-token', url: baseUrl }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '账户资料' }).waitFor();
  assert.match(page.url(), /view=settings&section=account/);
  const username = page.getByRole('textbox', { name: /^用户名/ });
  await username.fill('小林');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.locator('.profile-info', { hasText: '小林' }).waitFor();
  assert.equal(await page.locator('.profile .user-avatar').textContent(), '小');
  assert.equal(Math.round((await page.locator('.profile .user-avatar').boundingBox()).width), 28);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3a8';
    ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = '#fff';
    ctx.font = '80px sans-serif';
    ctx.fillText('林', 150, 135);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择头像图片').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  await page.getByRole('dialog').getByRole('button', { name: '使用此头像' }).click();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.locator('.profile .user-avatar img').waitFor();
  await page.reload();
  await page.locator('.profile .user-avatar img').waitFor();
  await page.getByRole('button', { name: 'Kairos 主对话', exact: true }).click();
  const composer = page.locator('[data-composer-owner="main"] textarea');
  await composer.fill('头像测试');
  await composer.press('Enter');
  await page.locator('.message-avatar.person .user-avatar img').first().waitFor();
  await page.getByText('测试回复。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '移除头像', exact: true }).click();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.profile .user-avatar')?.textContent === '小',
  );
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  const editor = page.locator('.settings-connection-editor');
  await editor.getByRole('textbox', { name: '连接名称', exact: true }).fill('开发模型');
  await editor.getByRole('textbox', { name: /^基础 URL/ }).fill('https://models.example.com/v1');
  await editor.getByLabel(/^API key/).fill('browser-fixture-api-key');
  await editor.getByRole('textbox', { name: '显示名称', exact: true }).fill('日常任务');
  await editor.getByRole('textbox', { name: '模型 ID', exact: true }).fill('browser-model');
  let loseReceipt = true;
  await page.route('**/api/kairos.gui.v1.SettingsService/SaveModelConnection', async (route) => {
    if (loseReceipt) {
      loseReceipt = false;
      const committed = await route.fetch();
      assert.equal(committed.status(), 200);
      await route.abort('failed');
    } else await route.continue();
  });
  await editor.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByRole('button', { name: '重试确认' }).waitFor();
  assert.ok(
    !(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(
      'browser-fixture-api-key',
    ),
  );
  await page.getByRole('button', { name: '重试确认' }).click();
  await page.unroute('**/api/kairos.gui.v1.SettingsService/SaveModelConnection');
  const modelRow = page.locator('.settings-model-row').filter({ hasText: '日常任务' });
  await modelRow.waitFor();
  await modelRow.getByRole('button', { name: '设为默认' }).click();
  await modelRow.getByText('默认', { exact: true }).waitFor();
  await modelRow.getByRole('button', { name: '测试模型' }).click();
  await modelRow.getByRole('status').filter({ hasText: '测试通过' }).waitFor();
  const local = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  assert.ok(!local.includes('browser-fixture-api-key'));
  await page.reload();
  await page.getByRole('heading', { name: '模型配置' }).waitFor();
  assert.match(page.url(), /section=models/);
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.goBack();
  await page.getByRole('heading', { name: '模型配置' }).waitFor();
  await page.goForward();
  await page.getByRole('heading', { name: '账户资料' }).waitFor();
  await page.getByRole('textbox', { name: /^用户名/ }).fill('未保存');
  await page.goBack();
  await page.getByRole('dialog').getByRole('button', { name: '继续编辑' }).click();
  await page.waitForURL('**section=account');
  assert.equal(await page.getByRole('textbox', { name: /^用户名/ }).inputValue(), '未保存');
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '继续编辑' }).click();
  assert.match(page.url(), /section=account/);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃并离开' }).click();
  await page.getByRole('heading', { name: '模型配置' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'settings-models-light.png'), fullPage: true });
  await page.getByRole('button', { name: '切换深色' }).click();
  await page.screenshot({ path: join(artifacts, 'settings-models-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForFunction(
    () => document.querySelector('.thread-sidebar').getBoundingClientRect().right <= 1,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const heading = await page.getByRole('heading', { name: '设置', exact: true }).boundingBox();
  assert.ok(heading.x >= 0 && heading.x + heading.width <= 320);
  await page.screenshot({ path: join(artifacts, 'settings-models-narrow.png'), fullPage: true });
  await context.addCookies([{ name: 'kairos_session', value: 'other-user-session', url: baseUrl }]);
  await page.reload();
  await page.getByRole('heading', { name: '模型配置' }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.settings-models')?.textContent?.includes('正在加载设置'),
  );
  assert.equal(await page.getByText('开发模型', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write(
    `${JSON.stringify({ status: 'passed', checks: ['profile', 'avatar-upload', 'message-avatar', 'avatar-removal', 'model-save', 'default-model', 'model-test', 'secret-storage', 'lost-receipt', 'refresh', 'history', 'unsaved-changes', 'light-dark', '320px', 'account-isolation'], artifacts })}\n`,
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
