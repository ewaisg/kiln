const TOKEN = /(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|def|elif|None|True|False|SELECT|FROM|WHERE|AND|OR|INSERT|UPDATE|CREATE|TABLE|fn|pub|struct|impl|package|func)\b)/g;
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** Tokenize before escaping; never interpret model-generated code as HTML. */
export function highlightCode(code: string): string {
  let output = "", start = 0;
  for (const match of code.matchAll(TOKEN)) {
    output += escape(code.slice(start, match.index));
    const token = match[0];
    const kind = token.startsWith("//") || token.startsWith("#") ? "c" : /^["']/.test(token) ? "s" : "k";
    output += `<span class="tok-${kind}">${escape(token)}</span>`;
    start = match.index + token.length;
  }
  return output + escape(code.slice(start));
}
