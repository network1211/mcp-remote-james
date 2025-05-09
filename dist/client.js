#!/usr/bin/env node
import {
  MCP_REMOTE_VERSION,
  NodeOAuthClientProvider,
  coordinateAuth,
  getServerUrlHash,
  log,
  parseCommandLineArgs,
  setupSignalHandlers
} from "./chunk-34YNGNHS.js";

// src/client.ts
import { EventEmitter } from "events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ListResourcesResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
async function runClient(serverUrl, callbackPort, headers) {
  const events = new EventEmitter();
  const serverUrlHash = getServerUrlHash(serverUrl);
  const { server, waitForAuthCode, skipBrowserAuth } = await coordinateAuth(serverUrlHash, callbackPort, events);
  const authProvider = new NodeOAuthClientProvider({
    serverUrl,
    callbackPort,
    clientName: "MCP CLI Client"
  });
  if (skipBrowserAuth) {
    log("Authentication was completed by another instance - will use tokens from disk...");
    await new Promise((res) => setTimeout(res, 1e3));
  }
  const client = new Client(
    {
      name: "mcp-remote",
      version: MCP_REMOTE_VERSION
    },
    {
      capabilities: {}
    }
  );
  const url = new URL(serverUrl);
  function initTransport() {
    const transport2 = new SSEClientTransport(url, { authProvider, requestInit: { headers } });
    transport2.onmessage = (message) => {
      log("Received message:", JSON.stringify(message, null, 2));
    };
    transport2.onerror = (error) => {
      log("Transport error:", error);
    };
    transport2.onclose = () => {
      log("Connection closed.");
      process.exit(0);
    };
    return transport2;
  }
  const transport = initTransport();
  const cleanup = async () => {
    log("\nClosing connection...");
    await client.close();
    server.close();
  };
  setupSignalHandlers(cleanup);
  try {
    log("Connecting to server...");
    await client.connect(transport);
    log("Connected successfully!");
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof Error && error.message.includes("Unauthorized")) {
      log("Authentication required. Waiting for authorization...");
      const code = await waitForAuthCode();
      try {
        log("Completing authorization...");
        await transport.finishAuth(code);
        log("Connecting after authorization...");
        await client.connect(initTransport());
        log("Connected successfully!");
        log("Requesting tools list...");
        const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
        log("Tools:", JSON.stringify(tools, null, 2));
        log("Requesting resource list...");
        const resources = await client.request({ method: "resources/list" }, ListResourcesResultSchema);
        log("Resources:", JSON.stringify(resources, null, 2));
        log("Listening for messages. Press Ctrl+C to exit.");
      } catch (authError) {
        log("Authorization error:", authError);
        server.close();
        process.exit(1);
      }
    } else {
      log("Connection error:", error);
      server.close();
      process.exit(1);
    }
  }
  try {
    log("Requesting tools list...");
    const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
    log("Tools:", JSON.stringify(tools, null, 2));
  } catch (e) {
    log("Error requesting tools list:", e);
  }
  try {
    log("Requesting resource list...");
    const resources = await client.request({ method: "resources/list" }, ListResourcesResultSchema);
    log("Resources:", JSON.stringify(resources, null, 2));
  } catch (e) {
    log("Error requesting resources list:", e);
  }
  log("Listening for messages. Press Ctrl+C to exit.");
}
parseCommandLineArgs(process.argv.slice(2), 3333, "Usage: npx tsx client.ts <https://server-url> [callback-port]").then(({ serverUrl, callbackPort, headers }) => {
  return runClient(serverUrl, callbackPort, headers);
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
