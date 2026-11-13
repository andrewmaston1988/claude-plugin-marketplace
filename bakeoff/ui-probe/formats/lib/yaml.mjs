// Minimal YAML subset, enough for the flat scenario shape: block mappings and
// sequences, flow maps/sequences, quoted and plain scalars, comments.
// No anchors, tags, multi-document streams or block scalars — none are needed,
// and a parser that silently mis-reads YAML would corrupt the validity score.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote && line[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function splitKey(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === ':' && depth === 0) {
      const after = text[i + 1];
      if (after === undefined || after === ' ') return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function scalar(raw) {
  const text = raw.trim();
  if (text === '') return null;
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    return JSON.parse(text.replace(/\\'/g, "'"));
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitTopLevel(text.slice(1, -1), ',').map(scalar);
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const out = {};
    for (const pair of splitTopLevel(text.slice(1, -1), ',')) {
      const kv = splitKey(pair);
      if (!kv) throw new Error(`flow map entry without "key: value": ${JSON.stringify(pair)}`);
      out[scalar(kv[0])] = scalar(kv[1]);
    }
    return out;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

export function parseYaml(source) {
  const lines = [];
  source.split(/\r?\n/).forEach((raw, n) => {
    const text = stripComment(raw).replace(/\s+$/, '');
    if (!text.trim()) return;
    const indent = text.match(/^ */)[0].length;
    if (/^\t/.test(text)) throw new Error(`line ${n + 1}: tabs are not allowed for indentation`);
    lines.push({ indent, content: text.slice(indent), n: n + 1 });
  });
  let i = 0;

  function parseBlock(indent) {
    if (i >= lines.length) return null;
    if (lines[i].indent < indent) return null;
    if (lines[i].content.startsWith('- ') || lines[i].content === '-') return parseSeq(lines[i].indent);
    return parseMap(lines[i].indent);
  }

  function parseSeq(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].content.startsWith('- ') || lines[i].content === '-')) {
      const line = lines[i];
      const rest = line.content.slice(1).trim();
      i += 1;
      if (rest === '') {
        out.push(parseBlock(indent + 1));
      } else if (splitKey(rest)) {
        // "- key: value" starts a mapping whose remaining keys sit at indent + 2
        const map = {};
        const [k, v] = splitKey(rest);
        // The key starts two columns in (after "- "), so its child block is at +4.
        assign(map, scalar(k), v, indent + 4, line.n);
        while (i < lines.length && lines[i].indent === indent + 2 && !lines[i].content.startsWith('- ')) {
          const inner = lines[i];
          const kv = splitKey(inner.content);
          if (!kv) throw new Error(`line ${inner.n}: expected "key: value"`);
          i += 1;
          assign(map, scalar(kv[0]), kv[1], indent + 4, inner.n);
        }
        out.push(map);
      } else {
        out.push(scalar(rest));
      }
    }
    return out;
  }

  function parseMap(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent) {
      const line = lines[i];
      if (line.content.startsWith('- ')) break;
      const kv = splitKey(line.content);
      if (!kv) throw new Error(`line ${line.n}: expected "key: value", got ${JSON.stringify(line.content)}`);
      i += 1;
      assign(out, scalar(kv[0]), kv[1], indent + 1, line.n);
    }
    return out;
  }

  function assign(map, key, rawValue, childIndent, lineNo) {
    if (rawValue === '') {
      if (i < lines.length && lines[i].indent >= childIndent) map[key] = parseBlock(lines[i].indent);
      else map[key] = null;
    } else {
      map[key] = scalar(rawValue);
    }
    void lineNo;
  }

  const value = parseBlock(0);
  if (i < lines.length) throw new Error(`line ${lines[i].n}: unexpected indentation`);
  return value;
}
