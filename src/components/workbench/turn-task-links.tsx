"use client";

import Link from "next/link";
import { record, records, string, type RemoteRecord } from "@/lib/control/workbench-client";

export function TurnTaskLinks({ turn, state, agentId }: { turn: RemoteRecord; state: RemoteRecord; agentId: string }) {
  const mentions = [...new Set(records(turn.mentions).filter(item => item.kind === "task").map(item => string(item.task_id)).filter(Boolean))];
  const related = [...new Set(records(turn.related).map(item => string(item.task_id, item.kind === "task" ? string(item.id) : "")).filter(Boolean))];
  if (!mentions.length && !related.length) return null;
  const title = (id: string) => {
    const task = records(state.tasks).find(item => item.task_id === id);
    return string(record(task?.scope).topic, id);
  };
  const links = (ids: string[]) => ids.map(id => <Link key={id} className="inline-flex max-w-full rounded-full border bg-card px-2 py-0.5 text-primary underline underline-offset-2" href={`/dashboard/agents/${encodeURIComponent(agentId)}?tab=tasks&subject=${encodeURIComponent(id)}`}>@{title(id)}</Link>);
  return <div className="mt-1 space-y-1 text-right text-xs text-muted-foreground">
    {!!mentions.length && <div className="flex flex-wrap items-center justify-end gap-1"><span>{["failed", "interrupted"].includes(string(turn.status)) ? "本次请求拟提及" : "提及上下文"}</span>{links(mentions)}</div>}
    {!!related.length && <div className="flex flex-wrap items-center justify-end gap-1"><span>实际工作来源</span>{links(related)}</div>}
  </div>;
}
