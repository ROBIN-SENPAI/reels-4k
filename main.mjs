#!/usr/bin/env node
// Entry point. With a video path -> command line mode; without arguments -> web app (opens the browser).
import { runCli } from './cli.mjs';
import { runServer } from './server.mjs';

const args = process.argv.slice(2);
if (args.length) runCli(args);
else runServer({ open: true });
