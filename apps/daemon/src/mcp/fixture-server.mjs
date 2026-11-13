import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'echo') {
    return {
      content: [{ type: 'text', text: `echo:${String(request.params.arguments?.text ?? '')}` }],
    };
  }
  if (request.params.name === 'fail') {
    return { content: [{ type: 'text', text: 'intentional failure' }], isError: true };
  }
  throw new Error(`Unknown tool ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
