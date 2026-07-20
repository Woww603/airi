import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { it } from 'vitest'
import { parse, stringify } from 'yaml'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureFiles = [
  '.github/workflows/ci.yml',
  'AGENTS.md',
  'apps/discord-dashboard/package.json',
  'package.json',
  'scripts/verify-ci-command-contract.mjs',
  'services/discord-bot/package.json',
]

function createFixture() {
  // The fixture stays beneath the checkout so its copied ESM contract resolves
  // the repository's installed `yaml` dependency without a second install.
  const fixtureRoot = fs.mkdtempSync(path.join(repositoryRoot, '.ci-command-contract-fixture-'))
  for (const relativePath of fixtureFiles) {
    const targetPath = path.join(fixtureRoot, relativePath)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.copyFileSync(path.join(repositoryRoot, relativePath), targetPath)
  }
  return fixtureRoot
}

function withFixture(assertContract) {
  const fixtureRoot = createFixture()
  try {
    assertContract(fixtureRoot)
  }
  finally {
    // Only the unique directory created above is removed; repository files are
    // never cleanup targets even when an assertion fails.
    fs.rmSync(fixtureRoot, { force: true, recursive: true })
  }
}

function updateWorkflow(fixtureRoot, update) {
  const workflowPath = path.join(fixtureRoot, '.github/workflows/ci.yml')
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'))
  update(workflow)
  fs.writeFileSync(workflowPath, stringify(workflow))
}

function runFixtureContract(fixtureRoot) {
  return spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/verify-ci-command-contract.mjs')], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  })
}

function assertRejected(result, expectedMessage) {
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
}

// ROOT CAUSE:
//
// Truthiness checks treated YAML `if: false` as absent, while GitHub Actions
// treats the field as a real condition and skips the owning job or step.
// Checking own properties makes the contract reject the bypass regardless of
// the YAML value's JavaScript truthiness.
//
// @example A Discord job with `if: false` must fail the real contract CLI.
it('rejects job-level if false for Discord audit D-033', () => {
  withFixture((fixtureRoot) => {
    updateWorkflow(fixtureRoot, (workflow) => {
      workflow.jobs.discord.if = false
    })

    assertRejected(runFixtureContract(fixtureRoot), 'CI Discord job must not be conditionally skipped.')
  })
})

// @example A required owning-package step with `if: false` must be rejected.
it('rejects step-level if false for Discord audit D-033', () => {
  withFixture((fixtureRoot) => {
    updateWorkflow(fixtureRoot, (workflow) => {
      const step = workflow.jobs.discord.steps.find(candidate => candidate.run === 'pnpm -F @proj-airi/discord-bot typecheck')
      assert.ok(step)
      step.if = false
    })

    assertRejected(runFixtureContract(fixtureRoot), 'CI owning-package command must not be conditionally skipped: pnpm -F @proj-airi/discord-bot typecheck')
  })
})

// @example An expression-valued continue-on-error field cannot hide failures.
it('rejects expression continue-on-error for Discord audit D-033', () => {
  withFixture((fixtureRoot) => {
    updateWorkflow(fixtureRoot, (workflow) => {
      const step = workflow.jobs.discord.steps.find(candidate => candidate.run === 'pnpm -F @proj-airi/discord-bot test:run')
      assert.ok(step)
      step['continue-on-error'] = `${String.fromCharCode(36)}{{ true }}`
    })

    assertRejected(runFixtureContract(fixtureRoot), 'CI owning-package command must not ignore failures: pnpm -F @proj-airi/discord-bot test:run')
  })
})

// @example Bracket-form GitHub secret expressions must fail without echoing names.
it('rejects bracket-form secrets for Discord audit D-033', () => {
  withFixture((fixtureRoot) => {
    updateWorkflow(fixtureRoot, (workflow) => {
      workflow.jobs.discord.env = {
        SYNTHETIC_CREDENTIAL: `${String.fromCharCode(36)}{{ secrets ['SYNTHETIC_SECRET_SENTINEL'] }}`,
      }
    })

    const result = runFixtureContract(fixtureRoot)
    assertRejected(result, 'CI Discord job must run without GitHub secrets.')
    assert.doesNotMatch(result.stderr, /SYNTHETIC_SECRET_SENTINEL/)
  })
})

// @example A renamed owner cannot leave a successful no-match pnpm filter behind.
it('binds each CI filter to its owning package name for Discord audit D-033', () => {
  withFixture((fixtureRoot) => {
    const manifestPath = path.join(fixtureRoot, 'services/discord-bot/package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.name = '@synthetic/renamed-discord-owner'
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    assertRejected(runFixtureContract(fixtureRoot), 'services/discord-bot/package.json package name does not match CI filter "@proj-airi/discord-bot".')
  })
})
