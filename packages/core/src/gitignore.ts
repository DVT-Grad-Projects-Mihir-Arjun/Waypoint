import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Idempotently ensures `entry` is present as its own line in the `.gitignore`
 * file at `gitignorePath`. Creates the file (and its parent directory) if it
 * doesn't exist; appends the line only if it isn't already present.
 *
 * Safe to call repeatedly — reinstalling never duplicates the entry.
 */
export function ensureGitignoreEntry(gitignorePath: string, entry: string): void {
  mkdirSync(dirname(gitignorePath), { recursive: true });

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`, 'utf8');
    return;
  }

  const content = readFileSync(gitignorePath, 'utf8');
  const alreadyPresent = content.split(/\r?\n/).some((line) => line.trim() === entry);
  if (alreadyPresent) {
    return;
  }

  const needsLeadingNewline = content.length > 0 && !content.endsWith('\n');
  writeFileSync(gitignorePath, `${content}${needsLeadingNewline ? '\n' : ''}${entry}\n`, 'utf8');
}
