import { build as bundle } from 'esbuild'
import { build as viteBuild } from 'vite'
import './icons.mjs'
await bundle({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true })
await viteBuild()
console.log('DevDock built successfully.')
