#!/usr/bin/env node
import { createProgram } from './program.js';

const program = createProgram();

await program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
