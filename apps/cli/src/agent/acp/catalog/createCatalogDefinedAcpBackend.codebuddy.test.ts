import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { SessionId } from '@/agent/core';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

const { launchSpec } = vi.hoisted(() => ({ launchSpec: { command: '', args: [] as string[] } }));

// Managed-tool resolution reads the user's install; point it at a scripted ACP agent subprocess instead.
vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: () => ({ command: launchSpec.command, args: [...launchSpec.args] }),
}));

import { createCatalogDefinedAcpBackend } from './createCatalogDefinedAcpBackend';

type RecordedRequest = Readonly<{ method: string; params: Record<string, unknown> }>;

function writeCodeBuddyAgentScript(dir: string): { scriptPath: string; callsPath: string; argvPath: string } {
  const callsPath = join(dir, 'calls.jsonl');
  const argvPath = join(dir, 'argv.json');
  const scriptPath = writeAcpTestAgentScript({
    dir,
    fileName: 'fake-codebuddy-acp.mjs',
    source: `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import readline from 'node:readline';
      writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
      const modes = {
        currentModeId: 'default',
        availableModes: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'].map((id) => ({ id, name: id })),
      };
      const rl = readline.createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      rl.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method: request.method, params: request.params ?? {} }) + '\\n');
        if (request.method === 'initialize') {
          send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } } });
          return;
        }
        if (request.method === 'session/new') {
          send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'started', modes } });
          return;
        }
        if (request.method === 'session/load') {
          send({ jsonrpc: '2.0', id: request.id, result: { modes } });
          return;
        }
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      });
    `,
  });
  return { scriptPath, callsPath, argvPath };
}

function readCalls(callsPath: string): RecordedRequest[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedRequest);
}

function readSetModeIds(callsPath: string): unknown[] {
  return readCalls(callsPath)
    .filter((call) => call.method === 'session/set_mode')
    .map((call) => call.params.modeId);
}

async function withCodeBuddyAgent(
  prefix: string,
  run: (agent: ReturnType<typeof writeCodeBuddyAgentScript>) => Promise<void>,
): Promise<void> {
  await withTempDir(prefix, async (dir) => {
    const agent = writeCodeBuddyAgentScript(dir);
    launchSpec.command = process.execPath;
    launchSpec.args = [agent.scriptPath];
    await run(agent);
  });
}

// The scripted agent runs outside the scratch dir so Windows can remove it while the child exits.
const agentCwd = tmpdir();

describe('createCatalogDefinedAcpBackend (CodeBuddy Code)', () => {
  it('launches with `--acp`, forwards Happier MCP servers, and keeps CodeBuddy settings for Happier default', async () => {
    await withCodeBuddyAgent('happier-codebuddy-default-', async ({ callsPath, argvPath }) => {
      const backend = createCatalogDefinedAcpBackend('codebuddy', {
        cwd: agentCwd,
        permissionMode: 'default',
        mcpServers: { happier: { command: 'happier-mcp', args: ['--stdio'] } },
      });
      try {
        await expect(backend.startSession()).resolves.toEqual({ sessionId: 'started' });
        expect(JSON.parse(readFileSync(argvPath, 'utf8'))).toEqual(['--acp']);
        const sessionNew = readCalls(callsPath).find((call) => call.method === 'session/new');
        expect(sessionNew?.params.mcpServers).toEqual([
          expect.objectContaining({ name: 'happier', command: 'happier-mcp', args: ['--stdio'] }),
        ]);
        expect(readSetModeIds(callsPath)).toEqual([]);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it.each([
    ['read-only', 'dontAsk'],
    ['safe-yolo', 'auto'],
    ['yolo', 'bypassPermissions'],
    ['plan', 'plan'],
  ] as const satisfies ReadonlyArray<readonly [PermissionMode, string]>)(
    'enforces Happier %s through CodeBuddy mode %s on new sessions',
    async (permissionMode, codebuddyMode) => {
      await withCodeBuddyAgent('happier-codebuddy-mode-', async ({ callsPath }) => {
        const backend = createCatalogDefinedAcpBackend('codebuddy', { cwd: agentCwd, permissionMode });
        try {
          await backend.startSession();
          expect(readSetModeIds(callsPath)).toEqual([codebuddyMode]);
        } finally {
          await backend.dispose();
        }
      });
    },
    20_000,
  );

  it('re-enforces the mapped CodeBuddy mode after loading a vendor session', async () => {
    await withCodeBuddyAgent('happier-codebuddy-load-', async ({ callsPath }) => {
      const backend = createCatalogDefinedAcpBackend('codebuddy', { cwd: agentCwd, permissionMode: 'read-only' });
      try {
        await expect(backend.loadSession?.('resumed' as SessionId)).resolves.toEqual({ sessionId: 'resumed' });
        const methods = readCalls(callsPath).map((call) => call.method);
        expect(methods).not.toContain('session/new');
        expect(methods.indexOf('session/set_mode')).toBeGreaterThan(methods.indexOf('session/load'));
        expect(readSetModeIds(callsPath)).toEqual(['dontAsk']);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);
});
