const { createRewriteStreamConverter } = require('./rewrite-stream-converter');

// Only balanced, explicitly delimited input quotations qualify. Apostrophes are
// deliberately excluded: English contractions are not quotation boundaries.
const PAIRS = new Map([['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"']]);
function quoteStep(stack, char, index) {
  if (stack.length && char === stack.at(-1).close) return stack.pop();
  if (PAIRS.has(char)) stack.push({ start: index, close: PAIRS.get(char) });
  return null;
}
function quotedSpans(text) {
  const stack = [], spans = [];
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!escaped) {
      const closed = quoteStep(stack, char, i);
      if (closed) spans.push({ start: closed.start, end: i + 1 });
    }
    escaped = char === '\\' && !escaped;
  }
  return spans;
}

function createQuotePreservingConverter(inputText = '') {
  // Store offsets, not all nested substrings (which would require quadratic memory).
  const input = typeof inputText === 'string' ? inputText : '';
  const byLength = new Map();
  let limit = 0;
  for (const span of quotedSpans(input)) {
    const length = span.end - span.start;
    if (!byLength.has(length)) byLength.set(length, []);
    byLength.get(length).push(span.start);
    limit = Math.max(limit, length);
  }
  let normal = createRewriteStreamConverter();
  if (!limit) return normal;
  let pending = '', stack = [], escaped = false;
  function convertBuffered(text) {
    const matches = quotedSpans(text).filter(span => {
      const starts = byLength.get(span.end - span.start);
      const literal = text.slice(span.start, span.end);
      return starts?.some(start => input.startsWith(literal, start));
    }).sort((a, b) => a.start - b.start || b.end - a.end);
    let output = '', offset = 0;
    for (const span of matches) {
      if (span.start < offset) continue; // The outer exact quotation already covers it.
      output += normal.write(text.slice(offset, span.start), true);
      output += text.slice(span.start, span.end);
      normal = createRewriteStreamConverter();
      offset = span.end;
    }
    return output + normal.write(text.slice(offset));
  }
  return { write(text, final = false) {
    let output = '', plain = '';
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (!pending && !escaped && PAIRS.has(char)) {
        output += normal.write(plain); plain = '';
        pending = char; stack = [{ start: 0, close: PAIRS.get(char) }];
      } else if (pending) {
        pending += char;
        if (!escaped) quoteStep(stack, char, pending.length - 1);
        // Overlong/unclosed output cannot grow an unbounded streaming buffer.
        if (!stack.length) {
          output += convertBuffered(pending); pending = '';
        } else if (pending.length > limit) {
          // An overlong outer quotation cannot match, but a nested quotation
          // still can. Retain the earliest eligible inner opening, if any.
          const keep = stack.find(span => span.start > 0 && pending.length - span.start <= limit)?.start;
          if (keep !== undefined) {
            output += convertBuffered(pending.slice(0, keep));
            pending = pending.slice(keep);
            stack = stack.filter(span => span.start >= keep).map(span => ({ ...span, start: span.start - keep }));
          } else { output += convertBuffered(pending); pending = ''; stack = []; }
        }
      } else plain += char;
      escaped = char === '\\' && !escaped;
    }
    output += normal.write(plain);
    if (final) {
      output += convertBuffered(pending); pending = ''; stack = []; escaped = false;
      output += normal.write('', true);
    }
    return output;
  } };
}
module.exports = { createQuotePreservingConverter, quotedSpans };
