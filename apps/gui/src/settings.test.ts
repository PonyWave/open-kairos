/// <reference lib="dom" />
import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import { create, IdentitySchema, ModelApiType } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { MessageAvatar } from './message-avatar.js';
import { modelApiTypePresentation, settingsSectionFromLocation } from './settings-page.js';
import { avatarCrop, SettingsRequests } from './settings-requests.js';
import { UserProfileProvider, usernameInitial } from './user-avatar.js';
import { ThreadDirectory } from './workbench.js';
import { pageFromLocation, workbenchLocation } from './workbench-navigation.js';

describe('settings requests', () => {
  it('retries an unconfirmed sensitive write with its original action and input, and releases it on success', async () => {
    const requests = new SettingsRequests(() => 'stable-action');
    let fail = true;
    const operation = vi.fn(async (id: string) => {
      if (fail) throw new ConnectError('lost response', Code.Unavailable);
      return id;
    });
    await expect(requests.execute(operation)).rejects.toMatchObject({ code: Code.Unavailable });
    expect(requests.pending?.actionId).toBe('stable-action');
    await expect(requests.execute(async () => 'different')).rejects.toThrow(/结果未知/);
    fail = false;
    await expect(requests.pending?.retry()).resolves.toBe('stable-action');
    expect(operation.mock.calls).toEqual([['stable-action'], ['stable-action']]);
    expect(requests.pending).toBeNull();
  });
  it('allows correction after a terminal validation error', async () => {
    const requests = new SettingsRequests();
    await expect(
      requests.execute(async () => {
        throw new ConnectError('invalid', Code.InvalidArgument);
      }),
    ).rejects.toThrow();
    expect(requests.pending).toBeNull();
    await expect(requests.execute(async () => 'fixed')).resolves.toBe('fixed');
  });
});

it('uses the first complete username character in the sidebar and message avatar', () => {
  for (const [username, initial] of [
    ['小林', '小'],
    ['pony', 'p'],
    ['👩‍💻 开发者', '👩‍💻'],
    ['émile', 'é'],
  ])
    expect(usernameInitial(username ?? '')).toBe(initial);
  const identity = create(IdentitySchema, { userId: 'u', username: '小林', tenantId: 't' });
  const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
  const html = renderToStaticMarkup(
    createElement(
      UserProfileProvider,
      {
        identity,
        clients,
      },
      createElement(MessageAvatar, { label: '用户', timestamp: undefined, user: true }),
    ),
  );
  expect(html).toContain('小');
  expect(html).not.toContain('>P<');
});

it('preserves settings selection in canonical locations', () => {
  const directory = new ThreadDirectory({ mainThreadId: 'main' });
  directory.openSettings();
  expect(directory.state.page).toBe('settings');
  expect(pageFromLocation('?view=settings&section=models')).toBe('settings');
  expect(settingsSectionFromLocation('?view=settings&section=invalid')).toBe('account');
  expect(workbenchLocation('settings', null, 'main', 'models')).toBe(
    '?view=settings&section=models',
  );
  expect(workbenchLocation('thread', 'main', 'main', 'account')).toBe('');
  expect(workbenchLocation('thread', 'task / 1', 'main', 'account')).toBe(
    '?view=thread&thread=task%20%2F%201',
  );
});

it('describes all supported API types and rejects unimplemented protocols', () => {
  expect(modelApiTypePresentation(ModelApiType.OPENAI_CHAT_COMPLETIONS)).toMatchObject({
    path: '/chat/completions',
    authentication: expect.stringContaining('Authorization: Bearer'),
  });
  expect(modelApiTypePresentation(ModelApiType.OPENAI_RESPONSES)).toMatchObject({
    label: 'OpenAI Responses',
    path: '/responses',
  });
  expect(modelApiTypePresentation(ModelApiType.ANTHROPIC_MESSAGES)).toMatchObject({
    label: 'Anthropic Messages',
    path: '/v1/messages',
    authentication: expect.stringContaining('x-api-key'),
  });
  expect(() => modelApiTypePresentation(ModelApiType.UNSPECIFIED)).toThrow(/不支持/);
  expect(() => modelApiTypePresentation(99 as ModelApiType)).toThrow(/不支持/);
});

it('keeps cropped image coordinates inside the source and centers the default crop', () => {
  expect(avatarCrop(800, 400, 1, 0.5, 0.5)).toEqual({ x: 200, y: 0, side: 400 });
  expect(avatarCrop(800, 400, 2, 1, 1)).toEqual({ x: 600, y: 200, side: 200 });
});
