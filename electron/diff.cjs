'use strict';

// Dependency-free unified diff for the change tracker. Pure and deterministic, no fs.
//
// Lines are split on "\n" and keep a trailing "\r", so a CRLF<->LF conversion shows up as
// changed lines, as it does in git. The common prefix and suffix are trimmed first, then
// Myers O(ND) runs on the rest. The edit distance is capped at MAX_EDIT_DISTANCE (inserted
// plus deleted lines): a bigger difference is reported as one replace hunk covering the
// whole differing middle, so two unrelated 20k-line files never take long.

const MAX_EDIT_DISTANCE = 2000;
const DEFAULT_MAX_CHARS = 60000;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

function splitLines(text, markEol) {
  if (!text) return { lines: [], noEol: false };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
    return { lines, noEol: false };
  }
  return { lines, noEol: markEol };
}

// A last line without a newline must not equal the same text with one: the key carries a
// NUL sentinel (texts containing NUL never get here, they are reported as binary).
function keysOf(lines, noEol) {
  if (!noEol) return lines;
  const keys = lines.slice();
  keys[keys.length - 1] += '\0';
  return keys;
}

// Myers with a per-step snapshot of the furthest-reaching table for backtracking.
// Returns edit blocks {aStart, aEnd, bStart, bEnd} (half-open, 0-based) or null over the cap.
function myers(a, b, base) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [null];
  for (let d = 0; d <= max; d++) {
    // trace[d] holds diagonals -(d-1)..d-1 as they were before step d
    if (d > 0) trace.push(v.slice(offset - d + 1, offset + d));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d, base);
    }
  }
  return null;
}

function backtrack(trace, n, m, d, base) {
  // (x, y) is where step dd ended; the edit of step dd starts at (px, py)
  const edits = [];
  let x = n;
  let y = m;
  for (let dd = d; dd > 0; dd--) {
    const snap = trace[dd];
    const at = (k) => snap[k + dd - 1];
    const k = x - y;
    const insert = k === -dd || (k !== dd && at(k - 1) < at(k + 1));
    const prevK = insert ? k + 1 : k - 1;
    const px = at(prevK);
    const py = px - prevK;
    edits.push(px, py, insert);
    x = px;
    y = py;
  }
  const blocks = [];
  let cur = null;
  for (let i = edits.length - 3; i >= 0; i -= 3) {
    const ax = edits[i] + base;
    const by = edits[i + 1] + base;
    if (!cur || cur.aEnd !== ax || cur.bEnd !== by) {
      cur = { aStart: ax, aEnd: ax, bStart: by, bEnd: by };
      blocks.push(cur);
    }
    if (edits[i + 2]) cur.bEnd++;
    else cur.aEnd++;
  }
  return blocks;
}

function diffBlocks(ak, bk) {
  const n = ak.length;
  const m = bk.length;
  const lim = Math.min(n, m);
  let p = 0;
  while (p < lim && ak[p] === bk[p]) p++;
  let s = 0;
  while (s < lim - p && ak[n - 1 - s] === bk[m - 1 - s]) s++;
  const aEnd = n - s;
  const bEnd = m - s;
  if (p === aEnd && p === bEnd) return [];
  const whole = [{ aStart: p, aEnd, bStart: p, bEnd }];
  if (p === aEnd || p === bEnd) return whole;
  const ids = new Map();
  const intern = (key) => {
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const a = new Int32Array(aEnd - p);
  const b = new Int32Array(bEnd - p);
  for (let i = p; i < aEnd; i++) a[i - p] = intern(ak[i]);
  for (let i = p; i < bEnd; i++) b[i - p] = intern(bk[i]);
  return myers(a, b, p) || whole;
}

function range(start, count) {
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start + 1}` : `${start + 1},${count}`;
}

function render(a, b, blocks, opts) {
  const { aLines, aNoEol, aNull } = a;
  const { bLines, bNoEol, bNull } = b;
  const ctx = opts.context;
  const base = opts.base;
  const limit = opts.maxChars;
  const path = opts.path || 'file';
  const out = [];
  let size = 0;
  let truncated = false;
  let added = 0;
  let removed = 0;
  for (const blk of blocks) {
    removed += blk.aEnd - blk.aStart;
    added += blk.bEnd - blk.bStart;
  }

  const push = (line, force) => {
    if (truncated) return false;
    if (!force && size + line.length + 1 > limit) {
      truncated = true;
      return false;
    }
    out.push(line);
    size += line.length + 1;
    return true;
  };
  const shown = (prefix, lines, from, to, last, noEol) => {
    for (let i = from; i < to; i++) {
      if (!push(prefix + lines[i])) return false;
      if (noEol && i === last && !push(NO_NEWLINE_MARKER)) return false;
    }
    return true;
  };

  if (blocks.length) {
    push(`--- ${aNull ? '/dev/null' : `a/${path}`}`, true);
    push(`+++ ${bNull ? '/dev/null' : `b/${path}`}`, true);
  }
  const lastA = aLines.length - 1;
  const lastB = bLines.length - 1;
  for (let i = 0; i < blocks.length && !truncated; ) {
    // blocks whose contexts touch or overlap share a hunk
    let j = i;
    while (j + 1 < blocks.length && blocks[j + 1].aStart - blocks[j].aEnd <= 2 * ctx) j++;
    const first = blocks[i];
    const last = blocks[j];
    const lead = Math.min(ctx, first.aStart);
    const trail = Math.min(ctx, aLines.length - last.aEnd);
    const aFrom = first.aStart - lead;
    const bFrom = first.bStart - lead;
    const aCount = last.aEnd + trail - aFrom;
    const bCount = last.bEnd + trail - bFrom;
    if (!push(`@@ -${range(base + aFrom, aCount)} +${range(base + bFrom, bCount)} @@`)) break;
    let pos = aFrom;
    for (let t = i; t <= j; t++) {
      const blk = blocks[t];
      if (!shown(' ', aLines, pos, blk.aStart, lastA, aNoEol)) break;
      if (!shown('-', aLines, blk.aStart, blk.aEnd, lastA, aNoEol)) break;
      if (!shown('+', bLines, blk.bStart, blk.bEnd, lastB, bNoEol)) break;
      pos = blk.aEnd;
    }
    if (!truncated) shown(' ', aLines, pos, pos + trail, lastA, aNoEol);
    i = j + 1;
  }
  return { diff: out.join('\n'), added, removed, truncated, binary: false };
}

function hasNul(text) {
  return typeof text === 'string' && text.indexOf('\0') !== -1;
}

function build(before, after, opts, markEol) {
  const aNull = before === null || before === undefined;
  const bNull = after === null || after === undefined;
  const aText = aNull ? '' : String(before);
  const bText = bNull ? '' : String(after);
  if (hasNul(aText) || hasNul(bText)) return { diff: '', added: 0, removed: 0, truncated: false, binary: true };
  if (aText === bText) return { diff: '', added: 0, removed: 0, truncated: false, binary: false };
  const A = splitLines(aText, markEol);
  const B = splitLines(bText, markEol);
  const blocks = diffBlocks(keysOf(A.lines, A.noEol), keysOf(B.lines, B.noEol));
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : DEFAULT_MAX_CHARS;
  const context = Number.isInteger(opts.context) && opts.context >= 0 ? opts.context : opts.defaultContext;
  return render(
    { aLines: A.lines, aNoEol: A.noEol, aNull },
    { bLines: B.lines, bNoEol: B.noEol, bNull },
    blocks,
    { path: opts.path, context, maxChars, base: opts.base }
  );
}

// before === null: the file was created; after === null: it was deleted.
function unifiedDiff(before, after, options = {}) {
  return build(before, after, { ...options, defaultContext: 3, base: 0 }, true);
}

// Diff of two snippets (provider edit events); hunk line numbers start at startLine.
function fragmentDiff(oldText, newText, options = {}) {
  const startLine = Number.isInteger(options.startLine) && options.startLine > 0 ? options.startLine : 1;
  return build(oldText, newText, { ...options, defaultContext: 0, base: startLine - 1 }, false);
}

// 1-based line of the first occurrence of fragment in text, or 0.
function lineOf(text, fragment) {
  if (typeof text !== 'string' || typeof fragment !== 'string' || !fragment) return 0;
  const index = text.indexOf(fragment);
  if (index < 0) return 0;
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) line++;
  return line;
}

module.exports = { unifiedDiff, fragmentDiff, lineOf, MAX_EDIT_DISTANCE };
