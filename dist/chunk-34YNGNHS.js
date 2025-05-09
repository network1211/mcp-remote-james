var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// package.json
var require_package = __commonJS({
  "package.json"(exports, module) {
    module.exports = {
      name: "mcp-remote",
      version: "0.0.22",
      description: "Remote proxy for Model Context Protocol, allowing local-only clients to connect to remote servers using oAuth",
      keywords: [
        "mcp",
        "stdio",
        "sse",
        "remote",
        "oauth"
      ],
      author: "Glen Maddern <glen@cloudflare.com>",
      repository: "https://github.com/geelen/mcp-remote",
      type: "module",
      files: [
        "dist",
        "README.md",
        "LICENSE"
      ],
      main: "dist/index.js",
      bin: {
        "mcp-remote": "dist/proxy.js",
        "mcp-remote-client": "dist/client.js"
      },
      scripts: {
        build: "tsup",
        "build:watch": "tsup --watch",
        check: "prettier --check . && tsc"
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.9.0",
        express: "^4.21.2",
        open: "^10.1.0"
      },
      devDependencies: {
        "@types/express": "^5.0.0",
        "@types/node": "^22.13.10",
        "@types/react": "^19.0.12",
        prettier: "^3.5.3",
        react: "^19.0.0",
        tsup: "^8.4.0",
        tsx: "^4.19.3",
        typescript: "^5.8.2"
      },
      tsup: {
        entry: [
          "src/client.ts",
          "src/proxy.ts"
        ],
        format: [
          "esm"
        ],
        dts: true,
        clean: true,
        outDir: "dist",
        external: [
          "react"
        ]
      }
    };
  }
});

// src/lib/utils.ts
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import express from "express";
import net from "net";
import crypto from "crypto";
var MCP_REMOTE_VERSION = require_package().version;
var pid = process.pid;
function log(str, ...rest) {
  console.error(`[${pid}] ${str}`, ...rest);
}
function mcpProxy({ transportToClient, transportToServer }) {
  let transportToClientClosed = false;
  let transportToServerClosed = false;
  transportToClient.onmessage = (message) => {
    log("[Local\u2192Remote]", message.method || message.id);
    transportToServer.send(message).catch(onServerError);
  };
  transportToServer.onmessage = (message) => {
    log("[Remote\u2192Local]", message.method || message.id);
    transportToClient.send(message).catch(onClientError);
  };
  transportToClient.onclose = () => {
    if (transportToServerClosed) {
      return;
    }
    transportToClientClosed = true;
    transportToServer.close().catch(onServerError);
  };
  transportToServer.onclose = () => {
    if (transportToClientClosed) {
      return;
    }
    transportToServerClosed = true;
    transportToClient.close().catch(onClientError);
  };
  transportToClient.onerror = onClientError;
  transportToServer.onerror = onServerError;
  function onClientError(error) {
    log("Error from local client:", error);
  }
  function onServerError(error) {
    log("Error from remote server:", error);
  }
}
async function connectToRemoteServer(serverUrl, authProvider, headers, waitForAuthCode, skipBrowserAuth = false) {
  log(`[${pid}] Connecting to remote server: ${serverUrl}`);
  const url = new URL(serverUrl);
  const eventSourceInit = {
    fetch: (url2, init) => {
      return Promise.resolve(authProvider?.tokens?.()).then(
        (tokens) => fetch(url2, {
          ...init,
          headers: {
            ...init?.headers,
            ...headers,
            ...tokens?.access_token ? { Authorization: `Bearer ${tokens.access_token}` } : {},
            Accept: "text/event-stream"
          }
        })
      );
    }
  };
  const transport = new SSEClientTransport(url, {
    authProvider,
    requestInit: { headers },
    eventSourceInit
  });
  try {
    await transport.start();
    log("Connected to remote server");
    return transport;
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof Error && error.message.includes("Unauthorized")) {
      if (skipBrowserAuth) {
        log("Authentication required but skipping browser auth - using shared auth");
      } else {
        log("Authentication required. Waiting for authorization...");
      }
      const code = await waitForAuthCode();
      try {
        log("Completing authorization...");
        await transport.finishAuth(code);
        const newTransport = new SSEClientTransport(url, { authProvider, requestInit: { headers } });
        await newTransport.start();
        log("Connected to remote server after authentication");
        return newTransport;
      } catch (authError) {
        log("Authorization error:", authError);
        throw authError;
      }
    } else {
      log("Connection error:", error);
      throw error;
    }
  }
}
function setupOAuthCallbackServerWithLongPoll(options) {
  let authCode = null;
  const app = express();
  let authCompletedResolve;
  const authCompletedPromise = new Promise((resolve) => {
    authCompletedResolve = resolve;
  });
  app.get("/wait-for-auth", (req, res) => {
    if (authCode) {
      log("Auth already completed, returning 200");
      res.status(200).send("Authentication completed");
      return;
    }
    if (req.query.poll === "false") {
      log("Client requested no long poll, responding with 202");
      res.status(202).send("Authentication in progress");
      return;
    }
    const longPollTimeout = setTimeout(() => {
      log("Long poll timeout reached, responding with 202");
      res.status(202).send("Authentication in progress");
    }, 3e4);
    authCompletedPromise.then(() => {
      clearTimeout(longPollTimeout);
      if (!res.headersSent) {
        log("Auth completed during long poll, responding with 200");
        res.status(200).send("Authentication completed");
      }
    }).catch(() => {
      clearTimeout(longPollTimeout);
      if (!res.headersSent) {
        log("Auth failed during long poll, responding with 500");
        res.status(500).send("Authentication failed");
      }
    });
  });
  app.get(options.path, (req, res) => {
    const code = req.query.code;
    if (!code) {
      res.status(400).send("Error: No authorization code received");
      return;
    }
    authCode = code;
    log("Auth code received, resolving promise");
    authCompletedResolve(code);
    res.send("Authorization successful! You may close this window and return to the CLI.");
    options.events.emit("auth-code-received", code);
  });
  const server = app.listen(options.port, () => {
    log(`OAuth callback server running at http://127.0.0.1:${options.port}`);
  });
  const waitForAuthCode = () => {
    return new Promise((resolve) => {
      if (authCode) {
        resolve(authCode);
        return;
      }
      options.events.once("auth-code-received", (code) => {
        resolve(code);
      });
    });
  };
  return { server, authCode, waitForAuthCode, authCompletedPromise };
}
async function findAvailablePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        server.listen(0);
      } else {
        reject(err);
      }
    });
    server.on("listening", () => {
      const { port } = server.address();
      server.close(() => {
        resolve(port);
      });
    });
    server.listen(preferredPort || 0);
  });
}
async function parseCommandLineArgs(args, defaultPort, usage) {
  const headers = {};
  args.forEach((arg, i) => {
    if (arg === "--header" && i < args.length - 1) {
      const value = args[i + 1];
      const match = value.match(/^([A-Za-z0-9_-]+):(.*)$/);
      if (match) {
        headers[match[1]] = match[2];
      } else {
        log(`Warning: ignoring invalid header argument: ${value}`);
      }
      args.splice(i, 2);
    }
  });
  const serverUrl = args[0];
  const specifiedPort = args[1] ? parseInt(args[1]) : void 0;
  const allowHttp = args.includes("--allow-http");
  if (!serverUrl) {
    log(usage);
    process.exit(1);
  }
  const url = new URL(serverUrl);
  const isLocalhost = (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.protocol === "http:";
  if (!(url.protocol == "https:" || isLocalhost || allowHttp)) {
    log("Error: Non-HTTPS URLs are only allowed for localhost or when --allow-http flag is provided");
    log(usage);
    process.exit(1);
  }
  const callbackPort = specifiedPort || await findAvailablePort(defaultPort);
  if (specifiedPort) {
    log(`Using specified callback port: ${callbackPort}`);
  } else {
    log(`Using automatically selected callback port: ${callbackPort}`);
  }
  if (Object.keys(headers).length > 0) {
    log(`Using custom headers: ${JSON.stringify(headers)}`);
  }
  for (const [key, value] of Object.entries(headers)) {
    headers[key] = value.replace(/\$\{([^}]+)}/g, (match, envVarName) => {
      const envVarValue = process.env[envVarName];
      if (envVarValue !== void 0) {
        log(`Replacing ${match} with environment value in header '${key}'`);
        return envVarValue;
      } else {
        log(`Warning: Environment variable '${envVarName}' not found for header '${key}'.`);
        return "";
      }
    });
  }
  return { serverUrl, callbackPort, headers };
}
function setupSignalHandlers(cleanup) {
  process.on("SIGINT", async () => {
    log("\nShutting down...");
    await cleanup();
    process.exit(0);
  });
  process.stdin.resume();
}
function getServerUrlHash(serverUrl) {
  return crypto.createHash("md5").update(serverUrl).digest("hex");
}

// src/lib/node-oauth-client-provider.ts
import open from "open";
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema
} from "@modelcontextprotocol/sdk/shared/auth.js";

// src/lib/mcp-auth-config.ts
import path from "path";
import os from "os";
import fs from "fs/promises";
async function createLockfile(serverUrlHash, pid2, port) {
  const lockData = {
    pid: pid2,
    port,
    timestamp: Date.now()
  };
  await writeJsonFile(serverUrlHash, "lock.json", lockData);
}
async function checkLockfile(serverUrlHash) {
  try {
    const lockfile = await readJsonFile(serverUrlHash, "lock.json", {
      async parseAsync(data) {
        if (typeof data !== "object" || data === null) return null;
        if (typeof data.pid !== "number" || typeof data.port !== "number" || typeof data.timestamp !== "number") {
          return null;
        }
        return data;
      }
    });
    return lockfile || null;
  } catch {
    return null;
  }
}
async function deleteLockfile(serverUrlHash) {
  await deleteConfigFile(serverUrlHash, "lock.json");
}
function getConfigDir() {
  const baseConfigDir = process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), ".mcp-auth");
  return path.join(baseConfigDir, `mcp-remote-${MCP_REMOTE_VERSION}`);
}
async function ensureConfigDir() {
  try {
    const configDir = getConfigDir();
    await fs.mkdir(configDir, { recursive: true });
  } catch (error) {
    log("Error creating config directory:", error);
    throw error;
  }
}
function getConfigFilePath(serverUrlHash, filename) {
  const configDir = getConfigDir();
  return path.join(configDir, `${serverUrlHash}_${filename}`);
}
async function deleteConfigFile(serverUrlHash, filename) {
  try {
    const filePath = getConfigFilePath(serverUrlHash, filename);
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      log(`Error deleting ${filename}:`, error);
    }
  }
}
async function readJsonFile(serverUrlHash, filename, schema) {
  try {
    await ensureConfigDir();
    const filePath = getConfigFilePath(serverUrlHash, filename);
    const content = await fs.readFile(filePath, "utf-8");
    const result = await schema.parseAsync(JSON.parse(content));
    return result;
  } catch (error) {
    if (error.code === "ENOENT") {
      return void 0;
    }
    log(`Error reading ${filename}:`, error);
    return void 0;
  }
}
async function writeJsonFile(serverUrlHash, filename, data) {
  try {
    await ensureConfigDir();
    const filePath = getConfigFilePath(serverUrlHash, filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    log(`Error writing ${filename}:`, error);
    throw error;
  }
}
async function readTextFile(serverUrlHash, filename, errorMessage) {
  try {
    await ensureConfigDir();
    const filePath = getConfigFilePath(serverUrlHash, filename);
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(errorMessage || `Error reading ${filename}`);
  }
}
async function writeTextFile(serverUrlHash, filename, text) {
  try {
    await ensureConfigDir();
    const filePath = getConfigFilePath(serverUrlHash, filename);
    await fs.writeFile(filePath, text, "utf-8");
  } catch (error) {
    log(`Error writing ${filename}:`, error);
    throw error;
  }
}

// src/lib/node-oauth-client-provider.ts
var NodeOAuthClientProvider = class {
  /**
   * Creates a new NodeOAuthClientProvider
   * @param options Configuration options for the provider
   */
  constructor(options) {
    this.options = options;
    this.serverUrlHash = getServerUrlHash(options.serverUrl);
    this.callbackPath = options.callbackPath || "/oauth/callback";
    this.clientName = options.clientName || "MCP CLI Client";
    this.clientUri = options.clientUri || "https://github.com/modelcontextprotocol/mcp-cli";
    this.softwareId = options.softwareId || "2e6dc280-f3c3-4e01-99a7-8181dbd1d23d";
    this.softwareVersion = options.softwareVersion || MCP_REMOTE_VERSION;
  }
  serverUrlHash;
  callbackPath;
  clientName;
  clientUri;
  softwareId;
  softwareVersion;
  get redirectUrl() {
    return `http://127.0.0.1:${this.options.callbackPort}${this.callbackPath}`;
  }
  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.clientName,
      client_uri: this.clientUri,
      software_id: this.softwareId,
      software_version: this.softwareVersion
    };
  }
  /**
   * Gets the client information if it exists
   * @returns The client information or undefined
   */
  async clientInformation() {
    return readJsonFile(this.serverUrlHash, "client_info.json", OAuthClientInformationSchema);
  }
  /**
   * Saves client information
   * @param clientInformation The client information to save
   */
  async saveClientInformation(clientInformation) {
    await writeJsonFile(this.serverUrlHash, "client_info.json", clientInformation);
  }
  /**
   * Gets the OAuth tokens if they exist
   * @returns The OAuth tokens or undefined
   */
  async tokens() {
    return readJsonFile(this.serverUrlHash, "tokens.json", OAuthTokensSchema);
  }
  /**
   * Saves OAuth tokens
   * @param tokens The tokens to save
   */
  async saveTokens(tokens) {
    await writeJsonFile(this.serverUrlHash, "tokens.json", tokens);
  }
  /**
   * Redirects the user to the authorization URL
   * @param authorizationUrl The URL to redirect to
   */
  async redirectToAuthorization(authorizationUrl) {
    log(`
Please authorize this client by visiting:
${authorizationUrl.toString()}
`);
    try {
      await open(authorizationUrl.toString());
      log("Browser opened automatically.");
    } catch (error) {
      log("Could not open browser automatically. Please copy and paste the URL above into your browser.");
    }
  }
  /**
   * Saves the PKCE code verifier
   * @param codeVerifier The code verifier to save
   */
  async saveCodeVerifier(codeVerifier) {
    await writeTextFile(this.serverUrlHash, "code_verifier.txt", codeVerifier);
  }
  /**
   * Gets the PKCE code verifier
   * @returns The code verifier
   */
  async codeVerifier() {
    return await readTextFile(this.serverUrlHash, "code_verifier.txt", "No code verifier saved for session");
  }
};

// src/lib/coordination.ts
import express2 from "express";
async function isPidRunning(pid2) {
  try {
    process.kill(pid2, 0);
    return true;
  } catch {
    return false;
  }
}
async function isLockValid(lockData) {
  const MAX_LOCK_AGE = 30 * 60 * 1e3;
  if (Date.now() - lockData.timestamp > MAX_LOCK_AGE) {
    log("Lockfile is too old");
    return false;
  }
  if (!await isPidRunning(lockData.pid)) {
    log("Process from lockfile is not running");
    return false;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1e3);
    const response = await fetch(`http://127.0.0.1:${lockData.port}/wait-for-auth?poll=false`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response.status === 200 || response.status === 202;
  } catch (error) {
    log(`Error connecting to auth server: ${error.message}`);
    return false;
  }
}
async function waitForAuthentication(port) {
  log(`Waiting for authentication from the server on port ${port}...`);
  try {
    while (true) {
      const url = `http://127.0.0.1:${port}/wait-for-auth`;
      log(`Querying: ${url}`);
      const response = await fetch(url);
      if (response.status === 200) {
        log(`Authentication completed by other instance`);
        return true;
      } else if (response.status === 202) {
        log(`Authentication still in progress`);
        await new Promise((resolve) => setTimeout(resolve, 1e3));
      } else {
        log(`Unexpected response status: ${response.status}`);
        return false;
      }
    }
  } catch (error) {
    log(`Error waiting for authentication: ${error.message}`);
    return false;
  }
}
async function coordinateAuth(serverUrlHash, callbackPort, events) {
  const lockData = process.platform === "win32" ? null : await checkLockfile(serverUrlHash);
  if (lockData && await isLockValid(lockData)) {
    log(`Another instance is handling authentication on port ${lockData.port}`);
    try {
      const authCompleted = await waitForAuthentication(lockData.port);
      if (authCompleted) {
        log("Authentication completed by another instance");
        const dummyServer = express2().listen(0);
        const dummyWaitForAuthCode = () => {
          log("WARNING: waitForAuthCode called in secondary instance - this is unexpected");
          return new Promise(() => {
          });
        };
        return {
          server: dummyServer,
          waitForAuthCode: dummyWaitForAuthCode,
          skipBrowserAuth: true
        };
      } else {
        log("Taking over authentication process...");
      }
    } catch (error) {
      log(`Error waiting for authentication: ${error}`);
    }
    await deleteLockfile(serverUrlHash);
  } else if (lockData) {
    log("Found invalid lockfile, deleting it");
    await deleteLockfile(serverUrlHash);
  }
  const { server, waitForAuthCode, authCompletedPromise } = setupOAuthCallbackServerWithLongPoll({
    port: callbackPort,
    path: "/oauth/callback",
    events
  });
  const address = server.address();
  const actualPort = address.port;
  log(`Creating lockfile for server ${serverUrlHash} with process ${process.pid} on port ${actualPort}`);
  await createLockfile(serverUrlHash, process.pid, actualPort);
  const cleanupHandler = async () => {
    try {
      log(`Cleaning up lockfile for server ${serverUrlHash}`);
      await deleteLockfile(serverUrlHash);
    } catch (error) {
      log(`Error cleaning up lockfile: ${error}`);
    }
  };
  process.once("exit", () => {
    try {
      const configPath = getConfigFilePath(serverUrlHash, "lock.json");
      __require("fs").unlinkSync(configPath);
    } catch {
    }
  });
  process.once("SIGINT", async () => {
    await cleanupHandler();
  });
  return {
    server,
    waitForAuthCode,
    skipBrowserAuth: false
  };
}

export {
  MCP_REMOTE_VERSION,
  log,
  mcpProxy,
  connectToRemoteServer,
  parseCommandLineArgs,
  setupSignalHandlers,
  getServerUrlHash,
  NodeOAuthClientProvider,
  coordinateAuth
};
