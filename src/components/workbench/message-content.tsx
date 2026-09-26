"use client";
import { Fragment, type ReactNode } from "react";
export function safeMessageHref(value: string): string | null {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.9em]">{part.slice(1,-1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2,-2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) { const href = safeMessageHref(link[2]); return href ? <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">{link[1]}</a> : <Fragment key={i}>{part}</Fragment>; }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
// React escapes every text node; model text never supplies HTML or executable URLs.
export function MessageContent({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g,"\n").split("\n"), blocks: ReactNode[] = [];
  for (let i=0;i<lines.length;) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const language = line.slice(3).trim(); const code: string[] = []; i++;
      while(i<lines.length && !lines[i].startsWith("```")) code.push(lines[i++]); if (i<lines.length) i++;
      blocks.push(<div key={i} className="min-w-0 overflow-hidden rounded-lg border">{language && <p className="border-b px-3 py-1 text-xs text-muted-foreground">{language}</p>}<pre className="max-w-full overflow-x-auto p-3 text-xs leading-6"><code>{code.join("\n")}</code></pre></div>); continue;
    }
    if (line.includes("|") && i+1<lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i+1])) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g,"").split("|").map(value=>value.trim());
      const header=cells(line), rows:string[][]=[]; i+=2; while(i<lines.length&&lines[i].includes("|")) rows.push(cells(lines[i++]));
      blocks.push(<div key={i} className="overflow-x-auto"><table className="w-full border-collapse text-left text-xs"><thead><tr>{header.map((value,k)=><th key={k} className="border p-2">{inline(value)}</th>)}</tr></thead><tbody>{rows.map((row,j)=><tr key={j}>{row.map((value,k)=><td key={k} className="border p-2 align-top">{inline(value)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const list = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (list) {
      const ordered=/\d/.test(list[1]), entries:string[]=[]; while(i<lines.length) { const entry=/^\s*([-*]|\d+\.)\s+(.+)$/.exec(lines[i]);if(!entry || /\d/.test(entry[1])!==ordered) break; entries.push(entry[2]);i++; }
      const items=entries.map((value,j)=><li key={j}>{inline(value)}</li>);
      blocks.push(ordered?<ol key={i} className="ml-5 list-decimal space-y-1">{items}</ol>:<ul key={i} className="ml-5 list-disc space-y-1">{items}</ul>); continue;
    }
    const heading=/^#{1,6}\s+(.+)$/.exec(line);
    blocks.push(line ? <p key={i} className={heading ? "font-semibold" : "whitespace-pre-wrap"}>{inline(heading?heading[1]:line)}</p>:<div key={i} className="h-2" />);i++;
  }
  return <div className="min-w-0 space-y-2 break-words">{blocks}</div>;
}
