import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Direct, build-independent check of shebang handling (NFR5): a Windows
// checkout without `.gitattributes` forcing LF can silently rewrite
// `index.ts`'s `#!/usr/bin/env node` first line to CRLF, which breaks the
// shebang once the file is executed as a script on macOS/Linux. This reads
// the raw source directly (not `dist/`) so it doesn't depend on a fresh
// build, and it asserts LF specifically, not just "starts with the right
// text," so a CRLF corruption is caught even though `startsWith` on the
// visible text would still pass.
describe('index.ts shebang', () => {
  it('starts with the exact, LF-terminated shebang line', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    const firstLine = source.split('\n')[0];
    expect(firstLine).toBe('#!/usr/bin/env node');

    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(source.startsWith('#!/usr/bin/env node\r\n')).toBe(false);
  });
});
