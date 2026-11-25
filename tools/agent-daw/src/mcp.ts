import readline from 'node:readline';
import { TOOLS, ToolError, findTool } from './tools.js';

export const SERVER_INFO = { name: 'agent-daw', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

interface Request {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

type Reply = Record<string, unknown> | null;

export function handleMessage(msg: Request): Reply {
  const isNotification = msg.id === undefined;
  const ok = (result: unknown): Reply => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string): Reply => (isNotification ? null : { jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return ok({ protocolVersion: typeof requested === 'string' ? requested : DEFAULT_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = typeof name === 'string' ? findTool(name) : undefined;
      if (tool === undefined) return fail(-32602, `unknown tool ${String(name)}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const r = tool.run(args);
        return ok({ content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }], structuredContent: { ok: r.ok, result: r.data }, isError: !r.ok });
      } catch (err) {
        const message = err instanceof ToolError ? err.message : `${(err as Error).name}: ${(err as Error).message}`;
        return ok({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${String(msg.method)}`);
  }
}

// Newline-delimited JSON-RPC 2.0 on stdio; stdout carries protocol only.
export function serveStdio(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    let msg: Request;
    try {
      msg = JSON.parse(line) as Request;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const reply = handleMessage(msg);
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
