import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    env: {
      // Daemon 资源快照读取的用户主目录。测试必须与工作机真实 home 隔离，
      // 该目录默认不存在，资源加载结果为空快照。
      KAIROS_DEVICE_RESOURCES_HOME: join(tmpdir(), 'kairos-test-resources-home'),
    },
  },
});
