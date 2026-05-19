#!/usr/bin/env node
"use strict";

/**
 * Remove everything under dist/ except index.js (the committed GitHub Actions bundle).
 * Runs via plain Node so npm scripts work on Windows, macOS, and Linux.
 */

const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");

function main() {
  if (!fs.existsSync(distDir)) {
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(distDir, { withFileTypes: true });
  } catch (err) {
    console.error("clean-dist: failed to read dist/: ", err.message);
    process.exit(1);
  }

  for (const ent of entries) {
    if (ent.name === "index.js") {
      continue;
    }
    const fullPath = path.join(distDir, ent.name);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch (err) {
      console.error(`clean-dist: failed to remove ${fullPath}: `, err.message);
      process.exit(1);
    }
  }
}

main();
