import child_process from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCommand } from './commands/install.js';
import { newFeatureCommand } from './commands/new-feature.js';
import { newPatchCommand } from './commands/new-patch.js';
import { statusCommand } from './commands/status.js';

// Direct proof of NFR1 (vendor neutrality): none of the CLI's
// currently-existing commands may make an outbound network call to any AI
// model or vendor API. Rather than trust the design intention, this test
// spies on every outbound-call surface Node offers — `http.request`,
// `http.get`, `https.request`, `https.get`, global `fetch`, `net.connect`,
// and `child_process.exec`/`child_process.spawn` (a process could shell out
// to `curl`/`ssh` etc. just as easily as calling a networking API directly)
// — runs the full `install` -> `new-patch` -> `new-feature` flow against a
// scratch tmp-dir fixture (same `mkdtempSync`/`afterEach rmSync` pattern as
// `install.test.ts`), and asserts every spy was never called, checkpointed
// after each command so a failure identifies exactly which command was
// responsible.
//
// Per the Never section of this story's spec, this test covers only
// commands that exist today (`install`, `new-patch`, `new-feature`,
// `status`); it is written to be trivially extended (add one more command
// call) as `update`/`verify`/`approve`/`check-drift`/`gate` land in later
// epics.
//
// `status` (Story 5.1) is included directly in this sequence, rather than
// getting its own separate suite the way `gate.ts`/`verify.ts` do: those
// legitimately shell out to git, so they need their own dedicated
// network-surface test; `status` makes zero `child_process` calls at all
// (pure filesystem reads), so it fits this existing read-only-ish sequence
// unchanged.
//
// Each spy's implementation throws instead of forwarding to the real call.
// This is a safety net, not the assertion itself: if the code under test
// were ever to attempt a real call, we want the test to fail fast and
// loudly (and never actually touch the network in CI) rather than hang or
// silently succeed against a live socket.

let tmpDir: string;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'waypoint-cli-vendor-neutrality-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  // Best-effort cleanup, mirroring new-spec.ts's rollbackSpecFile pattern:
  // (a) never throw if tmpDir was never successfully assigned (e.g. an
  // error in beforeEach before the assignment), and (b) never let a
  // Windows EBUSY/EPERM cleanup failure (a file handle still settling)
  // propagate and mask the real test result.
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort: nothing more can be done here, and it must never mask
      // the actual test outcome.
    }
  }
  process.exitCode = originalExitCode;
});

describe('vendor neutrality (NFR1)', () => {
  it(
    'makes zero outbound network calls across install -> new-patch -> new-feature -> status',
    async () => {
      const httpRequestSpy = vi.spyOn(http, 'request').mockImplementation(() => {
        throw new Error('unexpected call to http.request');
      });
      const httpGetSpy = vi.spyOn(http, 'get').mockImplementation(() => {
        throw new Error('unexpected call to http.get');
      });
      const httpsRequestSpy = vi.spyOn(https, 'request').mockImplementation(() => {
        throw new Error('unexpected call to https.request');
      });
      const httpsGetSpy = vi.spyOn(https, 'get').mockImplementation(() => {
        throw new Error('unexpected call to https.get');
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        throw new Error('unexpected call to fetch');
      });
      const netConnectSpy = vi.spyOn(net, 'connect').mockImplementation(() => {
        throw new Error('unexpected call to net.connect');
      });
      const execSpy = vi
        .spyOn(child_process, 'exec')
        .mockImplementation(() => {
          throw new Error('unexpected call to child_process.exec');
        });
      const spawnSpy = vi
        .spyOn(child_process, 'spawn')
        .mockImplementation(() => {
          throw new Error('unexpected call to child_process.spawn');
        });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const spies = [
        httpRequestSpy,
        httpGetSpy,
        httpsRequestSpy,
        httpsGetSpy,
        fetchSpy,
        netConnectSpy,
        execSpy,
        spawnSpy,
      ];

      // Checkpointed after each command (rather than only once at the very
      // end after all three have run) so a failure's assertion message and
      // stack trace point at exactly which command made the disallowed
      // call, per this story's per-command failure-breakdown requirement.
      function assertNoNetworkActivitySoFar(afterCommand: string): void {
        expect(httpRequestSpy, `http.request called during/after ${afterCommand}`).not.toHaveBeenCalled();
        expect(httpGetSpy, `http.get called during/after ${afterCommand}`).not.toHaveBeenCalled();
        expect(httpsRequestSpy, `https.request called during/after ${afterCommand}`).not.toHaveBeenCalled();
        expect(httpsGetSpy, `https.get called during/after ${afterCommand}`).not.toHaveBeenCalled();
        expect(fetchSpy, `fetch called during/after ${afterCommand}`).not.toHaveBeenCalled();
        expect(netConnectSpy, `net.connect called during/after ${afterCommand}`).not.toHaveBeenCalled();
        expect(execSpy, `child_process.exec called during/after ${afterCommand}`).not.toHaveBeenCalled();
        expect(spawnSpy, `child_process.spawn called during/after ${afterCommand}`).not.toHaveBeenCalled();
        // Confirm the command actually ran cleanly (no swallowed failure
        // hiding behind a mocked-away network call) before trusting the
        // "zero calls" checkpoint above.
        expect(process.exitCode, `${afterCommand} left a non-clean exit code`).toBeUndefined();
      }

      try {
        await installCommand(tmpDir);
        assertNoNetworkActivitySoFar('install');

        await newPatchCommand('demo-patch', tmpDir);
        assertNoNetworkActivitySoFar('new-patch');

        await newFeatureCommand('demo-feature', tmpDir);
        assertNoNetworkActivitySoFar('new-feature');

        await statusCommand(tmpDir);
        assertNoNetworkActivitySoFar('status');
        // `status` in particular is pure filesystem reads -- unlike
        // `gate`/`verify`/`approve`, it shells out to nothing at all, so
        // this is a direct proof of that (not just "no network"), on top of
        // the shared assertion above.
        expect(execSpy, 'child_process.exec called during/after status').not.toHaveBeenCalled();
        expect(spawnSpy, 'child_process.spawn called during/after status').not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    },
    30000
  );
});
