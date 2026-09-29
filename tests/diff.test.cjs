'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unifiedDiff, fragmentDiff, lineOf, MAX_EDIT_DISTANCE } = require('../electron/diff.cjs');

const P = { path: 'f.txt' };
const text = (...lines) => lines.map((line) => `${line}\n`).join('');
const patch = (...lines) => lines.join('\n');
const numbered = (count, prefix = 'n') => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
const headers = (diff) => diff.split('\n').filter((line) => line.startsWith('@@'));

function splitText(source) {
  if (!source) return { lines: [], noEol: false };
  const lines = source.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
    return { lines, noEol: false };
  }
  return { lines, noEol: true };
}

// Minimal patch applier: checks every context and removed line against the source.
function applyPatch(before, diff) {
  if (!diff) return before;
  const src = splitText(before);
  const out = [];
  let pos = 0;
  let newNoEol = false;
  let lastSide = '';
  let hunkReachedEnd = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') && pos === 0 && !out.length && !lastSide) continue;
    if (line.startsWith('+++') && pos === 0 && !out.length && !lastSide) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(line);
      assert.ok(m, `bad hunk header ${line}`);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const from = count === 0 ? Number(m[1]) : Number(m[1]) - 1;
      assert.ok(from >= pos, 'hunks overlap or are out of order');
      while (pos < from) out.push(src.lines[pos++]);
      lastSide = '@';
      continue;
    }
    const body = line.slice(1);
    if (line[0] === ' ' || line[0] === '-') {
      assert.equal(src.lines[pos], body, `line ${pos + 1} does not match the patch`);
      if (line[0] === ' ') out.push(body);
      pos++;
    } else if (line[0] === '+') {
      out.push(body);
    } else if (line[0] === '\\') {
      if (lastSide !== '-') newNoEol = true;
      continue;
    } else {
      assert.fail(`unexpected diff line ${JSON.stringify(line)}`);
    }
    lastSide = line[0];
    hunkReachedEnd = pos === src.lines.length;
  }
  while (pos < src.lines.length) out.push(src.lines[pos++]);
  const noEol = hunkReachedEnd ? newNoEol : src.noEol;
  return out.length ? out.join('\n') + (noEol ? '' : '\n') : '';
}

// Every hunk header must state exactly the line counts of its body, and the new side must start where the old one
// starts once the earlier hunks have shifted it (what `git apply` verifies).
function assertHeaders(diff, label = '') {
  const lines = diff ? diff.split('\n') : [];
  let shift = 0;
  for (let index = 0; index < lines.length; index++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[index]);
    if (!m) continue;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    let oldSeen = 0;
    let newSeen = 0;
    for (let at = index + 1; at < lines.length && !/^@@ -\d/.test(lines[at]); at++) {
      const mark = lines[at][0];
      if (mark === ' ') { oldSeen++; newSeen++; } else if (mark === '-') oldSeen++; else if (mark === '+') newSeen++;
    }
    assert.deepEqual([oldSeen, newSeen], [oldCount, newCount], `${label} hunk ${lines[index]}`);
    const oldStart = oldCount === 0 ? Number(m[1]) + 1 : Number(m[1]);
    const newStart = newCount === 0 ? Number(m[3]) + 1 : Number(m[3]);
    assert.equal(newStart - oldStart, shift, `${label} new side of ${lines[index]} starts where the earlier hunks put it`);
    shift += newCount - oldCount;
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('identical texts give an empty diff', () => {
  const same = text('a', 'b', 'c');
  assert.deepEqual(unifiedDiff(same, same, P), { diff: '', added: 0, removed: 0, truncated: false, binary: false });
  assert.equal(unifiedDiff(null, null, P).diff, '');
});

test('insert, delete and replace at the start, middle and end', () => {
  assert.equal(
    unifiedDiff(text('a', 'b', 'c'), text('x', 'a', 'b', 'c'), P).diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,4 @@', '+x', ' a', ' b', ' c')
  );
  assert.equal(
    unifiedDiff(text('x', 'a', 'b', 'c'), text('a', 'b', 'c'), P).diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,4 +1,3 @@', '-x', ' a', ' b', ' c')
  );
  const seven = text('1', '2', '3', '4', '5', '6', '7');
  const middle = unifiedDiff(seven, text('1', '2', '3', 'X', '5', '6', '7'), P);
  assert.equal(
    middle.diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,7 +1,7 @@', ' 1', ' 2', ' 3', '-4', '+X', ' 5', ' 6', ' 7')
  );
  assert.equal(middle.added, 1);
  assert.equal(middle.removed, 1);
  assert.equal(
    unifiedDiff(text('a', 'b', 'c'), text('a', 'b', 'c', 'd'), P).diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,4 @@', ' a', ' b', ' c', '+d')
  );
  assert.equal(
    unifiedDiff(text('a', 'b', 'c', 'd'), text('a', 'b', 'c'), P).diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,4 +1,3 @@', ' a', ' b', ' c', '-d')
  );
  const replaced = unifiedDiff(text('a', 'b'), text('c', 'd', 'e'), P);
  assert.equal(replaced.added, 3);
  assert.equal(replaced.removed, 2);
});

test('hunks with overlapping contexts merge, distant ones stay apart', () => {
  const base = numbered(20);
  const edit = (...indexes) => base.map((line, i) => (indexes.includes(i + 1) ? `${line}!` : line));
  const merged = unifiedDiff(text(...base), text(...edit(2, 9)), P);
  assert.deepEqual(headers(merged.diff), ['@@ -1,12 +1,12 @@']);
  const apart = unifiedDiff(text(...base), text(...edit(2, 10)), P);
  assert.deepEqual(headers(apart.diff), ['@@ -1,5 +1,5 @@', '@@ -7,7 +7,7 @@']);
  assert.equal(apart.added, 2);
  assert.equal(apart.removed, 2);
  const none = unifiedDiff(text(...base), text(...edit(2, 4)), { ...P, context: 0 });
  assert.deepEqual(headers(none.diff), ['@@ -2 +2 @@', '@@ -4 +4 @@']);
  const three = unifiedDiff(text(...base), text(...edit(1, 10, 20)), P);
  assert.deepEqual(headers(three.diff), ['@@ -1,4 +1,4 @@', '@@ -7,7 +7,7 @@', '@@ -17,4 +17,4 @@']);
});

test('created and deleted files use /dev/null', () => {
  assert.equal(
    unifiedDiff(null, text('a', 'b'), P).diff,
    patch('--- /dev/null', '+++ b/f.txt', '@@ -0,0 +1,2 @@', '+a', '+b')
  );
  const removed = unifiedDiff(text('a', 'b'), null, P);
  assert.equal(removed.diff, patch('--- a/f.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'));
  assert.equal(removed.removed, 2);
  assert.equal(removed.added, 0);
});

test('empty files have no hunks', () => {
  assert.equal(unifiedDiff('', '', P).diff, '');
  assert.equal(unifiedDiff(null, '', P).diff, '');
  assert.equal(unifiedDiff('', null, P).diff, '');
  const filled = unifiedDiff('', text('a'), P);
  assert.equal(filled.diff, patch('--- a/f.txt', '+++ b/f.txt', '@@ -0,0 +1 @@', '+a'));
});

test('a missing final newline is marked and counts as a change', () => {
  assert.equal(
    unifiedDiff('a\nb', 'a\nb\n', P).diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b')
  );
  assert.equal(
    unifiedDiff('a\nb\n', 'a\nb', P).diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '+b', '\\ No newline at end of file')
  );
  assert.equal(
    unifiedDiff('a\nb', 'x\nb', P).diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1,2 @@', '-a', '+x', ' b', '\\ No newline at end of file')
  );
});

test('CRLF to LF conversion shows every line as changed', () => {
  const result = unifiedDiff('a\r\nb\r\n', 'a\nb\n', P);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 2);
  assert.equal(result.diff, patch('--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1,2 @@', '-a\r', '-b\r', '+a', '+b'));
});

test('a NUL character on either side means binary', () => {
  const binary = { diff: '', added: 0, removed: 0, truncated: false, binary: true };
  assert.deepEqual(unifiedDiff('a\0b', 'a', P), binary);
  assert.deepEqual(unifiedDiff(null, 'PK\0\u0003', P), binary);
  assert.deepEqual(unifiedDiff('text', 'te\0xt', P), binary);
  assert.deepEqual(fragmentDiff('a', 'b\0', P), binary);
});

test('fragmentDiff numbers hunks from startLine', () => {
  const changed = fragmentDiff('foo\nbar', 'foo\nbaz', { path: 'f.txt', startLine: 10 });
  assert.equal(changed.diff, patch('--- a/f.txt', '+++ b/f.txt', '@@ -11 +11 @@', '-bar', '+baz'));
  assert.equal(changed.added, 1);
  assert.equal(changed.removed, 1);
  assert.equal(
    fragmentDiff('old line', 'new line', P).diff,
    patch('--- a/f.txt', '+++ b/f.txt', '@@ -1 +1 @@', '-old line', '+new line')
  );
  assert.equal(fragmentDiff('a', 'a\nb', { path: 'f.txt', startLine: 5 }).diff.split('\n')[2], '@@ -5,0 +6 @@');
  assert.equal(
    fragmentDiff('a\nb\nc', 'a\nX\nc', { path: 'f.txt', context: 1 }).diff.split('\n')[2],
    '@@ -1,3 +1,3 @@'
  );
  assert.equal(fragmentDiff('same', 'same', P).diff, '');
  // a snippet is not a file: no newline markers
  assert.ok(!fragmentDiff('a', 'b', P).diff.includes('No newline'));
});

test('lineOf finds the first occurrence', () => {
  const source = 'one\ntwo\nthree\ntwo\n';
  assert.equal(lineOf(source, 'one'), 1);
  assert.equal(lineOf(source, 'two'), 2);
  assert.equal(lineOf(source, 'three\ntwo'), 3);
  assert.equal(lineOf(source, 'wo\nth'), 2);
  assert.equal(lineOf(source, 'four'), 0);
  assert.equal(lineOf(source, ''), 0);
  assert.equal(lineOf(null, 'a'), 0);
  assert.equal(lineOf('a\r\nb', 'b'), 2);
});

test('truncation cuts at a line boundary and keeps the full counts', () => {
  const before = text(...numbered(1000, 'old'));
  const after = text(...numbered(1000, 'new'));
  const result = unifiedDiff(before, after, { ...P, maxChars: 500 });
  assert.equal(result.truncated, true);
  assert.equal(result.added, 1000);
  assert.equal(result.removed, 1000);
  assert.ok(result.diff.length <= 500);
  for (const line of result.diff.split('\n')) {
    assert.match(line, /^(--- a\/f\.txt|\+\+\+ b\/f\.txt|@@ -1,1000 \+1,1000 @@|-old\d+|\+new\d+)$/);
  }
  const whole = unifiedDiff(before, after, { ...P, maxChars: 1e9 });
  assert.equal(whole.truncated, false);
  assert.ok(whole.diff.startsWith(result.diff));
});

test('a few edits in a 50k-line file diff quickly', () => {
  const a = numbered(50000, 'line ');
  const b = a.slice();
  for (const at of [3, 12000, 25000, 25001, 49990]) b[at] = `${b[at]} edited`;
  b.splice(30000, 0, 'inserted');
  b.splice(40000, 2);
  const before = text(...a);
  const after = text(...b);
  unifiedDiff(before, after, P);
  const started = process.hrtime.bigint();
  const result = unifiedDiff(before, after, P);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed < 200, `took ${elapsed} ms`);
  assert.equal(applyPatch(before, result.diff), after);
  assert.equal(result.added, 5 + 1);
  assert.equal(result.removed, 5 + 2);
});

test('unrelated files over the edit-distance cap fall back to one replace hunk', () => {
  const random = mulberry32(7);
  const side = () => Array.from({ length: 20000 }, () => `r${Math.floor(random() * 1e9)}`);
  const before = text(...side());
  const after = text(...side());
  const started = Date.now();
  const result = unifiedDiff(before, after, { ...P, maxChars: 1e9 });
  assert.ok(Date.now() - started < 1500, 'fallback must return quickly');
  assert.ok(MAX_EDIT_DISTANCE < 20000);
  assert.deepEqual(headers(result.diff), ['@@ -1,20000 +1,20000 @@']);
  assert.equal(result.added, 20000);
  assert.equal(result.removed, 20000);
  assert.equal(applyPatch(before, result.diff), after);
});

test('the fallback keeps the untouched head and tail out of the hunk', () => {
  const head = numbered(50, 'head');
  const tail = numbered(50, 'tail');
  const a = [...head, ...numbered(MAX_EDIT_DISTANCE + 10, 'a'), ...tail];
  const b = [...head, ...numbered(MAX_EDIT_DISTANCE + 10, 'b'), ...tail];
  const result = unifiedDiff(text(...a), text(...b), { ...P, maxChars: 1e9 });
  assert.equal(result.added, MAX_EDIT_DISTANCE + 10);
  assert.equal(result.removed, MAX_EDIT_DISTANCE + 10);
  assert.equal(applyPatch(text(...a), result.diff), text(...b));
});

test('a large but cheap diff below the cap stays minimal', () => {
  const a = numbered(3000, 'x');
  const b = a.filter((_, i) => i % 3 !== 0);
  const result = unifiedDiff(text(...a), text(...b), { ...P, maxChars: 1e9 });
  assert.equal(result.removed, 1000);
  assert.equal(result.added, 0);
  assert.equal(applyPatch(text(...a), result.diff), text(...b));
});

test('random line arrays round-trip through applyPatch with minimal edits', () => {
  const random = mulberry32(20260929);
  const pick = (n) => Math.floor(random() * n);
  const vocabulary = ['a', 'b', 'c', '', 'd\r', '+a', '-b', '@@ x', 'e', 'f'];
  const randomLines = (max) => Array.from({ length: pick(max + 1) }, () => vocabulary[pick(vocabulary.length)]);
  const join = (lines, finalNewline) => lines.join('\n') + (lines.length && finalNewline ? '\n' : '');
  const lcs = (a, b) => {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    return table[0][0];
  };
  for (let round = 0; round < 400; round++) {
    const a = randomLines(30);
    let b;
    if (pick(3) === 0) {
      b = randomLines(30);
    } else {
      b = a.slice();
      for (let edits = pick(6); edits > 0; edits--) {
        const at = pick(b.length + 1);
        if (pick(2)) b.splice(at, pick(3), ...randomLines(3));
        else b[at] = vocabulary[pick(vocabulary.length)];
      }
      b = b.filter((line) => line !== undefined);
    }
    const aEol = pick(4) !== 0;
    const bEol = pick(4) !== 0;
    const before = join(a, aEol);
    const after = join(b, bEol);
    const context = pick(5);
    const result = unifiedDiff(before, after, { ...P, context, maxChars: 1e9 });
    assert.equal(applyPatch(before, result.diff), after, `round ${round}\n${result.diff}`);
    assertHeaders(result.diff, `round ${round}`);
    const body = result.diff.split('\n').filter((line) => line && !/^(---|\+\+\+) /.test(line));
    assert.equal(result.added, body.filter((line) => line[0] === '+').length, `round ${round}`);
    assert.equal(result.removed, body.filter((line) => line[0] === '-').length, `round ${round}`);
    if (aEol && bEol) assert.equal(result.added + result.removed, a.length + b.length - 2 * lcs(a, b), `round ${round}`);
    // created and deleted variants
    assert.equal(applyPatch('', unifiedDiff(null, before, P).diff), before);
    assert.equal(applyPatch(before, unifiedDiff(before, null, P).diff), '');
    assertHeaders(unifiedDiff(null, before, P).diff, `created ${round}`);
    assertHeaders(unifiedDiff(before, null, P).diff, `deleted ${round}`);
  }
});

test('nasty inputs give patches whose headers match their bodies and that apply', () => {
  const many = (count, edit) => Array.from({ length: count }, (_, i) => `line ${i}${i % 7 ? '' : ' ünï 😀'}${edit && i % 997 === 0 ? '!' : ''}`).join('\n') + '\n';
  const cases = {
    crlf: ['a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'],
    'crlf to lf': ['a\r\nb\r\n', 'a\nb\n'],
    'no final newline on both': ['a\nb\nc', 'a\nB\nc'],
    'final newline added': ['a\nb', 'a\nb\n'],
    'final newline removed': ['a\nb\n', 'a\nb'],
    'empty to content': ['', 'x\ny\n'],
    'content to empty': ['x\ny\n', ''],
    'empty to one line without newline': ['', 'x'],
    'whitespace only': ['a\n  b\n', 'a\n\tb\n'],
    'trailing space': ['a b\n', 'a b \n'],
    'very long lines': [`${'x'.repeat(200000)}\n`, `${'y'.repeat(200000)}\n`],
    'surrogate pairs': ['😀 a\n😀 b\n', '😀 a\n😀 B\n'],
    'repeated lines': ['a\na\na\na\n', 'a\na\nb\na\n'],
    'blank lines': ['\n\n\n', '\n\n'],
    'a few edits in 50k lines': [many(50000, false), many(50000, true)],
    'reversed 50k lines (over the edit-distance cap)': [many(50000, false), many(50000, false).split('\n').reverse().join('\n')],
  };
  for (const [name, [before, after]] of Object.entries(cases)) {
    const result = unifiedDiff(before, after, { ...P, maxChars: 1e9 });
    assert.equal(result.truncated, false, name);
    assertHeaders(result.diff, name);
    if (before.length < 1e6) assert.equal(applyPatch(before, result.diff), after, name);
  }
});
