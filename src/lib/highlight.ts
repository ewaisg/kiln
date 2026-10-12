const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|def|elif|None|True|False|SELECT|FROM|WHERE|AND|OR|INSERT|UPDATE|CREATE|TABLE|fn|pub|struct|impl|package|func)\b/g;

export function highlightCode(code: string): string {
  const escaped = code.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
  const marked = escaped
    .replace(/(\/\/[^\n]*|#[^\n]*)/g, "\u0000c$1\u0000")
    .replace(/("(?:\\.|[^&])*?"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, "\u0000s$1\u0000")
    .replace(KEYWORDS, "\u0000k$1\u0000");
  return marked
    .replace(/\u0000c([\s\S]*?)\u0000/g, '<span class="tok-c">$1</span>')
    .replace(/\u0000s([\s\S]*?)\u0000/g, '<span class="tok-s">$1</span>')
    .replace(/\u0000k([\s\S]*?)\u0000/g, '<span class="tok-k">$1</span>');
}
