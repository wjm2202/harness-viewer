#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
}).then((code) => {
  process.exitCode = code;
});
