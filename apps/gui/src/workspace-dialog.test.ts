import { createRouterTransport } from '@connectrpc/connect';
import { create, WorkspaceSchema } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { WorkspaceDialog } from './workspace-dialog.js';

const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
const noop = () => {};

describe('workspace dialog', () => {
  it('places a compact device select in the path row and reserves a fixed preview area', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceDialog, {
        clients,
        workspace: null,
        onClose: noop,
        onSaved: noop,
      }),
    );
    expect(html).toContain('workspace-env-trigger');
    expect(html).toContain('dropdown-trigger');
    expect(html).toContain('aria-label="设备"');
    expect(html).toContain('workspace-path-row');
    expect(html).toContain('workspace-preview');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="展开目录预览"');
    expect(html).not.toContain('>浏览<');
    expect(html).not.toContain('可选，用于说明该工作空间的用途。');
  });

  it('shows the device and directory read-only with a sidebar switch in edit mode', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceDialog, {
        clients,
        workspace: create(WorkspaceSchema, {
          workspaceId: 'ws-1',
          name: 'Kairos 项目',
          envId: 'main',
          path: '/srv/kairos',
          mainThreadId: 'ws-main',
        }),
        onClose: noop,
        onSaved: noop,
      }),
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('在侧边栏显示');
    expect(html).toContain('workspace-env-static');
    expect(html).toContain('主环境');
    expect(html).toContain('workspace-path-static');
    expect(html).toContain('>/srv/kairos<');
    expect(html).toContain('保存修改');
    expect(html).not.toContain('创建时间');
    expect(html).not.toContain('aria-label="展开目录预览"');
  });
});
