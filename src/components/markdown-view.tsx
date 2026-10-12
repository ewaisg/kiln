import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { copyText, downloadText, toPreviewDocument } from "@/lib/preview-doc";
import { highlightCode } from "@/lib/highlight";

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
            onClick={() =>
              downloadText(`${label || "snippet"}.${EXT[lang.toLowerCase()] || "txt"}`, code)
            }
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
        <code dangerouslySetInnerHTML={{ __html: highlightCode(code) }} />
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
  return (
    <div className="prose min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, node }) => {
            const lang = /language-([\w#+.-]+)/.exec(className ?? "")?.[1] ?? "";
            const code = String(children).replace(/\n$/, "");
            const block =
              Boolean(className) || node?.position?.start.line !== node?.position?.end.line;
            return block ? (
              <Fence lang={lang} code={code} onPreview={onPreview} />
            ) : (
              <code className="rounded-sm bg-subtle px-1 font-mono text-sm">{children}</code>
            );
          },
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            src?.startsWith("https://") ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || "Open external image"}
              </a>
            ) : (
              <span>{alt}</span>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
