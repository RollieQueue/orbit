'use strict'
// Crops a region of a screenshot and enlarges it (nearest neighbour: every pixel stays a visible square).
//   node scripts/run-electron.cjs scratchpad/s4-timeline/zoom.cjs <shot name or png path> <x> <y> <width> <height> [scale=4] [out name]
// Writes scratchpad/s4-timeline/shots/zoom/<name>-<x>_<y>_<w>x<h>.png and prints its path.
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.on('window-all-closed', () => {})
// node scripts/run-electron.cjs scratchpad/s4-timeline/zoom.cjs --probe <shot name or png path> x,y [x,y ...]  prints the colour of single pixels.
function probe(args) {
  const [source, ...points] = args
  const file = fs.existsSync(source) ? source : path.join(__dirname, 'shots', `${source}.png`)
  const image = nativeImage.createFromPath(file)
  const { width } = image.getSize()
  const bitmap = image.toBitmap()
  for (const point of points) {
    const [x, y] = point.split(',').map(Number)
    const at = (y * width + x) * 4
    console.log(`${x},${y}: #${[bitmap[at + 2], bitmap[at + 1], bitmap[at]].map(value => value.toString(16).padStart(2, '0')).join('')}`)
  }
  app.exit(0)
}
app.whenReady().then(() => {
  if (process.argv.includes('--probe')) return probe(process.argv.slice(2).filter(arg => arg !== '--probe'))
  const [source, ...numbers] = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
  const [x, y, width, height, scale = 4] = numbers.map(Number)
  const file = fs.existsSync(source) ? source : path.join(__dirname, 'shots', `${source}.png`)
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) { console.log(`cannot read ${file}`); app.exit(1); return }
  const size = image.getSize()
  const box = { x: Math.max(0, x), y: Math.max(0, y), width: Math.min(width, size.width - x), height: Math.min(height, size.height - y) }
  const crop = image.crop(box)
  const bitmap = crop.toBitmap()
  const out = Buffer.alloc(box.width * scale * box.height * scale * 4)
  for (let row = 0; row < box.height * scale; row++) {
    for (let column = 0; column < box.width * scale; column++) {
      bitmap.copy(out, (row * box.width * scale + column) * 4, ((Math.floor(row / scale)) * box.width + Math.floor(column / scale)) * 4, ((Math.floor(row / scale)) * box.width + Math.floor(column / scale)) * 4 + 4)
    }
  }
  const zoomed = nativeImage.createFromBitmap(out, { width: box.width * scale, height: box.height * scale })
  const folder = path.join(__dirname, 'shots', 'zoom')
  fs.mkdirSync(folder, { recursive: true })
  const name = `${path.basename(source, '.png')}-${box.x}_${box.y}_${box.width}x${box.height}.png`
  fs.writeFileSync(path.join(folder, name), zoomed.toPNG())
  console.log(path.join(folder, name))
  app.exit(0)
})
