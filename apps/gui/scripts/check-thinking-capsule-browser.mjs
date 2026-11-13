import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const guiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(guiRoot));
const guiRequire = createRequire(join(guiRoot, 'package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { createServer } = await import(pathToFileURL(guiRequire.resolve('vite')).href);
const { chromium } = serverRequire('playwright');

let vite;
let browser;
try {
  vite = await createServer({
    root: guiRoot,
    configFile: join(guiRoot, 'vite.config.ts'),
    logLevel: 'error',
    server: { port: 0, strictPort: false },
  });
  await vite.listen();
  const baseUrl = vite.resolvedUrls.local[0];
  assert.ok(baseUrl);
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const apiRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await page.goto(new URL('/thinking-capsule-fixture.html', baseUrl).href);

  const capsule = page.locator('#capsule-fixture');
  const details = capsule.locator('details.tool-group');
  await details.waitFor();
  assert.equal(await details.count(), 1);
  assert.equal(await details.evaluate((element) => element instanceof HTMLDetailsElement), true);
  const groupId = await details.getAttribute('data-operation');
  assert.equal(groupId, 'group:fixture-first:thinking:0');
  assert.equal(await details.evaluate((element) => element.open), false);
  assert.equal(await capsule.locator('.thinking-detail').count(), 0);

  await page.evaluate(() => {
    window.__thinkingCapsuleToggleCount = 0;
    const details = document.querySelector('#capsule-fixture details.tool-group');
    if (!(details instanceof HTMLDetailsElement)) throw new Error('Missing native details.');
    details.addEventListener('toggle', () => {
      window.__thinkingCapsuleToggleCount += 1;
    });
  });

  let expectedToggleCount = 0;
  let expectedThinkingChoice = null;
  async function readExpansionState() {
    const text = await page.locator('#fixture-expansion-state').textContent();
    assert.ok(text);
    return JSON.parse(text);
  }

  async function waitForChoices(group, thinking) {
    await page.waitForFunction(
      ({ group, thinking }) => {
        const output = document.getElementById('fixture-expansion-state');
        if (!output) return false;
        const state = JSON.parse(output.textContent || '{}');
        return state.group === group && state.thinking === thinking;
      },
      { group, thinking },
    );
  }

  async function clickSummary(expanded) {
    expectedToggleCount += 1;
    await details.locator(':scope > summary').click();
    await page.waitForFunction(
      ({ expanded, expectedToggleCount }) => {
        const details = document.querySelector('#capsule-fixture details.tool-group');
        return (
          details instanceof HTMLDetailsElement &&
          details.open === expanded &&
          window.__thinkingCapsuleToggleCount === expectedToggleCount
        );
      },
      { expanded, expectedToggleCount },
    );
    await waitForChoices(expanded, expectedThinkingChoice);
    assert.equal(await details.evaluate((element) => element.open), expanded);
  }

  async function clickContinuationThinking(expanded) {
    expectedThinkingChoice = expanded;
    await capsule.locator('.thinking-toggle').nth(1).click();
    await waitForChoices((await readExpansionState()).group, expanded);
    assert.equal(await capsule.locator('.thinking-detail').count(), expanded ? 1 : 0);
  }

  async function assertSingleGroupIdentity() {
    assert.equal(await details.count(), 1);
    assert.equal(await details.getAttribute('data-operation'), groupId);
  }

  assert.deepEqual(await readExpansionState(), { group: null, thinking: null });
  await clickSummary(true);
  assert.equal(await capsule.locator('.thinking-detail').count(), 0);
  await clickContinuationThinking(true);
  await capsule.locator('.thinking-detail').filter({ hasText: '后续纯思考' }).waitFor();
  await clickContinuationThinking(false);

  await clickSummary(false);
  await page.locator('#append-third').click();
  await capsule.locator('[data-tool-call-id="read-fixture-third"]').waitFor({ state: 'attached' });
  await assertSingleGroupIdentity();
  assert.equal(await details.evaluate((element) => element.open), false);
  assert.deepEqual(await readExpansionState(), { group: false, thinking: false });

  await clickSummary(true);
  assert.equal(await capsule.locator('.thinking-detail').count(), 0);
  await clickContinuationThinking(true);
  await page.locator('#append-fourth').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#capsule-fixture .thinking-toggle').length === 3,
  );
  await assertSingleGroupIdentity();
  assert.equal(await details.evaluate((element) => element.open), true);
  assert.deepEqual(await readExpansionState(), { group: true, thinking: true });
  await capsule.locator('.thinking-detail').filter({ hasText: '后续纯思考' }).waitFor();

  await page.locator('#persist').click();
  await page.waitForFunction(
    () => document.getElementById('fixture-conversation')?.dataset.stage === '3',
  );
  await assertSingleGroupIdentity();
  assert.equal(await details.evaluate((element) => element.open), true);
  assert.deepEqual(await readExpansionState(), { group: true, thinking: true });
  await capsule.locator('.thinking-detail').filter({ hasText: '后续纯思考' }).waitFor();
  assert.equal(await capsule.getByText('思考中', { exact: true }).count(), 0);

  const ordered = page.locator('#ordered-fixture');
  const orderedGroup = ordered.locator('details.tool-group');
  assert.equal(await orderedGroup.count(), 1);
  assert.equal(await orderedGroup.evaluate((element) => element.open), false);
  await orderedGroup.locator(':scope > summary').click();
  assert.equal(await orderedGroup.evaluate((element) => element.open), true);
  const orderedThinking = ordered.locator('.thinking-toggle');
  assert.equal(await orderedThinking.count(), 2);
  await orderedThinking.nth(0).click();
  await orderedThinking.nth(1).click();
  const orderedCalls = ordered.locator('details[data-tool-call-id]');
  assert.equal(await orderedCalls.count(), 2);
  await orderedCalls.nth(0).locator(':scope > summary').click();
  await orderedCalls.nth(1).locator(':scope > summary').click();
  await page.waitForFunction(() => {
    const text = document.getElementById('ordered-fixture')?.textContent ?? '';
    const markers = [
      '正文之前',
      '第一段有序思考',
      'read-ordered',
      '第二段有序思考',
      'bash-ordered',
      '正文之后',
    ];
    const positions = markers.map((marker) => text.indexOf(marker));
    return (
      positions.every((position) => position >= 0) &&
      positions.every((position, index) => index === 0 || positions[index - 1] < position)
    );
  });

  const singleTool = page.locator('#single-tool-fixture');
  assert.equal(await singleTool.locator('details.tool-group').count(), 0);
  assert.equal(await singleTool.locator('[data-tool-call-id="single-tool-call"]').count(), 1);
  const singleThinking = page.locator('#single-thinking-fixture');
  assert.equal(await singleThinking.locator('details.tool-group').count(), 0);
  await singleThinking.locator('.thinking-toggle').click();
  const singleThinkingText = await singleThinking.textContent();
  assert.ok(singleThinkingText);
  assert.ok(singleThinkingText.indexOf('唯一思考') < singleThinkingText.indexOf('后续正文'));
  const twoThinking = page.locator('#two-thinking-fixture');
  assert.equal(await twoThinking.locator('details.tool-group').count(), 1);
  assert.equal(
    await twoThinking.locator('details.tool-group').evaluate((element) => element.open),
    false,
  );

  const fullSend = page.locator('#full-send-fixture');
  assert.equal(await fullSend.locator('.sent-user-message').count(), 1);
  assert.equal(await fullSend.locator('[data-user-message-call-id="send-1"]').count(), 1);
  assert.equal(await fullSend.locator('.sent-message-bubble').count(), 1);
  assert.equal(await fullSend.locator('.sent-message-tag').count(), 1);
  assert.equal(await fullSend.locator('[data-tool-call-id="send-1"]').count(), 0);
  const fullText = await fullSend.textContent();
  assert.ok(fullText?.includes('回复用户'));
  assert.ok(!fullText?.includes('发送详情'));
  assert.ok(fullText?.includes('正式回复'));
  const compactSend = page.locator('#compact-send-fixture');
  assert.equal(await compactSend.locator('[data-tool-call-id="send-1"]').count(), 0);
  assert.equal(await compactSend.locator('[data-user-message-call-id="send-1"]').count(), 1);
  assert.equal(await compactSend.locator('.sent-message-bubble').count(), 1);
  assert.equal(await compactSend.locator('.sent-message-tag').count(), 0);
  const compactText = await compactSend.textContent();
  assert.ok(compactText?.includes('正式回复'));
  assert.ok(!compactText?.includes('发送详情'));

  assert.deepEqual(errors, []);
  assert.deepEqual(apiRequests, []);

  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      browser: 'headless Chromium',
      checks: [
        'HTMLDetailsElement',
        'summary-click-native-toggle',
        'React-expansion-state',
        'collapsed-choice-after-third-operation',
        'expanded-choice-after-fourth-operation',
        'persisted-reprojection',
        'ordered-text-and-operations',
        'single-operation-lines',
        'two-thinking-capsule',
        'full-send-bubble',
        'compact-send-bubble',
        'no-api-requests',
      ],
      toggleEvents: expectedToggleCount,
    })}\n`,
  );
} finally {
  await browser?.close();
  await vite?.close();
}
