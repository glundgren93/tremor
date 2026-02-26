import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadMarkdown, generateMarkdown } from "./generateMarkdown";
import type { Report } from "./types";

function urlTransform(url: string): string {
  if (url.startsWith("data:image/")) return url;
  return defaultUrlTransform(url);
}

export function ReportPreview({
  report,
  onBack,
}: {
  report: Report;
  onBack: () => void;
}) {
  const md = generateMarkdown(report);

  return (
    <div className="min-h-[calc(100vh-65px)] p-6">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-1.5 text-xs font-semibold text-text transition-colors hover:border-accent"
          onClick={onBack}
        >
          &larr; Back
        </button>
        <h2 className="min-w-0 flex-1 text-lg font-semibold">
          Report Preview
        </h2>
        <button
          className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-1.5 text-xs font-semibold text-text transition-colors hover:border-accent"
          onClick={() => downloadMarkdown(report)}
        >
          Download .md
        </button>
      </div>
      <div className="markdown-body mx-auto max-w-[900px] text-[15px] leading-relaxed text-text">
        <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform}>{md}</Markdown>
      </div>
    </div>
  );
}
