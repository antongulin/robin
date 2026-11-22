// Reads the `with:` inputs a repository's Robin caller passes to the reusable workflow, so a replay
// runs with the same settings the original review used. Only plain scalars and literal/folded block
// scalars are read; values with GitHub expressions (`${{ }}`) and the `runner` input are skipped.
// Reusable-workflow callers (`uses: antongulin/robin/.github/workflows/review.yml@ref`) and direct action steps
// (`uses: antongulin/robin@ref`) both pass settings in a sibling `with:` mapping.
const CALLER = /^([ \t]*(?:-[ \t]*)?)uses:\s*antongulin\/robin(?:\/\.github\/workflows\/review\.ya?ml)?@([^\s#]+)/m;

export function parseCallerInputs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex(line => CALLER.test(line));
  if (at < 0) return null;
  const [, prefix, ref] = CALLER.exec(lines[at]);
  // Sibling keys of `uses:` start at its column (after an optional `- ` list marker).
  const indent = ' '.repeat(prefix.length);
  const inputs = {};
  const col = indent.length;
  // Column where a line's key starts (after indentation and an optional `- ` list marker).
  const keyColumn = line => /^[ \t]*(?:-[ \t]+)?/.exec(line)[0].length;
  const isWith = line => /^[ \t]*(?:-[ \t]+)?with:\s*(#.*)?$/.test(line);
  const isListStart = line => /^[ \t]*-[ \t]+/.test(line);
  let withAt = -1;
  // `with:` is a sibling key of `uses:` in the same mapping, before or after it.
  // When `uses:` opens its own list item, earlier lines belong to a previous item.
  for (let j = isListStart(lines[at]) ? -1 : at - 1; j >= 0 && withAt < 0; j--) {
    const line = lines[j];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const key = keyColumn(line);
    if (key < col) break;
    if (key === col && isWith(line)) withAt = j;
    if (key === col && isListStart(line)) break;
  }
  if (withAt < 0) {
    for (let j = at + 1; j < lines.length && withAt < 0; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const key = keyColumn(line);
      if (key < col || (key === col && isListStart(line))) break;
      if (key === col && isWith(line)) withAt = j;
    }
  }
  if (withAt < 0) return { ref, inputs };
  let i = withAt + 1;
  let keyIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const lead = /^[ \t]*/.exec(line)[0].length;
    if (lead <= col) break;
    if (keyIndent === null) keyIndent = lead;
    if (lead !== keyIndent) { i++; continue; }
    const m = /^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    i++;
    if (!m) continue;
    const [, key, rawValue] = m;
    let value;
    if (/^[|>][+-]?$/.test(rawValue)) {
      const block = [];
      let blockIndent = null;
      while (i < lines.length) {
        const next = lines[i];
        const nextLead = /^[ \t]*/.exec(next)[0].length;
        if (next.trim() && nextLead <= keyIndent) break;
        if (next.trim() && blockIndent === null) blockIndent = nextLead;
        block.push(next.trim() ? next.slice(blockIndent) : '');
        i++;
      }
      while (block.length && !block[block.length - 1]) block.pop();
      value = rawValue.startsWith('|') ? block.join('\n') + (rawValue.endsWith('-') ? '' : '\n')
        : block.join(' ').replace(/\s+/g, ' ').trim() + (rawValue.endsWith('-') ? '' : '\n');
    } else {
      value = rawValue.replace(/\s+#.*$/, '');
      const quoted = /^(['"])(.*)\1$/.exec(value);
      if (quoted) value = quoted[1] === "'" ? quoted[2].replace(/''/g, "'") : quoted[2];
    }
    if (key === 'runner' || String(value).includes('${{')) continue;
    inputs[key] = String(value);
  }
  return { ref, inputs };
}
