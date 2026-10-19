import { build } from 'esbuild'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import electron from 'electron'
import './icons.mjs'
await build({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true })
const server = await createServer()
await server.listen()
const env = { ...process.env, ELECTRON_RENDERER_URL: server.resolvedUrls.local[0] }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: true })
let closing = false
async function close() { if (closing) return; closing = true; await server.close(); child.kill() }
child.on('exit', async code => { await close(); process.exit(code ?? 0) })
process.on('SIGINT', close)
process.on('SIGTERM', close)
