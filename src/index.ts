import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Initialize the MCP Server
const server = new Server(
  {
    name: "worker-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// Define tools list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "spawn_pi_session",
        description: "Spawn a new pi coding agent session in the specified directory.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "A unique identifier for the session.",
            },
            cwd: {
              type: "string",
              description: "The directory path where the pi agent will execute.",
            },
            model: {
              type: "string",
              description: "LLM model name to override the default (e.g. ollama/qwen2.5-coder:7b).",
            },
            systemPrompt: {
              type: "string",
              description: "Custom system instructions to append.",
            },
          },
          required: ["sessionId", "cwd"],
        },
      },
    ],
  };
});

// Handle tool executions
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "spawn_pi_session": {
        const { sessionId, cwd } = args as { sessionId: string; cwd: string };
        return {
          content: [
            {
              type: "text",
              text: `Successfully initialized session ${sessionId} in ${cwd} (mock)`,
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error.message || String(error),
        },
      ],
    };
  }
});

// Run server using stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("worker-mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main:", error);
  process.exit(1);
});
