"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, ChevronDown, Clock3, Loader2, Plus, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/shared/utils";
import { displayTime, string } from "@/lib/control/workbench-client";
import { CopyValue, RawSnapshot, StatusBadge } from "./snapshot-views";
import { RequestFeedback } from "./pairing-panel";
import type { Workbench } from "./use-workbench";

export function ConversationPanel({ workbench: w, agentName }: { workbench: Workbench; agentName: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newResult, setNewResult] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const earlierScroll = useRef<{ height: number; top: number } | null>(null);
  const last = w.turns[w.turns.length - 1];
  const transcriptVersion = `${w.conversationId}:${w.turns.length}:${string(last?.status)}:${string(last?.response).length}:${w.submission?.phase || ""}`;
  useEffect(() => {
    if (!transcript.current) return;
    if (earlierScroll.current) { transcript.current.scrollTop = earlierScroll.current.top + transcript.current.scrollHeight - earlierScroll.current.height; if (!w.loadingEarlier) earlierScroll.current = null; return; }
    if (nearBottom.current) { transcript.current.scrollTop = transcript.current.scrollHeight; setNewResult(false); }
    else setNewResult(true);
  }, [transcriptVersion, w.loadingEarlier]);
  useEffect(() => {
    const element = w.composer.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [w.text, w.composer]);
  const send = () => { nearBottom.current = true; void w.sendMessage(); };
  const changingConversation = !!w.submission || w.selectingConversation || !!w.busy["conversation.send"];
  const hasFeedback = w.busy["conversation.get"] || w.errors["conversation.get"] || w.errors["conversation.send"] || w.conversationError || w.submission?.phase === "uncertain";

  return <div role="tabpanel" id="panel-conversation" aria-labelledby="tab-conversation">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3"><div><p className="text-sm font-medium">与 {agentName} 对话</p><p role="status" className="mt-1 text-xs text-muted-foreground">{w.watching ? "正在自动同步回合进展" : w.conversationId ? "会话已保存在账号中 · 自动同步" : "从一句话开始，把事情交给 agent"}</p></div><div className="flex items-center gap-1">
      {w.conversationId && w.canReadConversation && <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" title="刷新对话" aria-label="刷新对话" disabled={!!w.busy["conversation.get"]} onClick={() => void w.readConversation()}><RefreshCw className={cn("h-4 w-4", w.busy["conversation.get"] && "animate-spin")} /></Button>}
      <Button variant="ghost" size="sm" className="gap-1.5 rounded-lg text-xs" disabled={changingConversation} onClick={() => { w.newConversation(); setSettingsOpen(false); nearBottom.current = true; }}><Plus className="h-3.5 w-3.5" />新对话</Button>
      <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" title="对话设置" aria-label="对话设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(previous => !previous)}><Settings2 className="h-4 w-4" /></Button>
    </div></div>

    {!!w.conversations.length && <div className="flex flex-wrap items-center gap-3 border-b bg-muted/15 px-5 py-3"><label htmlFor="saved-conversation" className="shrink-0 text-xs text-muted-foreground">历史对话</label><select id="saved-conversation" aria-label="选择历史对话" value={w.conversationId} disabled={changingConversation} onChange={event => { nearBottom.current = true; void w.selectConversation(event.target.value); }} className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"><option value="">新对话</option>{w.conversationId && !w.conversations.some(conversation => conversation.id === w.conversationId) && <option value={w.conversationId}>当前对话</option>}{w.conversations.map(conversation => <option key={conversation.id} value={conversation.id}>{conversation.title || "未命名对话"}{conversation.pending ? " · 处理中" : ""} · {displayTime(conversation.updatedAt / 1000)}</option>)}</select></div>}
    {settingsOpen && <div className="border-b bg-muted/25 px-5 py-4"><label htmlFor="conversation-id" className="text-xs font-medium">打开已有对话</label><div className="mt-2 flex items-center gap-2"><Input id="conversation-id" value={w.conversationInput} maxLength={128} placeholder="输入对话 ID" className="min-w-0 rounded-xl bg-card font-mono text-base md:text-xs" disabled={changingConversation} onChange={event => w.setConversationInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && w.canReadConversation && !changingConversation) void w.readConversation(w.conversationInput.trim()); }} />{w.canReadConversation && <Button variant="outline" className="rounded-xl" disabled={!w.conversationInput.trim() || changingConversation} onClick={() => void w.readConversation(w.conversationInput.trim())}>打开</Button>}{w.conversationId && <CopyValue value={w.conversationId} label="复制对话 ID" compact />}</div><p className="mt-2 text-xs text-muted-foreground">会话会自动保存。也可以用对话 ID 找回尚未同步到账号的记录。</p></div>}

    <div className="relative"><div ref={transcript} onScroll={event => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; if (nearBottom.current) setNewResult(false); }} className="h-[clamp(12rem,calc(100dvh-40rem),30rem)] space-y-6 overflow-y-auto overscroll-contain px-5 py-4 sm:px-7 sm:py-6" aria-label="对话记录">
      {w.hasEarlierTurns && <div className="text-center"><Button variant="ghost" size="sm" disabled={w.loadingEarlier} className="rounded-xl text-xs" onClick={() => { const element = transcript.current; if (element) earlierScroll.current = { height: element.scrollHeight, top: element.scrollTop }; void w.loadEarlier(); }}>{w.loadingEarlier ? "正在读取…" : "加载更早的记录"}</Button></div>}
      {!w.turns.length && !w.submission && <div className="flex min-h-full flex-col items-center justify-center py-2 text-center"><span className="mb-3 rounded-[18px] bg-primary/10 p-3"><Bot className="h-6 w-6 text-primary" strokeWidth={1.5} /></span><h2 className="text-lg font-medium tracking-tight sm:text-xl">{w.conversationId ? w.currentSnapshot?.conversation_id === w.conversationId ? "这个对话暂时没有回合" : "正在打开这个对话" : "有什么想一起推进的？"}</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{w.conversationId ? w.currentSnapshot?.conversation_id === w.conversationId ? "新回合会自动同步到这里。" : "已安排后台同步，保存的对话记录会自动显示。" : "告诉 agent 你的想法、问题，或下一件要做的事。"}</p>{w.canSend && !w.conversationId && <div className="mt-4 flex flex-wrap justify-center gap-2">{["帮我梳理今天的待办", "看看协作事项的进展", "我们可以一起做什么？"].map(prompt => <button key={prompt} type="button" className="rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground transition-colors [&:not(:first-child)]:hidden sm:[&:not(:first-child)]:inline-flex hover:border-primary/30 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { w.setText(prompt); w.composer.current?.focus(); }}>{prompt}</button>)}</div>}</div>}
      {w.turns.map((turn, index) => <div key={string(turn.turn_id, String(index))} className="space-y-4"><div className="ml-auto w-fit max-w-[88%] sm:max-w-[80%]"><p className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-7 text-primary-foreground">{string(turn.text)}</p><div className="mt-2 flex items-center justify-end gap-2"><span className="text-[10px] text-muted-foreground">{displayTime(turn.created_at)}</span><StatusBadge value={turn.status} /></div></div><div className="flex items-start gap-2.5"><span className="mt-1 rounded-xl bg-muted p-2"><Bot className="h-4 w-4 text-primary" /></span><div className="min-w-0 max-w-[88%]">
        {turn.status === "completed" ? <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tl-md bg-muted/55 px-4 py-3 text-sm leading-7">{string(turn.response) || "Agent 已结束本回合，未返回文本内容。"}</div> : ["failed", "interrupted"].includes(string(turn.status)) ? <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800"><p>{turn.status === "interrupted" ? turn.locally_unconfirmed === true ? "这条消息的处理结果尚未确认，请先核实后再安排后续操作。" : "处理曾中断，请先核实执行结果。" : "这个回合未能完成。"}</p>{!!turn.error && <p className="mt-1 break-words text-xs">{string(turn.error)}</p>}</div> : <div className="flex items-center gap-2 rounded-2xl bg-muted/55 px-4 py-3 text-sm text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{turn.status === "running" ? "Agent 正在处理这一回合…" : turn.status === "submitted" ? "Agent 已受理，等待开始处理…" : "Agent 返回了新的回合状态，请查看原始快照。"}</div>}
      </div></div></div>)}
      {w.submission && <div className="ml-auto w-fit max-w-[88%] sm:max-w-[80%]"><p className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/10 px-4 py-3 text-sm leading-7">{w.submission.text}</p><p className="mt-2 flex items-center justify-end gap-1.5 text-xs text-muted-foreground">{w.submission.phase === "sending" && <Loader2 className="h-3 w-3 animate-spin" />}{w.submission.phase === "sending" ? "正在等待受理回执" : "发送结果尚未确认"}</p></div>}
    </div>{newResult && <Button variant="secondary" size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md" onClick={() => { if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; nearBottom.current = true; setNewResult(false); }}>查看最新进展 <ChevronDown className="ml-1 h-4 w-4" /></Button>}</div>

    {hasFeedback && <div className="space-y-3 border-t px-5 py-3">
      <RequestFeedback busy={w.busy["conversation.get"]} error={w.errors["conversation.get"]} onRetry={() => void w.readConversation()} />
      {w.errors["conversation.send"] && !w.submission && <RequestFeedback error={w.errors["conversation.send"]} />}
      {w.submission?.phase === "uncertain" && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-6 text-amber-900"><p>{w.errors["conversation.send"]?.message || "尚不能确认 agent 是否已受理这条消息。"}</p><div className="mt-2 flex flex-wrap gap-2">{w.submission.retryable && <Button variant="outline" size="sm" className="h-8 rounded-lg text-xs" disabled={!!w.busy["conversation.send"]} onClick={() => void w.sendMessage(w.submission!)}>重试同一请求</Button>}{w.canReadConversation && <Button variant="outline" size="sm" className="h-8 rounded-lg text-xs" disabled={!!w.busy["conversation.get"]} onClick={w.inspectSubmission}>读取对话核实</Button>}{!w.submission.retryable && <Button variant="outline" size="sm" className="h-8 rounded-lg text-xs" disabled={w.dismissingSubmission} onClick={() => void w.dismissSubmission()}>{w.dismissingSubmission ? "正在保存…" : "保留记录并继续"}</Button>}<CopyValue value={w.submission.conversationId} label="复制对话 ID" /></div><p className="mt-1 text-[11px]">这条消息可能已经被处理，请先查看结果，不要直接重复发送。</p></div>}
      {w.conversationError && <p role="alert" className="text-xs leading-6 text-destructive">{w.conversationError}</p>}
    </div>}

    {w.canSend ? <div className="border-t bg-muted/15 p-4 sm:p-5"><div className="rounded-2xl border bg-card p-3 shadow-sm transition-shadow focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10"><Textarea ref={w.composer} aria-label="给 agent 的消息" maxLength={8000} value={w.text} disabled={!!w.submission} onChange={event => { w.setText(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } }} placeholder="告诉 agent 你想做什么…" className="min-h-20 resize-none rounded-none border-0 bg-transparent p-1 text-base md:text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60" /><div className="mt-2 flex items-center justify-between gap-3"><p className="text-[11px] text-muted-foreground"><span className="hidden sm:inline">Ctrl / ⌘ + Enter 发送</span><span className="sm:hidden">换行可继续输入</span>{w.text.length > 7000 && <span className="ml-2">{w.text.length} / 8000</span>}</p><Button aria-label="发送消息" disabled={!w.text.trim() || !!w.submission || w.selectingConversation || !!w.busy["conversation.send"]} onClick={send} className="h-9 gap-1.5 rounded-xl px-3">{w.busy["conversation.send"] ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}发送</Button></div></div><p className="mt-3 px-1 text-[11px] leading-5 text-muted-foreground">{w.canReadConversation ? "受理后会自动保存并同步处理结果，离开页面后也会继续。需要你确认的协作操作，请在 agent 原生渠道回应。" : "当前 agent 仅开放发送能力。受理后，请在 agent 本机查看处理结果。"}</p></div> : <div className="border-t px-5 py-4 text-xs leading-6 text-muted-foreground">当前配对仅支持读取对话。可以打开历史对话，或在设置中输入对话 ID。</div>}
    {w.currentSnapshot?.conversation_id === w.conversationId && <RawSnapshot data={w.currentSnapshot} />}
  </div>;
}





