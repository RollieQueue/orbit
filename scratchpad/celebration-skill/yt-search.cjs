// Lists the videos of a saved YouTube search page: node yt-search.cjs <file.html>
const fs = require('node:fs')
const html = fs.readFileSync(process.argv[2], 'utf8')
const at = html.indexOf('ytInitialData')
const start = html.indexOf('{', at)
let depth = 0, end = start, inString = false, escaped = false
for (; end < html.length; end++) {
  const c = html[end]
  if (inString) {
    if (escaped) escaped = false
    else if (c === '\\') escaped = true
    else if (c === '"') inString = false
    continue
  }
  if (c === '"') inString = true
  else if (c === '{') depth++
  else if (c === '}') { depth--; if (depth === 0) break }
}
const data = JSON.parse(html.slice(start, end + 1))
const rows = []
const text = (value) => (value && value.runs ? value.runs.map(run => run.text).join('') : value && value.simpleText) || ''
;(function walk(node) {
  if (!node || typeof node !== 'object') return
  if (node.videoRenderer) {
    const video = node.videoRenderer
    rows.push([video.videoId, text(video.title), text(video.ownerText), text(video.lengthText), text(video.viewCountText)].join(' | '))
  }
  for (const key in node) walk(node[key])
})(data)
console.log(rows.slice(0, 25).join('\n'))
