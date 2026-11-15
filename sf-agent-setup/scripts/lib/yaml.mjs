// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
// Minimal, STRICT YAML subset parser/serializer. Zero dependencies.
//
// Supported: block mappings, block sequences, plain/'single'/"double" scalars, flow [..] and {..}
// collections (may span lines), block scalars (| |- |+ > >-), comments, one optional leading "---".
// Rejected with a line-numbered error: tabs for indentation, duplicate keys, anchors/aliases/tags,
// multi-document streams, multi-line plain scalars, ambiguous plain booleans (yes/no/on/off/True),
// plain scalars containing ": ", inconsistent indentation, trailing garbage.

export class YamlError extends Error {
  /** @param {string} message @param {number} line @param {string} filename */
  constructor(message, line, filename) {
    super(`${filename}:${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
    this.filename = filename;
  }
}

const AMBIGUOUS_BOOL = /^(yes|no|on|off|true|false|null)$/i;

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (q === '"' && ch === '\\') i++;
      else if (ch === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else q = null;
      }
    } else if ((ch === '"' || ch === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) {
      q = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

class Parser {
  constructor(text, filename) {
    this.filename = filename;
    this.raw = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
    this.i = 0;
  }

  err(msg, idx = this.i) {
    throw new YamlError(msg, idx + 1, this.filename);
  }

  /** Next meaningful line (not consumed): {indent,text,idx} or null. */
  peek() {
    for (let j = this.i; j < this.raw.length; j++) {
      const r = this.raw[j];
      const lead = /^[ \t]*/.exec(r)[0];
      const body = stripComment(r.slice(lead.length)).trimEnd();
      if (body === '') continue;
      if (lead.includes('\t')) this.err('tabs are not allowed for indentation; use spaces', j);
      return { indent: lead.length, text: body, idx: j };
    }
    return null;
  }

  parseDocument() {
    const first = this.peek();
    if (first && first.text === '---') this.i = first.idx + 1;
    const n = this.peek();
    if (!n) return null;
    if (n.text === '---' || n.text === '...') this.err('multiple YAML documents are not supported', n.idx);
    if (n.indent !== 0) this.err('top-level content must start at column 0', n.idx);
    const value = this.parseBlock(n.indent);
    const rest = this.peek();
    if (rest) {
      if (rest.text === '---' || rest.text === '...') this.err('multiple YAML documents are not supported', rest.idx);
      this.err(`unexpected content (check indentation): "${rest.text}"`, rest.idx);
    }
    return value;
  }

  isSeqItem(t) {
    return t === '-' || t.startsWith('- ');
  }

  parseBlock(indent) {
    const n = this.peek();
    if (this.isSeqItem(n.text)) return this.parseSeq(indent);
    if (this.splitKey(n.text, n.idx)) return this.parseMap(indent);
    this.err(`expected a "key: value" mapping or "- item" list, found: "${n.text}"`, n.idx);
  }

  parseMap(indent) {
    const obj = {};
    const seen = new Set();
    for (;;) {
      const n = this.peek();
      if (!n || n.indent < indent) break;
      if (n.indent > indent) this.err('unexpected indentation', n.idx);
      if (n.text === '---' || n.text === '...') this.err('multiple YAML documents are not supported', n.idx);
      if (this.isSeqItem(n.text)) this.err('unexpected "-" list item inside a mapping', n.idx);
      const kv = this.splitKey(n.text, n.idx);
      if (!kv) this.err(`expected "key: value", found: "${n.text}"`, n.idx);
      if (kv.key === '__proto__') this.err('key "__proto__" is not allowed', n.idx);
      if (seen.has(kv.key)) this.err(`duplicate key "${kv.key}"`, n.idx);
      seen.add(kv.key);
      this.i = n.idx + 1;
      obj[kv.key] = this.parseValue(indent, kv.rest, n.idx, true);
    }
    return obj;
  }

  parseSeq(indent) {
    const arr = [];
    for (;;) {
      const n = this.peek();
      if (!n || n.indent < indent) break;
      if (n.indent > indent) this.err('unexpected indentation', n.idx);
      if (!this.isSeqItem(n.text)) break;
      const after = n.text.slice(1);
      const content = after.trimStart();
      const contentCol = indent + 1 + (after.length - content.length);
      if (content === '') {
        this.i = n.idx + 1;
        arr.push(this.parseValue(indent, '', n.idx, false));
      } else if (this.isSeqItem(content) || this.splitKey(content, n.idx)) {
        this.raw[n.idx] = ' '.repeat(contentCol) + content;
        arr.push(this.parseBlock(contentCol));
      } else {
        this.i = n.idx + 1;
        arr.push(this.parseValue(indent, content, n.idx, false));
      }
    }
    return arr;
  }

  parseValue(parentIndent, rest, idx, inMap) {
    if (rest === '') {
      const n = this.peek();
      if (n && n.indent > parentIndent) return this.parseBlock(n.indent);
      if (inMap && n && n.indent === parentIndent && this.isSeqItem(n.text)) return this.parseSeq(parentIndent);
      return null;
    }
    if (rest[0] === '|' || rest[0] === '>') return this.blockScalar(parentIndent, rest, idx);
    if (rest[0] === '[' || rest[0] === '{') return this.flow(rest, idx);
    return this.scalar(rest, idx);
  }

  /** Split "key: rest" → {key, rest} or null when the line is not a mapping entry. */
  splitKey(text, idx) {
    if (text[0] === '[' || text[0] === '{') return null;
    if (text[0] === '"' || text[0] === "'") {
      const q = this.scanQuoted(text, 0, idx);
      const after = text.slice(q.end).trimStart();
      if (after[0] !== ':') return null;
      const rest = after.slice(1);
      if (rest !== '' && rest[0] !== ' ') return null;
      return { key: q.value, rest: rest.trim() };
    }
    for (let j = 0; j < text.length; j++) {
      if (text[j] === ':' && (j === text.length - 1 || text[j + 1] === ' ')) {
        const key = text.slice(0, j).trimEnd();
        if (key === '') this.err('empty mapping key', idx);
        if (/^[&*!%@`?|>]/.test(key)) this.err(`unsupported or reserved character at start of key "${key}"; quote it`, idx);
        return { key, rest: text.slice(j + 1).trim() };
      }
    }
    return null;
  }

  scanQuoted(text, start, idx) {
    const q = text[start];
    let out = '';
    let j = start + 1;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (q === '"') {
        if (ch === '\\') {
          const nx = text[++j];
          const map = { n: '\n', t: '\t', r: '\r', '0': '\0', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/', ' ': ' ' };
          if (nx === 'u') {
            const hex = text.slice(j + 1, j + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.err('invalid \\u escape', idx);
            out += String.fromCharCode(parseInt(hex, 16));
            j += 4;
          } else if (nx in map) out += map[nx];
          else this.err(`unknown escape "\\${nx ?? ''}" in double-quoted string`, idx);
        } else if (ch === '"') return { value: out, end: j + 1 };
        else out += ch;
      } else if (ch === "'") {
        if (text[j + 1] === "'") {
          out += "'";
          j++;
        } else return { value: out, end: j + 1 };
      } else out += ch;
    }
    return this.err('unterminated quoted string (multi-line quoted strings are not supported)', idx);
  }

  resolvePlain(t, idx) {
    if (t === '' || t === '~' || t === 'null') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (AMBIGUOUS_BOOL.test(t)) {
      this.err(`ambiguous value "${t}": use true/false/null, or quote it ("${t}") to keep it as text`, idx);
    }
    if (/^[-+]?(0|[1-9]\d*)$/.test(t)) {
      const n = Number(t);
      return Number.isSafeInteger(n) ? n : t;
    }
    if (/^[-+]?(\d+\.\d+|\.\d+)([eE][-+]?\d+)?$/.test(t) || /^[-+]?\d+[eE][-+]?\d+$/.test(t)) return Number(t);
    return t;
  }

  scalar(text, idx) {
    const c = text[0];
    if (c === '"' || c === "'") {
      const q = this.scanQuoted(text, 0, idx);
      if (text.slice(q.end).trim() !== '') this.err('unexpected text after closing quote', idx);
      return q.value;
    }
    if (/[&*!%@`]/.test(c)) this.err(`unsupported YAML feature or reserved character "${c}" (anchors, aliases, tags are not supported); quote the value`, idx);
    if (c === '?' && text[1] === ' ') this.err('complex keys ("? ") are not supported', idx);
    if (/(^|\s):(\s|$)/.test(text) || /: /.test(text) || text.endsWith(':')) {
      this.err(`plain value "${text}" contains ": "; wrap it in quotes`, idx);
    }
    if (text === '---' || text === '...') this.err('unexpected document marker', idx);
    return this.resolvePlain(text.trim(), idx);
  }

  blockScalar(parentIndent, header, idx) {
    const m = /^([|>])([-+]?)$/.exec(header);
    if (!m) this.err(`invalid block scalar header "${header}" (supported: | |- |+ > >- >+)`, idx);
    const [, style, chomp] = m;
    const lines = [];
    let blockIndent = null;
    let j = this.i;
    for (; j < this.raw.length; j++) {
      const r = this.raw[j];
      if (r.trim() === '') {
        lines.push('');
        continue;
      }
      const lead = /^ */.exec(r)[0].length;
      if (/^\t/.test(r)) this.err('tabs are not allowed for indentation', j);
      if (blockIndent === null) {
        if (lead <= parentIndent) break;
        blockIndent = lead;
      }
      if (lead < blockIndent) break;
      lines.push(r.slice(blockIndent));
    }
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end--;
    const trailing = lines.length - end;
    this.i = j;
    const body = lines.slice(0, end);
    if (blockIndent === null && body.length === 0) return '';
    let text;
    if (style === '|') text = body.join('\n');
    else {
      text = '';
      for (let k = 0; k < body.length; k++) {
        const l = body[k];
        if (k === 0) text = l;
        else if (l === '' ) text += '\n';
        else if (body[k - 1] === '' || /^\s/.test(l) || /^\s/.test(body[k - 1])) text += (body[k - 1] === '' ? '' : '\n') + l;
        else text += ' ' + l;
      }
    }
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n'.repeat(trailing + 1);
    return text === '' ? '' : text + '\n';
  }

  flow(first, idx) {
    let s = first;
    const depthOf = (str) => {
      let depth = 0;
      let q = null;
      for (let k = 0; k < str.length; k++) {
        const ch = str[k];
        if (q) {
          if (q === '"' && ch === '\\') k++;
          else if (ch === q) {
            if (q === "'" && str[k + 1] === "'") k++;
            else q = null;
          }
        } else if ((ch === '"' || ch === "'") && (k === 0 || /[\s[{,:]/.test(str[k - 1]))) q = ch;
        else if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') depth--;
      }
      return depth;
    };
    while (depthOf(s) > 0) {
      if (this.i >= this.raw.length) this.err('unterminated flow collection', idx);
      s += ' ' + stripComment(this.raw[this.i]).trim();
      this.i++;
    }
    const ctx = { s, pos: 0, idx };
    const v = this.flowValue(ctx);
    this.flowWs(ctx);
    if (ctx.pos !== s.length) this.err(`unexpected text after flow collection: "${s.slice(ctx.pos)}"`, idx);
    return v;
  }

  flowWs(c) {
    while (c.pos < c.s.length && /\s/.test(c.s[c.pos])) c.pos++;
  }

  flowValue(c) {
    this.flowWs(c);
    const ch = c.s[c.pos];
    if (ch === '[') {
      c.pos++;
      const arr = [];
      for (;;) {
        this.flowWs(c);
        if (c.s[c.pos] === ']') {
          c.pos++;
          return arr;
        }
        arr.push(this.flowValue(c));
        this.flowWs(c);
        if (c.s[c.pos] === ',') c.pos++;
        else if (c.s[c.pos] !== ']') this.err('expected "," or "]" in flow list', c.idx);
      }
    }
    if (ch === '{') {
      c.pos++;
      const obj = {};
      for (;;) {
        this.flowWs(c);
        if (c.s[c.pos] === '}') {
          c.pos++;
          return obj;
        }
        let key;
        if (c.s[c.pos] === '"' || c.s[c.pos] === "'") {
          const q = this.scanQuoted(c.s, c.pos, c.idx);
          key = q.value;
          c.pos = q.end;
        } else {
          const st = c.pos;
          while (c.pos < c.s.length && !(c.s[c.pos] === ':' && (c.s[c.pos + 1] === ' ' || c.pos + 1 === c.s.length)) && !',}'.includes(c.s[c.pos])) c.pos++;
          key = c.s.slice(st, c.pos).trim();
        }
        this.flowWs(c);
        if (c.s[c.pos] !== ':') this.err(`expected ":" after key "${key}" in flow mapping`, c.idx);
        c.pos++;
        if (key === '__proto__') this.err('key "__proto__" is not allowed', c.idx);
        if (Object.hasOwn(obj, key)) this.err(`duplicate key "${key}"`, c.idx);
        obj[key] = this.flowValue(c);
        this.flowWs(c);
        if (c.s[c.pos] === ',') c.pos++;
        else if (c.s[c.pos] !== '}') this.err('expected "," or "}" in flow mapping', c.idx);
      }
    }
    if (ch === '"' || ch === "'") {
      const q = this.scanQuoted(c.s, c.pos, c.idx);
      c.pos = q.end;
      return q.value;
    }
    const st = c.pos;
    while (c.pos < c.s.length && !',]}'.includes(c.s[c.pos])) c.pos++;
    const tok = c.s.slice(st, c.pos).trim();
    if (/: |:$/.test(tok)) this.err(`unexpected ":" in flow value "${tok}"; quote it`, c.idx);
    if (tok !== '' && /[&*!%@`]/.test(tok[0])) this.err(`unsupported or reserved character "${tok[0]}"; quote the value`, c.idx);
    return this.resolvePlain(tok, c.idx);
  }
}

/**
 * Parse strict YAML.
 * @param {string} text
 * @param {{filename?: string}} [opts]
 * @returns {any}
 */
export function parse(text, { filename = '<yaml>' } = {}) {
  return new Parser(text, filename).parseDocument();
}

// ---------------------------------------------------------------- serializer

const RESERVED_PLAIN = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

function plainSafe(s) {
  if (s === '' || RESERVED_PLAIN.test(s)) return false;
  if (/^[-+]?[\d.]/.test(s) && !/[A-Za-z]/.test(s.replace(/[eE]/g, ''))) return false;
  if (/^[-+]?\d/.test(s) && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return false;
  return /^[A-Za-z0-9_./~][A-Za-z0-9_ ./()+=@$-]*$/.test(s) && !s.endsWith(' ') && !s.includes('  ');
}

function keyStr(k) {
  return /^[A-Za-z_][A-Za-z0-9_.\-/]*$/.test(k) && !RESERVED_PLAIN.test(k) ? k : JSON.stringify(k);
}

function scalarStr(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return plainSafe(s) ? s : JSON.stringify(s);
}

function isScalar(v) {
  return v === null || v === undefined || typeof v !== 'object';
}

function emit(value, indent, out) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item) && !(typeof item === 'string' && item.includes('\n'))) out.push(`${pad}- ${scalarStr(item)}`);
      else if (typeof item === 'string') {
        out.push(`${pad}- ${item.endsWith('\n') ? '|' : '|-'}`);
        for (const l of item.replace(/\n$/, '').split('\n')) out.push(l === '' ? '' : `${pad}  ${l}`);
      } else if (Array.isArray(item) ? item.length === 0 : Object.keys(item).length === 0) {
        out.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`);
      } else if (Array.isArray(item)) {
        out.push(`${pad}-`);
        emit(item, indent + 2, out);
      } else {
        const sub = [];
        emit(item, indent + 2, sub);
        sub[0] = `${pad}- ${sub[0].slice(indent + 2)}`;
        out.push(...sub);
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const key = keyStr(k);
    if (typeof v === 'string' && v.includes('\n')) {
      out.push(`${pad}${key}: ${v.endsWith('\n') ? '|' : '|-'}`);
      for (const l of v.replace(/\n$/, '').split('\n')) out.push(l === '' ? '' : `${pad}  ${l}`);
    } else if (isScalar(v)) out.push(`${pad}${key}: ${scalarStr(v)}`);
    else if (Array.isArray(v)) {
      if (v.length === 0) out.push(`${pad}${key}: []`);
      else {
        out.push(`${pad}${key}:`);
        emit(v, indent + 2, out);
      }
    } else if (Object.keys(v).length === 0) out.push(`${pad}${key}: {}`);
    else {
      out.push(`${pad}${key}:`);
      emit(v, indent + 2, out);
    }
  }
}

/** Serialize a JSON-compatible value to block-style YAML. */
export function stringify(value) {
  if (isScalar(value)) return scalarStr(value) + '\n';
  const out = [];
  if (Array.isArray(value) && value.length === 0) return '[]\n';
  if (!Array.isArray(value) && Object.keys(value).length === 0) return '{}\n';
  emit(value, 0, out);
  return out.join('\n') + '\n';
}
