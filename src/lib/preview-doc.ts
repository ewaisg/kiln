export function toPreviewDocument(code: string, lang: string): string | null {
  const name = lang.toLowerCase().trim();
  const trimmed = code.trim();
  if (!trimmed) return null;
  if (name === "html" || name === "svg" || /<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
    if (/<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) return trimmed;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${trimmed}</body></html>`;
  }
  if (name === "javascript" || name === "js" || name === "jsx") {
    const safe = trimmed.replace(/<\/script/gi, "<\\/script");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#0e0f12;color:#eceff4;font:15px/1.5 ui-monospace,monospace}pre{margin:0;padding:16px;white-space:pre-wrap}</style></head><body><pre id="out"></pre><script>
const out=document.getElementById("out");
function log(v){let s;try{s=typeof v==="string"?v:JSON.stringify(v,null,2)}catch(e){s=String(v)}out.textContent+=s+"\\n"}
["log","info","warn","error"].forEach(function(k){console[k]=function(){log(Array.from(arguments).map(function(x){return typeof x==="string"?x:JSON.stringify(x)}).join(" "))}});
window.addEventListener("error",function(e){log(e.message)});
try{${safe}
}catch(e){log(e&&e.stack||String(e))}
</script></body></html>`;
  }
  return null;
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}
