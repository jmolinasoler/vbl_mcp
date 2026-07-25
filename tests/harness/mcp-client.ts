/**
 * In-memory MCP harness: a real MCP client wired to the real server object
 * over a linked transport pair. Exercises tool registration, schemas and
 * handlers without HTTP, and captures the metering records the server emits.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ToolCallRecord } from "../../src/vbl.js";

export interface McpHarness {
  client: Client;
  /** Metering records emitted by the server, in call order. */
  records: ToolCallRecord[];
  /** Calls a tool and returns its parsed JSON payload. */
  call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>;
  /** Calls a tool expecting a tool-level error; returns the error text. */
  callExpectingError(tool: string, args?: Record<string, unknown>): Promise<string>;
  /** Raw call, for asserting on the MCP envelope itself. */
  raw(tool: string, args?: Record<string, unknown>): Promise<any>;
  listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]>;
  close(): Promise<void>;
}

export async function startMcpHarness(): Promise<McpHarness> {
  const records: ToolCallRecord[] = [];
  const server = createServer((rec) => records.push(rec));
  const client = new Client({ name: "test-harness", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const raw = (tool: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: tool, arguments: args }) as Promise<any>;

  const textOf = (result: any): string =>
    (result.content ?? []).map((c: any) => c.text ?? "").join("");

  return {
    client,
    records,
    raw,
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await raw(tool, args);
      const text = textOf(result);
      if (result.isError) throw new Error(`Tool ${tool} returned an error: ${text}`);
      return JSON.parse(text) as T;
    },
    async callExpectingError(tool: string, args: Record<string, unknown> = {}) {
      const result = await raw(tool, args);
      if (!result.isError) {
        throw new Error(`Expected ${tool} to fail, but it succeeded: ${textOf(result)}`);
      }
      return textOf(result);
    },
    async listTools() {
      const { tools } = await client.listTools();
      return tools as any;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
