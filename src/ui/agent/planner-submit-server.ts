#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  persistSubmittedPlan,
  PLAN_OUT_PATH_ENV,
  SUBMIT_ACTION_PLAN_INPUT_SCHEMA,
  SUBMIT_ACTION_PLAN_TOOL,
} from './planner-submit.js';

const outPath = process.env[PLAN_OUT_PATH_ENV];
if (!outPath) {
  process.stderr.write(`${PLAN_OUT_PATH_ENV} is required\n`);
  process.exit(1);
}

const server = new Server(
  { name: 'action-plan-submit', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: SUBMIT_ACTION_PLAN_TOOL,
      description:
        'Submit the complete Action Plan. Call this exactly once with every Photoshop tool step required. ' +
        'Do not execute Photoshop tools — planning only.',
      inputSchema: SUBMIT_ACTION_PLAN_INPUT_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== SUBMIT_ACTION_PLAN_TOOL) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const result = await persistSubmittedPlan(request.params.arguments, outPath);
  if (!result.ok) {
    return {
      content: [{ type: 'text' as const, text: result.error }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: 'Plan accepted.' }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
