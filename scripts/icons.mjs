import sharp from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
const source = await readFile(new URL('../assets/icon.svg', import.meta.url))
const sizes = [16, 32, 48, 64, 128, 256]
const pngs = await Promise.all(sizes.map(size => sharp(source).resize(size, size).png().toBuffer()))
await writeFile(new URL('../assets/icon.png', import.meta.url), pngs.at(-1))
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, i) => {
  const pos = 6 + i * 16
  header[pos] = size === 256 ? 0 : size; header[pos + 1] = header[pos]
  header.writeUInt16LE(1, pos + 4); header.writeUInt16LE(32, pos + 6)
  header.writeUInt32LE(pngs[i].length, pos + 8); header.writeUInt32LE(offset, pos + 12)
  offset += pngs[i].length
})
await writeFile(new URL('../assets/icon.ico', import.meta.url), Buffer.concat([header, ...pngs]))
