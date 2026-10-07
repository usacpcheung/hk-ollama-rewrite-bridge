// Native prompt layouts are provider-owned; service instructions are unchanged.
const MINIMAX_USER_TEMPLATE = '把下方文字改寫為繁體書面語：\n{TEXT}';
function rewriteArguments(request, template) {
  // Compatibility for direct legacy adapter callers; production uses text/instructions.
  if (typeof request.text !== 'string') return request;
  const userContent = template.replace('{TEXT}', () => request.text);
  return { ...request, systemPrompt: request.instructions, userContent,
    prompt: [request.instructions, userContent].filter(value => typeof value === 'string' && value.length).join('\n\n'),
    maxTokens: request.outputBudget };
}
function withRewriteService(native, template) {
  return { ...native, services: { rewrite: {
    sync: request => native.rewrite(rewriteArguments(request, template)),
    stream: request => native.rewriteStream(rewriteArguments(request, template))
  } } };
}
module.exports = { MINIMAX_USER_TEMPLATE, rewriteArguments, withRewriteService };
