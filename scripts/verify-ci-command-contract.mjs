import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const requiredDiscordCommands = [
  {
    manifestPath: 'services/discord-bot/package.json',
    packageName: '@proj-airi/discord-bot',
    scriptName: 'typecheck',
  },
  {
    manifestPath: 'services/discord-bot/package.json',
    packageName: '@proj-airi/discord-bot',
    scriptName: 'test:run',
  },
  {
    manifestPath: 'apps/discord-dashboard/package.json',
    packageName: '@proj-airi/discord-dashboard',
    scriptName: 'typecheck',
  },
  {
    manifestPath: 'apps/discord-dashboard/package.json',
    packageName: '@proj-airi/discord-dashboard',
    scriptName: 'build',
  },
]

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readRepositoryFile(relativePath))
}

/**
 * Verifies the commands owned by AIRI's ordinary CI and contributor guide.
 *
 * Use when:
 * - CI must keep Discord service validation explicit instead of relying on root globs.
 * - Fixed root commands in AGENTS.md must continue to map to real package scripts.
 *
 * Expects:
 * - The command runs from a complete repository checkout after dependency installation.
 * - The Discord CI job keeps each owning-package command as a distinct run step.
 *
 * Returns:
 * - Exit code 0 when both contracts are satisfied; otherwise a fixed actionable error per gap.
 *
 * Call stack:
 *
 * node scripts/verify-ci-command-contract.mjs
 *   -> verifyCommandContract
 *     -> .github/workflows/ci.yml + AGENTS.md + package.json manifests
 */
function verifyCommandContract() {
  const failures = []
  const workflow = parse(readRepositoryFile('.github/workflows/ci.yml'))
  const discordJob = workflow?.jobs?.discord
  const discordRunSteps = Array.isArray(discordJob?.steps)
    ? discordJob.steps
        .filter(step => typeof step?.run === 'string')
    : []
  const discordRunCommands = discordRunSteps.map(step => step.run.trim())

  if (!discordJob)
    failures.push('CI workflow is missing the dedicated "discord" owning-package job.')
  if (discordJob && Object.hasOwn(discordJob, 'if'))
    failures.push('CI Discord job must not be conditionally skipped.')
  if (discordJob && Object.hasOwn(discordJob, 'continue-on-error'))
    failures.push('CI Discord job must not ignore validation failures.')

  for (const requirement of requiredDiscordCommands) {
    const manifest = readJson(requirement.manifestPath)
    const command = `pnpm -F ${requirement.packageName} ${requirement.scriptName}`
    if (manifest.name !== requirement.packageName) {
      failures.push(`${requirement.manifestPath} package name does not match CI filter "${requirement.packageName}".`)
    }
    if (typeof manifest.scripts?.[requirement.scriptName] !== 'string') {
      failures.push(`${requirement.manifestPath} is missing script "${requirement.scriptName}" required by CI.`)
    }
    if (!discordRunCommands.includes(command)) {
      failures.push(`CI Discord job is missing owning-package command: ${command}`)
      continue
    }

    const commandStep = discordRunSteps.find(step => step.run.trim() === command)
    if (commandStep && Object.hasOwn(commandStep, 'if'))
      failures.push(`CI owning-package command must not be conditionally skipped: ${command}`)
    if (commandStep && Object.hasOwn(commandStep, 'continue-on-error'))
      failures.push(`CI owning-package command must not ignore failures: ${command}`)
  }

  if (/\bsecrets\s*(?:\.|\[)/i.test(JSON.stringify(discordJob ?? {})))
    failures.push('CI Discord job must run without GitHub secrets.')

  const rootManifest = readJson('package.json')
  const contributorGuideLine = readRepositoryFile('AGENTS.md')
    .split(/\r?\n/)
    .find(line => line.startsWith('- Always run '))
  const documentedCommands = contributorGuideLine
    ? [...contributorGuideLine.matchAll(/`([^`]+)`/g)].map(match => match[1])
    : []

  if (!contributorGuideLine)
    failures.push('AGENTS.md is missing its fixed root validation command line.')

  for (const command of ['pnpm typecheck', 'pnpm lint']) {
    if (!documentedCommands.includes(command))
      failures.push(`AGENTS.md root command contract is missing: ${command}`)
  }

  for (const command of documentedCommands) {
    const match = /^pnpm ([\w:-]+)$/.exec(command)
    if (match && typeof rootManifest.scripts?.[match[1]] !== 'string')
      failures.push(`AGENTS.md documents missing root package script "${match[1]}" via "${command}".`)
  }

  if (failures.length > 0) {
    for (const failure of failures)
      console.error(`[ci-command-contract] ${failure}`)
    process.exitCode = 1
    return
  }

  console.info('[ci-command-contract] Discord CI and documented root commands are valid.')
}

verifyCommandContract()
