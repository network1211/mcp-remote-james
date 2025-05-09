#!/usr/bin/env node
import {
  NodeOAuthClientProvider,
  connectToRemoteServer,
  coordinateAuth,
  getServerUrlHash,
  log,
  mcpProxy,
  parseCommandLineArgs,
  setupSignalHandlers
} from "./chunk-34YNGNHS.js";

// src/proxy.ts
import { EventEmitter } from "events";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
async function runProxy(serverUrl, callbackPort, headers) {
  const events = new EventEmitter();
  const serverUrlHash = getServerUrlHash(serverUrl);
  const { server, waitForAuthCode, skipBrowserAuth } = await coordinateAuth(serverUrlHash, callbackPort, events);
  const authProvider = new NodeOAuthClientProvider({
    serverUrl,
    callbackPort,
    clientName: "MCP CLI Proxy"
  });
  if (skipBrowserAuth) {
    log("Authentication was completed by another instance - will use tokens from disk");
    await new Promise((res) => setTimeout(res, 1e3));
  }
  const localTransport = new StdioServerTransport();
  try {
    const remoteTransport = await connectToRemoteServer(serverUrl, authProvider, headers, waitForAuthCode, skipBrowserAuth);
    mcpProxy({
      transportToClient: localTransport,
      transportToServer: remoteTransport
    });
    await localTransport.start();
    log("Local STDIO server running");
    log("Proxy established successfully between local STDIO and remote SSE");
    log("Press Ctrl+C to exit");
    const cleanup = async () => {
      await remoteTransport.close();
      await localTransport.close();
      server.close();
    };
    setupSignalHandlers(cleanup);
  } catch (error) {
    log("Fatal error:", error);
    if (error instanceof Error && error.message.includes("self-signed certificate in certificate chain")) {
      log(`You may be behind a VPN!

If you are behind a VPN, you can try setting the NODE_EXTRA_CA_CERTS environment variable to point
to the CA certificate file. If using claude_desktop_config.json, this might look like:

{
  "mcpServers": {
    "\${mcpServerName}": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse"
      ],
      "env": {
        "NODE_EXTRA_CA_CERTS": "\${your CA certificate file path}.pem"
      }
    }
  }
}
        `);
    }
    server.close();
    process.exit(1);
  }
}
parseCommandLineArgs(process.argv.slice(2), 3334, "Usage: npx tsx proxy.ts <https://server-url> [callback-port]").then(({ serverUrl, callbackPort, headers }) => {
  return runProxy(serverUrl, callbackPort, headers);
}).catch((error) => {
  log("Fatal error:", error);
  process.exit(1);
});
