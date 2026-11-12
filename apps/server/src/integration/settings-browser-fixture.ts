import { openDatabase } from '../storage/database.js';
import { controlledEnvironmentOperations } from './environment-fixture.js';
import { createTestServer, seedTestSession } from './test-authentication.js';

const database = openDatabase(':memory:');
const server = createTestServer(database, false, {
  environmentOperations: controlledEnvironmentOperations(database),
  model: {
    providerId: 'fixture',
    modelId: 'platform-fixture',
    contextWindowTokens: 128000,
    outputReserveTokens: 4096,
    provider: {
      async *stream() {
        yield {
          type: 'response',
          message: { role: 'assistant', content: '测试回复。' },
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        };
      },
    },
  },
  modelSettings: {
    fetch: async () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'probe', type: 'function', function: { name: 'kairos_settings_probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  },
});
seedTestSession(database, 'other-user', 'other-user-session');
await server.listen({ host: '127.0.0.1', port: 0 });
const address = server.server.address();
if (!address || typeof address === 'string') throw new Error('Fixture address unavailable.');
process.stdout.write(`${JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}` })}\n`);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
