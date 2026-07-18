import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SessionManager } from "./session/session-manager.js";

// Instantiate session manager
const sessionManager = new SessionManager();

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
        description: "Spawn a new pi coding agent session in the specified workspace directory.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "A unique identifier for the session.",
            },
            cwd: {
              type: "string",
              description: "The absolute directory path where the pi agent will execute.",
            },
            model: {
              type: "string",
              description: "LLM model name override (e.g. ollama/qwen2.5-coder:7b or anthropic/claude-3-5-sonnet).",
            },
            systemPrompt: {
              type: "string",
              description: "Custom system instructions to append/override.",
            },
          },
          required: ["sessionId", "cwd"],
        },
      },
      {
        name: "send_pi_command",
        description: "Send a prompt or slash command to a running session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The ID of the target session.",
            },
            command: {
              type: "string",
              description: "The text prompt or slash command (e.g. '/model', '/reload', or 'Implement main function').",
            },
          },
          required: ["sessionId", "command"],
        },
      },
      {
        name: "list_pi_sessions",
        description: "List all active sessions and their status.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_pending_actions",
        description: "Retrieve details of a tool call or action currently awaiting approval.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The target session ID.",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "approve_action",
        description: "Approve an intercepted tool execution.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The target session ID.",
            },
            actionId: {
              type: "string",
              description: "The ID of the intercepted tool call/action.",
            },
          },
          required: ["sessionId", "actionId"],
        },
      },
      {
        name: "reject_action",
        description: "Deny an intercepted tool execution and feed feedback/refusal back to the agent.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The target session ID.",
            },
            actionId: {
              type: "string",
              description: "The ID of the intercepted tool call/action.",
            },
            reason: {
              type: "string",
              description: "Optional feedback or reason for rejection to guide the agent.",
            },
          },
          required: ["sessionId", "actionId"],
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
        const { sessionId, cwd, model, systemPrompt } = args as {
          sessionId: string;
          cwd: string;
          model?: string;
          systemPrompt?: string;
        };
        const session = await sessionManager.createSession(sessionId, cwd, model, systemPrompt);
        return {
          content: [
            {
              type: "text",
              text: `Successfully initialized and started session ${sessionId} in ${cwd} (Status: ${session.status})`,
            },
          ],
        };
      }

      case "send_pi_command": {
        const { sessionId, command } = args as { sessionId: string; command: string };
        const session = sessionManager.getSession(sessionId);
        
        // This initiates command run in background, resolving when command completes or settles
        const result = await session.sendCommand(command);
        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      }

      case "list_pi_sessions": {
        const list = sessionManager.listSessions();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(list, null, 2),
            },
          ],
        };
      }

      case "get_pending_actions": {
        const { sessionId } = args as { sessionId: string };
        const session = sessionManager.getSession(sessionId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(session.pendingAction, null, 2),
            },
          ],
        };
      }

      case "approve_action": {
        const { sessionId, actionId } = args as { sessionId: string; actionId: string };
        const session = sessionManager.getSession(sessionId);
        await session.approveAction(actionId);
        return {
          content: [
            {
              type: "text",
              text: `Action ${actionId} approved. Resuming execution loop.`,
            },
          ],
        };
      }

      case "reject_action": {
        const { sessionId, actionId, reason } = args as {
          sessionId: string;
          actionId: string;
          reason?: string;
        };
        const session = sessionManager.getSession(sessionId);
        await session.rejectAction(actionId, reason);
        return {
          content: [
            {
              type: "text",
              text: `Action ${actionId} rejected. Feedback dispatched to agent.`,
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

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const sessions = sessionManager.listSessions();
  const resources = [];
  
  for (const s of sessions) {
    resources.push({
      uri: `worker-mcp://sessions/${s.sessionId}/history`,
      name: `Session ${s.sessionId} Message History`,
      mimeType: "application/json",
      description: `Complete message event history exchanged in session ${s.sessionId}`,
    });
    resources.push({
      uri: `worker-mcp://sessions/${s.sessionId}/logs`,
      name: `Session ${s.sessionId} Log Traces`,
      mimeType: "text/plain",
      description: `Subprocess stdout/stderr log traces for session ${s.sessionId}`,
    });
  }
  
  return { resources };
});

// Read resources content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const url = new URL(request.params.uri);
    
    // worker-mcp://sessions/{sessionId}/{history|logs}
    if (url.protocol !== "worker-mcp:") {
      throw new Error(`Unsupported protocol: ${url.protocol}`);
    }
    
    const match = url.pathname.match(/^\/([^\/]+)\/(history|logs)$/);
    if (!match) {
      throw new Error(`Invalid resource URI path: ${url.pathname}`);
    }
    
    const [, sessionId, type] = match;
    const session = sessionManager.getSession(sessionId);

    if (type === "history") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(session.history, null, 2),
          },
        ],
      };
    } else {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/plain",
            text: session.logs.join("\n"),
          },
        ],
      };
    }
  } catch (error: any) {
    throw new Error(`Failed to read resource: ${error.message}`);
  }
});

// Run server using stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("worker-mcp server running on stdio");
}

// Clean up child processes on termination signals
const handleShutdown = () => {
  console.error("Shutdown signal received. Terminating all active worker processes...");
  sessionManager.terminateAll();
  process.exit(0);
};

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);

main().catch((error) => {
  console.error("Fatal error in main:", error);
  sessionManager.terminateAll();
  process.exit(1);
});
