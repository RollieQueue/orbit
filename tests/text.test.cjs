const test = require('node:test')
const assert = require('node:assert/strict')
const { clip, oneLine, ellipsis } = require('../electron/text.mts')

test('clip makes one trimmed line and cuts with an ellipsis in the last kept position', () => {
  assert.equal(clip('  a  b\n\tc ', 10), 'a b c')
  assert.equal(clip('abcdefghij', 10), 'abcdefghij', 'exactly limit characters are kept whole')
  assert.equal(clip('abcdefghijk', 10), 'abcdefghi…')
  assert.equal(clip('abcdefghijk', 10).length, 10)
  assert.equal(clip(null, 5), '')
  assert.equal(clip(undefined, 5), '')
  assert.equal(clip(12345678, 5), '1234…', 'any value reads as text')
  assert.equal(clip('', 0), '')
})

test('oneLine is clip under the name the skill and memory modules use', () => {
  assert.equal(oneLine, clip)
})

test('ellipsis only cuts: line breaks and spacing stay', () => {
  assert.equal(ellipsis('a\nb', 10), 'a\nb')
  assert.equal(ellipsis('a\nbcdef', 4), 'a\nb…')
  assert.equal(ellipsis('  x  ', 5), '  x  ')
  assert.equal(ellipsis(null, 3), '')
})
