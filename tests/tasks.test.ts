import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Tasks } from '../electron/services/tasks'
import { MAX_OUTPUT_LENGTH } from '../electron/services/bounded-log'
import type { CommandConfig, Project, RunRecord } from '../shared/types'
import { removeTestDirectory } from './temp-cleanup'

async function until(predicate: () => boolean | Promise<boolean>, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for task state')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('Tasks real process execution', () => {
  let temporary: string
  let project: Project
  let tasks: Tasks
  let updates: RunRecord[]

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devdock-tasks-'))
    project = { id: 'project', name: 'Test project', path: temporary, commands: [], createdAt: new Date().toISOString() }
    updates = []
    tasks = new Tasks(run => updates.push(run))
  })

  afterEach(async () => {
    await tasks.stopAll()
    await removeTestDirectory(temporary)
  })

  async function script(source: string, id = 'script', cwd?: string): Promise<CommandConfig> {
    const filename = path.join(temporary, `${id}.cjs`)
    await fs.writeFile(filename, source)
    return { id, name: id, kind: 'test', command: `"${process.execPath}" "${filename}"`, cwd }
  }

  function latest(id: string): RunRecord | undefined {
    for (let index = updates.length - 1; index >= 0; index--) {
      if (updates[index].id === id) return updates[index]
    }
    return undefined
  }

  it('runs actual commands and delivers initial and final states even when they finish quickly', async () => {
    const started = tasks.start(project, await script("console.log('passed'); console.error('diagnostic')"), 'source-version')
    expect(started.status).toBe('running')
    expect(updates[0].status).toBe('running')
    await until(() => latest(started.id)?.status === 'success')
    const result = latest(started.id)!
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('passed')
    expect(result.output).toContain('diagnostic')
    expect(result.fingerprint).toBe('source-version')
    expect(result.endedAt).toBeTruthy()
    expect(tasks.hasRunning()).toBe(false)
  })

  it('reports nonzero exit codes and nonexistent commands as failures', async () => {
    const failed = tasks.start(project, await script("console.error('bad test'); process.exit(7)"))
    await until(() => latest(failed.id)?.status === 'failed')
    expect(latest(failed.id)?.exitCode).toBe(7)
    const missing = tasks.start(project, { id: 'missing', name: 'Missing', kind: 'custom', command: 'devdock_nonexistent_command_721813' })
    await until(() => latest(missing.id)?.status === 'failed')
    expect(latest(missing.id)?.output.length).toBeGreaterThan(0)
  })

  it('streams output before completion and correctly decodes split UTF-8 characters', async () => {
    const command = await script(`
      const bytes = Buffer.from('测试完成');
      process.stdout.write(bytes.subarray(0, 2));
      setTimeout(() => process.stdout.write(bytes.subarray(2)), 40);
      setTimeout(() => console.log(' ending'), 700);
    `)
    const started = tasks.start(project, command)
    await until(() => updates.some(run => run.id === started.id && run.status === 'running' && run.output.includes('测试完成')))
    expect(latest(started.id)?.status).toBe('running')
    await until(() => latest(started.id)?.status === 'success')
    expect(latest(started.id)?.output).not.toContain('\uFFFD')
  })

  it('supports relative working directories and rejects missing directories before starting', async () => {
    await fs.mkdir(path.join(temporary, 'nested folder'))
    const command = await script('console.log(process.cwd())', 'cwd', 'nested folder')
    const started = tasks.start(project, command)
    await until(() => latest(started.id)?.status === 'success')
    expect(latest(started.id)?.output).toContain(path.join(temporary, 'nested folder'))
    expect(() => tasks.start(project, { ...command, cwd: 'does-not-exist' })).toThrow('工作目录不存在')
    expect(tasks.hasRunning()).toBe(false)
  })

  it('prevents duplicate execution and stops the full child process tree', async () => {
    const worker = path.join(temporary, 'worker.cjs')
    const pidFile = path.join(temporary, 'worker.pid')
    const heartbeat = path.join(temporary, 'heartbeat')
    await fs.writeFile(worker, `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 30);
    `)
    const command = await script(`
      const { spawn } = require('child_process');
      spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: 'inherit' });
      setInterval(() => {}, 1000);
    `)
    const started = tasks.start(project, command)
    expect(() => tasks.start(project, command)).toThrow('已经在运行')
    await until(async () => { try { await fs.access(heartbeat); return true } catch { return false } })
    const workerPid = Number(await fs.readFile(pidFile, 'utf8'))
    await tasks.stop(started.id)
    expect(latest(started.id)?.status).toBe('stopped')
    expect(tasks.getRunning()).toEqual([])
    const afterStop = await fs.readFile(heartbeat, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await fs.readFile(heartbeat, 'utf8')).toBe(afterStop)
    if (process.platform === 'win32') expect(() => process.kill(workerPid, 0)).toThrow()
  })

  it('bounds retained output and returns isolated snapshots', async () => {
    const started = tasks.start(project, await script("console.log('x'.repeat(300000)); setTimeout(() => {}, 250)"))
    const running = tasks.getRunning()
    running[0].label = 'corrupted'
    expect(tasks.getRunning()[0].label).toBe('script')
    await until(() => latest(started.id)?.status === 'success')
    expect(latest(started.id)?.output.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH)
    expect(latest(started.id)?.output).toContain('输出已截断')
  })
})
