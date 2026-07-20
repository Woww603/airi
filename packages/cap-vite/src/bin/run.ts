#!/usr/bin/env node

import process from 'node:process'

import { runCapVite } from '..'
import { getCapViteCliHelpText, parseCapViteCliArgs } from '../cli'

async function main() {
  const parsed = parseCapViteCliArgs(process.argv.slice(2))
  if (!parsed) {
    process.stdout.write(`${getCapViteCliHelpText()}\n`)
    return
  }

  const result = await runCapVite(parsed.viteArgs, parsed.capArgs)
  if (typeof result.exitCode === 'number') {
    process.exitCode = result.exitCode
  }
}

void main().catch((error) => {
  let message = String(error)
  if (error instanceof Error)
    message = error.message
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
