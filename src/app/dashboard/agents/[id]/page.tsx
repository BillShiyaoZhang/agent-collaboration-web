"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowLeft, Copy, Trash2, UserPlus, Edit3, Check, RefreshCw, X, Download, AlertTriangle, MessageCircle, Key, ShieldCheck, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime, truncateUrn } from "@/lib/utils";
import Link from "next/link";

interface Agent {
  id: string;
  name: string;
  urn: string;
  publicKey: string;
  localUrl: string | null;
  encryptedPrivateKey: string | null;
  platformRegistered: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  contacts: Contact[];
  _count: {
    messages: number;
    hitlRequests: number;
    transactions: number;
  };
}

interface Contact {
  id: string;
  contactUrn: string;
  trustTier: string;
  alias: string | null;
  createdAt: string;
}

interface ConsoleMessage {
  id: string;
  content: string;
  isIncoming: boolean;
  createdAt: string;
}

async function responseError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null);
  return typeof data?.error === "string" ? data.error : `${fallback} (${response.status})`;
}

export default function AgentDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  
  const [agent, setAgent] = useState<Agent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Local URLs are configuration only; browser access cannot prove helper health.
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [editingUrl, setEditingUrl] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSavingUrl, setIsSavingUrl] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Console / Cloud Control states
  const [activeTab, setActiveTab] = useState("contacts");
  const [virtualUrn, setVirtualUrn] = useState<string | null>(null);
  const [virtualEd25519PublicKey, setVirtualEd25519PublicKey] = useState<string | null>(null);
  const [virtualX25519PublicKey, setVirtualX25519PublicKey] = useState<string | null>(null);
  const [isBindingOwner, setIsBindingOwner] = useState(false);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [consoleInput, setConsoleInput] = useState("");
  const [consoleMessages, setConsoleMessages] = useState<ConsoleMessage[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [isSendingConsole, setIsSendingConsole] = useState(false);
  const messagePollInFlight = useRef(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [consoleMessages]);

  const fetchAgent = useCallback(async () => {
    try {
      const response = await fetch(`/api/agents/${id}`);
      if (response.ok) {
        const data = await response.json();
        setAgent(data);
        setEditingUrl(data.localUrl || "");
      } else if (response.status === 404) {
        router.push("/dashboard/agents");
      }
    } catch (error) {
      console.error("Failed to fetch agent:", error);
    } finally {
      setIsLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    void fetchAgent();
  }, [fetchAgent]);

  const fetchOwnerIdentity = useCallback(async (method: "GET" | "POST" = "GET", signal?: AbortSignal) => {
    setIsBindingOwner(true);
    setOwnerError(null);
    try {
      const response = await fetch(`/api/agents/${id}/bind-owner`, {
        method,
        signal,
      });
      if (!response.ok) {
        throw new Error(await responseError(response, "Failed to load console identity"));
      }
      const data = await response.json();
      if (signal?.aborted) return;
      setVirtualUrn(data.virtualUrn);
      setVirtualEd25519PublicKey(data.virtualEd25519PublicKey);
      setVirtualX25519PublicKey(data.virtualX25519PublicKey);
    } catch (error) {
      if (!signal?.aborted) {
        setOwnerError(error instanceof Error ? error.message : "Failed to load console identity");
      }
    } finally {
      if (!signal?.aborted) setIsBindingOwner(false);
    }
  }, [id]);

  const agentId = agent?.id;
  const agentUrn = agent?.urn;
  const fetchConsoleMessages = useCallback(async (signal?: AbortSignal) => {
    if (!agentId || !agentUrn || messagePollInFlight.current) return;
    messagePollInFlight.current = true;
    try {
      const response = await fetch(
        `/api/messages?agentId=${agentId}&contactUrn=${encodeURIComponent(agentUrn)}`,
        { signal }
      );
      if (!response.ok) {
        throw new Error(await responseError(response, "Failed to receive messages"));
      }
      const data = await response.json();
      if (signal?.aborted) return;
      if (!Array.isArray(data)) throw new Error("Invalid message response");
      setConsoleMessages(data);
      setPollError(null);
    } catch (error) {
      if (!signal?.aborted) {
        setPollError(error instanceof Error ? error.message : "Failed to receive messages");
      }
    } finally {
      messagePollInFlight.current = false;
    }
  }, [agentId, agentUrn]);

  useEffect(() => {
    if (activeTab !== "control" || !agentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    void fetchOwnerIdentity("GET", controller.signal);
    const poll = async () => {
      await fetchConsoleMessages(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeTab, agentId, fetchOwnerIdentity, fetchConsoleMessages]);

  const handleSendConsole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consoleInput.trim() || !agent || !virtualUrn || !agent.platformRegistered || isSendingConsole) return;

    setIsSendingConsole(true);
    setSendError(null);
    setSendStatus(null);
    const content = consoleInput;

    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          recipientUrn: agent.urn,
          content,
        }),
      });

      if (response.ok) {
        setConsoleInput("");
        setSendStatus("Message accepted by the platform.");
        await fetchConsoleMessages();
      } else {
        throw new Error(await responseError(response, "Failed to send message"));
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setIsSendingConsole(false);
    }
  };

  const handleSaveUrl = async () => {
    if (!agent) return;
    setIsSavingUrl(true);
    try {
      const response = await fetch(`/api/agents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localUrl: editingUrl }),
      });
      if (response.ok) {
        const updatedAgent = await response.json();
        setAgent((prev) => prev ? { ...prev, localUrl: updatedAgent.localUrl } : null);
        setIsEditingUrl(false);
      }
    } catch (error) {
      console.error("Failed to save local URL:", error);
    } finally {
      setIsSavingUrl(false);
    }
  };

  const handleSyncStatus = async () => {
    if (!agent) return;
    setIsSyncing(true);
    try {
      const response = await fetch(`/api/agents/${id}/register`, {
        method: "POST",
      });
      if (response.ok) {
        const updatedAgent = await response.json();
        setAgent((prev) => prev ? { 
          ...prev, 
          platformRegistered: updatedAgent.platformRegistered,
          publicKey: updatedAgent.publicKey 
        } : null);
      } else {
        const data = await response.json();
        alert(data.error || "Failed to sync platform registry status");
      }
    } catch (error) {
      console.error("Failed to sync status:", error);
    } finally {
      setIsSyncing(false);
    }
  };

  const downloadConfig = () => {
    if (!agent) return;
    const config = {
      urn: agent.urn,
      public_key: agent.publicKey,
      private_key: agent.encryptedPrivateKey,
      local_url: agent.localUrl || "http://localhost:45042",
      platform_url: typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(config, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `${agent.name.toLowerCase().replace(/\s+/g, "_")}_config.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this agent? This cannot be undone.")) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/agents/${id}`, {
        method: "DELETE",
      });

      if (response.ok) {
        router.push("/dashboard/agents");
      }
    } catch (error) {
      console.error("Failed to delete agent:", error);
      setIsDeleting(false);
    }
  };

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">Loading agent...</div>
      </div>
    );
  }

  if (!agent) {
    return null;
  }

  const isBoundOnly = agent.encryptedPrivateKey === null;
  const hasOwnerIdentity = Boolean(virtualUrn && virtualEd25519PublicKey && virtualX25519PublicKey);
  const canSendConsole = hasOwnerIdentity && agent.platformRegistered;
  const ownerContact = JSON.stringify({
    contact_urn: virtualUrn,
    alias: "Owner (Cloud Console)",
    trust_tier: "self",
    ed25519_public_key: virtualEd25519PublicKey,
    x25519_public_key: virtualX25519PublicKey,
  }, null, 2);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/agents">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={agent.platformRegistered ? "success" : "warning"}>
              {agent.platformRegistered ? "Platform Registered" : "Platform Unregistered"}
            </Badge>
            <span className="text-sm text-muted-foreground">
              Created {formatDateTime(agent.createdAt)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!agent.platformRegistered && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncStatus}
              disabled={isSyncing}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
              Sync Status
            </Button>
          )}
          {!isBoundOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={downloadConfig}
            >
              <Download className="mr-2 h-4 w-4" />
              Download Config
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>

      {!agent.platformRegistered && (
        <Card className="border-yellow-200 bg-yellow-50/50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
            <div className="text-sm text-yellow-800 space-y-1">
              <p className="font-semibold">Agent not registered on the platform</p>
              <p>
                To enable routing, make sure your agent program is running locally with these credentials and connects to the central platform registry. Once connected, click <strong>Sync Status</strong> above.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Agent Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-bold text-muted-foreground uppercase">
                URN
              </label>
              <div className="flex items-center gap-2 mt-1">
                <code className="text-xs bg-muted px-2 py-1.5 rounded flex-1 truncate font-mono">
                  {agent.urn}
                </code>
                <Button variant="outline" size="sm" onClick={() => handleCopy(agent.urn, "urn")}>
                  {copiedField === "urn" ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-muted-foreground uppercase">
                Public Key
              </label>
              <div className="flex items-center gap-2 mt-1">
                <code className="text-xs bg-muted px-2 py-1.5 rounded flex-1 truncate font-mono">
                  {agent.publicKey || "Not resolved yet (check platform status)"}
                </code>
                {agent.publicKey && (
                  <Button variant="outline" size="sm" onClick={() => handleCopy(agent.publicKey, "pub")}>
                    {copiedField === "pub" ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                  </Button>
                )}
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-muted-foreground uppercase">
                Agent Local URL
              </label>
              <div className="space-y-2 mt-1">
                {isEditingUrl ? (
                  <div className="flex gap-2">
                    <Input
                      value={editingUrl}
                      onChange={(e) => setEditingUrl(e.target.value)}
                      placeholder="http://localhost:45042"
                      className="text-xs font-mono"
                    />
                    <Button size="sm" onClick={handleSaveUrl} disabled={isSavingUrl}>
                      {isSavingUrl ? "Saving..." : <Check className="h-4 w-4" />}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => {
                      setIsEditingUrl(false);
                      setEditingUrl(agent.localUrl || "");
                    }}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-muted px-2 py-1.5 rounded flex-1 truncate font-mono">
                      {agent.localUrl || "No URL configured"}
                    </code>
                    <Button variant="outline" size="sm" onClick={() => setIsEditingUrl(true)}>
                      <Edit3 className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  Used for setup on the agent&apos;s computer. Messages travel through the platform;
                  this page cannot verify whether the local helper or Hermes is running.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Statistics</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold">{agent._count.messages}</div>
              <div className="text-xs text-muted-foreground">Messages</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">{agent._count.hitlRequests}</div>
              <div className="text-xs text-muted-foreground">HITL Requests</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">
                {agent._count.transactions}
              </div>
              <div className="text-xs text-muted-foreground">Transactions</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="flex items-center justify-between border-b pb-2">
          <TabsList className="border-b-0">
            <TabsTrigger value="contacts">
              Contacts ({agent.contacts.length})
            </TabsTrigger>
            <TabsTrigger value="control">
              <MessageCircle className="mr-1.5 h-4 w-4" />
              Cloud Control
            </TabsTrigger>
          </TabsList>
          {activeTab === "contacts" && (
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/agents/contacts">
                <UserPlus className="mr-2 h-4 w-4" />
                Manage Contacts
              </Link>
            </Button>
          )}
        </div>

        <TabsContent value="contacts" className="mt-4">
          {agent.contacts.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-8">
                <p className="text-muted-foreground mb-4">No contacts yet</p>
                <Button asChild variant="outline">
                  <Link href="/dashboard/agents/contacts">
                    <UserPlus className="mr-2 h-4 w-4" />
                    Manage Contacts
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="divide-y">
                  {agent.contacts.map((contact) => (
                    <div
                      key={contact.id}
                      className="flex items-center justify-between p-4"
                    >
                      <div>
                        <div className="font-medium">
                          {contact.alias || truncateUrn(contact.contactUrn)}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {contact.contactUrn}
                        </div>
                      </div>
                      <Badge variant="outline">{contact.trustTier}</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="control" className="mt-4 space-y-6">
          <div className="grid gap-6 md:grid-cols-3">
            {/* Public console identity for local configuration */}
            <Card className="md:col-span-1 min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-md">
                  <Key className="h-4 w-4 text-primary" />
                  Console Identity
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <p className="text-xs text-muted-foreground">
                  This is your web account&apos;s messaging identity. Configure it on the
                  agent&apos;s computer to allow messages and enable replies.
                </p>
                {[
                  { label: "Console Owner URN", value: virtualUrn, field: "owner-urn" },
                  { label: "Ed25519 Public Key", value: virtualEd25519PublicKey, field: "owner-ed25519" },
                  { label: "X25519 Public Key", value: virtualX25519PublicKey, field: "owner-x25519" },
                ].map(({ label, value, field }) => (
                  <div key={field}>
                    <label className="text-xs font-bold text-muted-foreground uppercase">{label}</label>
                    <div className="flex items-start gap-2 mt-1">
                      <code className="min-w-0 flex-1 break-all whitespace-pre-wrap font-mono text-xs bg-muted p-2 rounded select-all">
                        {value || "Not initialized"}
                      </code>
                      {value && (
                        <Button variant="outline" size="sm" aria-label={`Copy ${label}`} onClick={() => handleCopy(value, field)}>
                          {copiedField === field ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {ownerError && <p role="alert" className="text-xs text-destructive break-words">{ownerError}</p>}
                {!hasOwnerIdentity && (
                  <Button
                    onClick={() => void fetchOwnerIdentity("POST")}
                    disabled={isBindingOwner}
                    className="w-full text-xs"
                  >
                    <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isBindingOwner ? "animate-spin" : ""}`} />
                    {isBindingOwner ? "Loading Identity..." : "Initialize Console Identity"}
                  </Button>
                )}
                {hasOwnerIdentity && (
                  <details className="rounded-lg border p-3 text-xs space-y-3">
                    <summary className="cursor-pointer font-medium">Configure Hermes on your computer</summary>
                    <ol className="list-decimal pl-4 space-y-2 text-muted-foreground">
                      <li>Send the contact JSON below to your local helper&apos;s <code>/contacts</code> endpoint from a terminal.</li>
                      <li>Add the Console Owner URN to <code>platforms.agent_comm.extra.allow_from</code> in the active Hermes profile, then restart Gateway.</li>
                    </ol>
                    <p className="text-muted-foreground">
                      The contact supplies keys for replies. Hermes separately checks permission
                      to process incoming messages. This page cannot confirm local authorization.
                    </p>
                    <pre className="whitespace-pre-wrap break-all bg-muted p-2 rounded">{ownerContact}</pre>
                    <Button variant="outline" size="sm" className="w-full" onClick={() => handleCopy(ownerContact, "owner-contact")}>
                      {copiedField === "owner-contact" ? <Check className="mr-2 h-3.5 w-3.5" /> : <Copy className="mr-2 h-3.5 w-3.5" />}
                      Copy Contact JSON
                    </Button>
                  </details>
                )}
              </CardContent>
            </Card>

            {/* Chat Console Card */}
            <Card className="md:col-span-2 min-w-0 flex flex-col h-[480px] overflow-hidden shadow-lg">
              {/* Chat Header */}
              <div className="px-5 py-3.5 border-b bg-gradient-to-r from-white to-gray-50/80 dark:from-zinc-900 dark:to-zinc-800/80 flex flex-wrap gap-3 items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="h-9 w-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-sm shadow-md">
                      🤖
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold leading-tight">{agent.name}</h3>
                    <p className="text-[11px] text-muted-foreground font-mono truncate max-w-[200px]">
                      {truncateUrn(agent.urn)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={agent.platformRegistered ? "outline" : "warning"} className="text-[10px] px-2 py-0.5">
                    {agent.platformRegistered ? "Platform Registered" : "Registration Required"}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] px-2 py-0.5 gap-1">
                    <ShieldCheck className="h-3 w-3" />
                    E2E Encrypted
                  </Badge>
                </div>
              </div>

              {/* Chat Messages Area */}
              <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-4 bg-gray-50/50 dark:bg-zinc-900/50">
                {/* Empty state */}
                {consoleMessages.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full text-center gap-2 opacity-60">
                    <MessageCircle className="h-10 w-10 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No messages yet</p>
                    <p className="text-xs text-muted-foreground/70">Messages are end-to-end encrypted via ECIES X25519</p>
                  </div>
                )}

                {consoleMessages.map((msg) => {
                  const isUser = !msg.isIncoming;
                  const msgTime = new Date(msg.createdAt);
                  const timeStr = msgTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  return (
                    <div
                      key={msg.id}
                      className={`flex items-end gap-2 ${
                        isUser ? "justify-end" : "justify-start"
                      }`}
                    >
                      {/* Agent avatar */}
                      {!isUser && (
                        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 dark:from-zinc-700 dark:to-zinc-600 flex items-center justify-center text-xs shrink-0 shadow-sm">
                          🤖
                        </div>
                      )}

                      {/* Message bubble */}
                      <div className={`max-w-[75%] group ${
                        isUser ? "items-end" : "items-start"
                      }`}>
                        <div
                          className={`px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words shadow-sm ${
                            isUser
                              ? "bg-gradient-to-br from-indigo-500 to-indigo-600 text-white rounded-2xl rounded-br-sm"
                              : "bg-white dark:bg-zinc-800 text-foreground rounded-2xl rounded-bl-sm border border-gray-100 dark:border-zinc-700"
                          }`}
                        >
                          {msg.content}
                        </div>
                        <p className={`text-[10px] text-muted-foreground/60 mt-1 px-1 ${
                          isUser ? "text-right" : "text-left"
                        }`}>
                          {timeStr}
                        </p>
                      </div>

                      {/* User avatar */}
                      {isUser && (
                        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-xs text-white shrink-0 shadow-sm">
                          👤
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Request status, not an assertion that Hermes is typing. */}
                {isSendingConsole && (
                  <p role="status" className="text-xs text-muted-foreground">Sending to the platform...</p>
                )}

                <div ref={terminalEndRef} />
              </div>

              {(sendError || pollError) && (
                <div role="alert" className="border-t bg-destructive/5 px-4 py-2 text-xs text-destructive break-words">
                  {sendError && <p>Send failed: {sendError}</p>}
                  {pollError && <p>Replies could not be refreshed: {pollError}. Retrying automatically.</p>}
                </div>
              )}
              {sendStatus && !sendError && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">{sendStatus}</p>}
              {!canSendConsole && (
                <p className="px-4 py-2 text-xs text-muted-foreground">
                  {!hasOwnerIdentity ? "Initialize your console identity to send messages." : "Sync the agent's platform registration to send messages."}
                </p>
              )}
              {/* Chat Input Area */}
              <form onSubmit={handleSendConsole} className="border-t bg-white dark:bg-zinc-900 p-3 flex items-center gap-2">
                <Input
                  value={consoleInput}
                  onChange={(e) => setConsoleInput(e.target.value)}
                  placeholder="发送消息..."
                  className="flex-1 h-10 rounded-full border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 px-4 text-sm placeholder:text-muted-foreground/50 focus-visible:ring-indigo-500/30 focus-visible:ring-offset-0 transition-colors"
                  disabled={!canSendConsole || isSendingConsole}
                />
                <Button
                  type="submit"
                  size="icon"
                  className="h-10 w-10 rounded-full bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white shadow-md hover:shadow-lg transition-all duration-200 disabled:opacity-40 disabled:shadow-none shrink-0"
                  disabled={!canSendConsole || !consoleInput.trim() || isSendingConsole}
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
