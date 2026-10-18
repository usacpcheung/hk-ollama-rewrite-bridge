const OpenCC = require('opencc-js');

// Use the same ordered dictionaries and longest-match rules as Converter(cn, hk).
// Trees are shared; pending input belongs to one request and one conversion stage.
const trees = [OpenCC.Locale.from.cn, OpenCC.Locale.to.hk].map(group => {
  const trie = new OpenCC.Trie();
  trie.loadDictGroup(group);
  return trie.map;
});
function createRewriteStreamConverter() {
  const pending = trees.map(() => '');
  function stage(index, text, final) {
    const input = pending[index] + text;
    let output = '', offset = 0;
    while (offset < input.length) {
      let node = trees[index], cursor = offset, end = 0, replacement;
      while (cursor < input.length) {
        const code = input.codePointAt(cursor);
        // A provider can split a UTF-16 surrogate pair between JSON events.
        if (!final && cursor === input.length - 1 && code >= 0xd800 && code <= 0xdbff) break;
        const child = node.get(code);
        if (!child) break;
        cursor += code > 0xffff ? 2 : 1;
        node = child;
        if (node.trie_val !== undefined) { end = cursor; replacement = node.trie_val; }
      }
      const trailingHigh = cursor === input.length - 1 && /[\uD800-\uDBFF]/.test(input[cursor]);
      if (!final && ((cursor === input.length && node.size > 0) || trailingHigh)) break;
      if (end) { output += replacement; offset = end; }
      else {
        const width = input.codePointAt(offset) > 0xffff ? 2 : 1;
        output += input.slice(offset, offset + width);
        offset += width;
      }
    }
    pending[index] = input.slice(offset);
    return output;
  }
  return { write(text, final = false) {
    return trees.reduce((value, _tree, index) => stage(index, value, final), text);
  } };
}
module.exports = { createRewriteStreamConverter };
