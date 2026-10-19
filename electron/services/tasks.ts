import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { CommandConfig, Project, RunRecord } from '../../shared/types'
import { boundedOutput } from './bounded-log'

const UPDATE_INTERVAL_MS = 100

interface RunningTask {
  record: RunRecord
  child?: ChildProcess
  stdout: StringDecoder
  stderr: StringDecoder
  stopping: boolean
  finished: boolean
  spawnError: boolean
  updateTimer?: NodeJS.Timeout
  closed: Promise<void>
  resolveClosed: () => void
}

export class Tasks {
  private readonly running = new Map<string, RunningTask>()

  constructor(private readonly onUpdate: (run: RunRecord) => void) {}

  start(project: Project, command: CommandConfig, fingerprint?: string): RunRecord {
    if ([...this.running.values()].some(task => task.record.projectId === project.id && task.record.commandId === command.id)) {
      throw new Error('此按钮已经在运行，请先停止或等待完成')
    }
    if (typeof command.command !== 'string' || !command.command.trim() || command.command.includes('\0')) {
      throw new Error('请输入有效命令')
    }
    const cwd = path.resolve(project.path, command.cwd || '.')
    try {
      if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
    } catch { throw new Error(`工作目录不存在或不是文件夹：${cwd}`) }

    let resolveClosed!: () => void
    const task: RunningTask = {
      record: {
        id: randomUUID(), projectId: project.id, projectName: project.name, commandId: command.id,
        label: command.name, kind: command.kind, command: command.command, cwd,
        status: 'running', startedAt: new Date().toISOString(), output: '',
        ...(fingerprint !== undefined ? { fingerprint } : {}),
      },
      stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8'),
      stopping: false, finished: false, spawnError: false,
      closed: new Promise(resolve => { resolveClosed = resolve }),
      resolveClosed: () => resolveClosed(),
    }
    this.running.set(task.record.id, task)
    this.emit(task)

    try {
      const child = spawn(command.command, {
        cwd, shell: true, windowsHide: true,
        // A separate process group lets POSIX cancellation include grandchildren.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' },
      })
      task.child = child
      child.stdout?.on('data', (chunk: Buffer) => this.append(task, task.stdout.write(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => this.append(task, task.stderr.write(chunk)))
      child.once('error', error => {
        task.spawnError = true
        this.append(task, `\n[无法启动命令：${error.message}]\n`)
      })
      child.once('close', (code, signal) => this.finish(task, code, signal))
    } catch (error) {
      task.spawnError = true
      this.append(task, `\n[无法启动命令：${(error as Error).message}]\n`)
      this.finish(task, null, null)
    }
    return structuredClone(task.record)
  }

  hasRunning(): boolean { return this.running.size > 0 }
  getRunning(): RunRecord[] { return [...this.running.values()].map(task => structuredClone(task.record)) }

  async stop(id: string): Promise<void> {
    const task = this.running.get(id)
    if (!task || task.finished) return
    if (task.stopping) return task.closed
    task.stopping = true
    this.append(task, '\n[正在停止任务…]\n')
    this.emit(task)
    const pid = task.child?.pid
    if (!pid) { await task.closed; return }

    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore', shell: false,
        })
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          killer.kill()
          reject(new Error('停止任务超时，请在任务管理器中检查该任务'))
        }, 10_000)
        killer.once('error', error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`无法停止进程树：${error.message}`))
        })
        killer.once('close', code => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (code !== 0 && !task.finished) {
            // A process can finish naturally between requesting cancellation and taskkill.
            try { process.kill(pid, 0) }
            catch { resolve(); return }
            reject(new Error('无法停止进程树，请检查进程权限'))
          } else resolve()
        })
      }).catch(error => {
        task.stopping = false
        this.append(task, `\n[${(error as Error).message}]\n`)
        this.emit(task)
        throw error
      })
    } else {
      try { process.kill(-pid, 'SIGTERM') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          task.stopping = false
          throw error
        }
      }
      // A child that ignores SIGTERM is still part of the same isolated process group.
      const timer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL') } catch { /* Already exited. */ }
      }, 1200)
      timer.unref()
      await task.closed
      clearTimeout(timer)
      return
    }
    await task.closed
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.running.keys()].map(id => this.stop(id)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '部分任务未能停止')
  }

  private append(task: RunningTask, text: string): void {
    if (task.finished || !text) return
    task.record.output = boundedOutput(task.record.output + text)
    if (!task.updateTimer) {
      task.updateTimer = setTimeout(() => {
        task.updateTimer = undefined
        if (!task.finished) this.emit(task)
      }, UPDATE_INTERVAL_MS)
      task.updateTimer.unref()
    }
  }

  private finish(task: RunningTask, code: number | null, signal: NodeJS.Signals | null): void {
    if (task.finished) return
    this.append(task, task.stdout.end() + task.stderr.end())
    if (signal && !task.stopping) this.append(task, `\n[进程因 ${signal} 结束]\n`)
    task.finished = true
    if (task.updateTimer) clearTimeout(task.updateTimer)
    task.record.status = task.stopping ? 'stopped' : !task.spawnError && code === 0 ? 'success' : 'failed'
    task.record.exitCode = code
    task.record.endedAt = new Date().toISOString()
    this.running.delete(task.record.id)
    this.emit(task)
    task.resolveClosed()
  }

  private emit(task: RunningTask): void {
    // Consumer errors must not leave a successfully closed OS process marked as running.
    try { this.onUpdate(structuredClone(task.record)) }
    catch { console.error('[DevDock] Task update callback failed') }
  }
}
