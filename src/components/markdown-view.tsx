import { useState, type ReactNode } from "react";
import { copyText, downloadText, toPreviewDocument } from "@/lib/preview-doc";

type Piece = { type: "text"; text: string } | { type: "code"; lang: string; code: string };

function splitFences(source: string): Piece[] {
  const parts = source.split("```");
  const pieces: Piece[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part) pieces.push({ type: "text", text: part });
      return;
    }
    const breakAt = part.indexOf("\n");
    if (breakAt === -1) {
      const token = part.trim();
      const lang = /^[\w#+.-]+$/.test(token) ? token : "";
      pieces.push({ type: "code", lang, code: lang ? "" : part });
      return;
    }
    const lang = part.slice(0, breakAt).trim();
    pieces.push({ type: "code", lang, code: part.slice(breakAt + 1).replace(/\n$/, "") });
  });
  return pieces;
}

function Inline({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded-sm bg-subtle px-1 font-mono text-sm">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-medium">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const label = token.slice(1, token.indexOf("]"));
      const href = token.slice(token.indexOf("(") + 1, -1);
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2">
          {label}
        </a>,
      );
    }
    last = match.index + token.length;
    key += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

function Prose({ text }: { text: string }) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={key} className="my-2">
        <Inline text={paragraph.join("\n")} />
      </p>,
    );
    key += 1;
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={key} className="my-2 list-disc space-y-1 pl-5">
        {list.map((item, index) => (
          <li key={index}>
            <Inline text={item} />
          </li>
        ))}
      </ul>,
    );
    key += 1;
    list = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line) || /^\d+\.\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(
        <h2 key={key} className="mb-1 mt-4 text-lg font-medium tracking-tight">
          <Inline text={heading[2] ?? ""} />
        </h2>,
      );
      key += 1;
      continue;
    }
    if (item) {
      flushParagraph();
      list.push(item[1] ?? "");
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return <>{blocks}</>;
}

const EXT: Record<string, string> = {
  html: "html",
  svg: "svg",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  py: "py",
  python: "py",
  css: "css",
  json: "json",
  sql: "sql",
  md: "md",
  rs: "rs",
  go: "go",
  sh: "sh",
  bash: "sh",
};

function Fence({
  lang,
  code,
  onPreview,
}: {
  lang: string;
  code: string;
  onPreview: (html: string, title: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const preview = toPreviewDocument(code, lang);
  const label = lang || "code";
  return (
    <div className="my-3 overflow-hidden rounded-md border border-line bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-xs text-faint">{label}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {preview ? (
            <button
              type="button"
              className="press h-11 rounded-md bg-subtle px-3 text-sm font-medium"
              onClick={() => onPreview(preview, label)}
            >
              Preview
            </button>
          ) : null}
          <button
            type="button"
            className="press h-11 rounded-md bg-subtle px-3 text-sm font-medium"
            onClick={() => downloadText(`${label || "snippet"}.${EXT[lang.toLowerCase()] || "txt"}`, code)}
          >
            Save
          </button>
          <button
            type="button"
            className="press h-11 rounded-md bg-subtle px-3 text-sm font-medium"
            onClick={() => {
              void copyText(code).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-sm leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({
  text,
  onPreview,
}: {
  text: string;
  onPreview: (html: string, title: string) => void;
}) {
  const pieces = splitFences(text);
  return (
    <div className="min-w-0">
      {pieces.map((piece, index) =>
        piece.type === "code" ? (
          <Fence key={index} lang={piece.lang} code={piece.code} onPreview={onPreview} />
        ) : (
          <Prose key={index} text={piece.text} />
        ),
      )}
    </div>
  );
}
