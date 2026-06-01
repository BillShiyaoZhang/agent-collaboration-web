"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowLeft, Copy, Trash2, UserPlus, Globe, Edit3, Check, RefreshCw, X, Download, AlertTriangle, Terminal, Key, ShieldCheck, ShieldAlert, Send } from "lucide-react";
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

export default function AgentDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  
  const [agent, setAgent] = useState<Agent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Connectivity and Edit States
  const [localConnected, setLocalConnected] = useState<"checking" | "connected" | "failed" | "unset">("unset");
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
  const [consoleInput, setConsoleInput] = useState("");
  const [consoleMessages, setConsoleMessages] = useState<any[]>([]);
  const [isSendingConsole, setIsSendingConsole] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAgent();
  }, [id]);

  useEffect(() => {
    if (agent) {
      checkLocalConnectivity(agent.localUrl);
      setEditingUrl(agent.localUrl || "");
    }
  }, [agent?.id]);

  useEffect(() => {
    if (activeTab === "control") {
      fetchConsoleMessages();
      fetchOwnerIdentity();
      const interval = setInterval(fetchConsoleMessages, 3000);
      return () => clearInterval(interval);
    }
  }, [activeTab, agent?.id]);

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [consoleMessages]);

  const fetchAgent = async () => {
    try {
      const response = await fetch(`/api/agents/${id}`);
      if (response.ok) {
        const data = await response.json();
        setAgent(data);
      } else if (response.status === 404) {
        router.push("/dashboard/agents");
      }
    } catch (error) {
      console.error("Failed to fetch agent:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchOwnerIdentity = async () => {
    try {
      const response = await fetch(`/api/agents/${id}/bind-owner`, {
        method: "POST"
      });
      if (response.ok) {
        const data = await response.json();
        setVirtualUrn(data.virtualUrn);
        setVirtualEd25519PublicKey(data.virtualEd25519PublicKey);
        setVirtualX25519PublicKey(data.virtualX25519PublicKey);
      }
    } catch (error) {
      console.error("Failed to fetch owner identity:", error);
    }
  };

  const fetchConsoleMessages = async () => {
    if (!agent) return;
    try {
      const response = await fetch(
        `/api/messages?agentId=${agent.id}&contactUrn=${encodeURIComponent(agent.urn)}`
      );
      if (response.ok) {
        const data = await response.json();
        setConsoleMessages(data);
      }
    } catch (error) {
      console.error("Failed to fetch console messages:", error);
    }
  };

  const handleSendConsole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consoleInput.trim() || !agent || isSendingConsole) return;

    setIsSendingConsole(true);
    const content = consoleInput;
    setConsoleInput("");

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
        fetchConsoleMessages();
      } else {
        const errData = await response.json();
        alert(errData.error || "Failed to send command");
      }
    } catch (error) {
      console.error("Failed to send command:", error);
    } finally {
      setIsSendingConsole(false);
    }
  };

  const handleEstablishTrust = async () => {
    if (!agent) return;
    setIsBindingOwner(true);
    try {
      // 1. Fetch/generate console identity
      const identityRes = await fetch(`/api/agents/${id}/bind-owner`, {
        method: "POST",
      });
      if (!identityRes.ok) {
        throw new Error("Failed to retrieve console virtual identity");
      }
      const identity = await identityRes.json();
      const ownerUrn = identity.virtualUrn;
      const ownerEdPubKey = identity.virtualEd25519PublicKey;
      const ownerXPubKey = identity.virtualX25519PublicKey;

      // 2. Call localhost /contacts of local agent via CORS
      const localContactsUrl = agent.localUrl?.endsWith("/")
        ? `${agent.localUrl}contacts`
        : `${agent.localUrl}/contacts`;

      const localRes = await fetch(localContactsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_urn: ownerUrn,
          alias: "Owner (Cloud Console)",
          trust_tier: "self",
          ed25519_public_key: ownerEdPubKey,
          x25519_public_key: ownerXPubKey,
        }),
      });

      if (!localRes.ok) {
        throw new Error(`Failed to push contact to local agent: ${localRes.statusText}`);
      }

      // 3. Register contact in cloud database
      const cloudRes = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          contactUrn: ownerUrn,
          trustTier: "self",
          alias: "Owner (Cloud Console)",
          publicKey: ownerEdPubKey,
        }),
      });

      if (cloudRes.ok) {
        alert("Successfully established mutual trust and bound virtual owner!");
        fetchAgent(); // reload contacts to update UI
      } else {
        const cloudErr = await cloudRes.json();
        alert(`Trust pushed to local agent, but failed to sync to cloud console database: ${cloudErr.error}`);
      }
    } catch (err: any) {
      console.error(err);
      alert(`Trust provisioning failed: ${err.message}`);
    } finally {
      setIsBindingOwner(false);
    }
  };

  const checkLocalConnectivity = async (url: string | null) => {
    if (!url) {
      setLocalConnected("unset");
      return;
    }
    setLocalConnected("checking");
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout

      await fetch(url, {
        method: "GET",
        mode: "no-cors",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      setLocalConnected("connected");
    } catch (err) {
      console.warn("Ping failed:", err);
      setLocalConnected("failed");
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
        checkLocalConnectivity(updatedAgent.localUrl);
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
      local_url: agent.localUrl || "http://localhost:8000",
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
  const isOwnerTrusted = agent.contacts.some(c => c.contactUrn === virtualUrn && c.trustTier === "self");

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
                Agent Local URL & Connection
              </label>
              <div className="space-y-2 mt-1">
                {isEditingUrl ? (
                  <div className="flex gap-2">
                    <Input
                      value={editingUrl}
                      onChange={(e) => setEditingUrl(e.target.value)}
                      placeholder="http://localhost:8000"
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

                {agent.localUrl && (
                  <div className="flex items-center justify-between text-xs bg-muted/40 p-2.5 rounded-lg border">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${
                        localConnected === "connected" ? "bg-green-500 animate-pulse" :
                        localConnected === "failed" ? "bg-red-500" :
                        localConnected === "checking" ? "bg-yellow-500 animate-spin" :
                        "bg-gray-400"
                      }`} />
                      <span className="font-medium text-muted-foreground">
                        {localConnected === "connected" && "Local Agent Reachable"}
                        {localConnected === "failed" && "Local Agent Offline"}
                        {localConnected === "checking" && "Pinging Agent..."}
                        {localConnected === "unset" && "Not Checked"}
                      </span>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => checkLocalConnectivity(agent.localUrl)}>
                      Test Connection
                    </Button>
                  </div>
                )}
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
              <Terminal className="mr-1.5 h-4 w-4" />
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
            {/* Mutual Trust Status card */}
            <Card className="md:col-span-1">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-md">
                  <Key className="h-4 w-4 text-primary" />
                  Mutual Trust Provisioning
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div>
                  <label className="text-xs font-bold text-muted-foreground uppercase">Console Owner URN</label>
                  <div className="mt-1 font-mono text-xs bg-muted p-2 rounded truncate select-all">
                    {virtualUrn || "Not Generated Yet"}
                  </div>
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/20 text-xs">
                  <div className="flex items-center gap-2">
                    {isOwnerTrusted ? (
                      <>
                        <ShieldCheck className="h-4.5 w-4.5 text-green-600 shrink-0" />
                        <span className="font-medium text-green-800">Trust Provisioned (&quot;self&quot;)</span>
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="h-4.5 w-4.5 text-yellow-600 shrink-0" />
                        <span className="font-medium text-yellow-800 font-semibold">Trust Not Configured</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="pt-2">
                  <Button
                    onClick={handleEstablishTrust}
                    disabled={isBindingOwner || localConnected !== "connected"}
                    className="w-full text-xs"
                    variant={isOwnerTrusted ? "outline" : "default"}
                  >
                    <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isBindingOwner ? "animate-spin" : ""}`} />
                    {isOwnerTrusted ? "Re-provision Trust" : "Establish Mutual Trust"}
                  </Button>
                  {localConnected !== "connected" && (
                    <p className="text-[10px] text-red-500 mt-1 text-center">
                      * Trust additions require Local Agent URL to be online.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Terminal Console Card */}
            <Card className="md:col-span-2 flex flex-col h-[400px]">
              <CardHeader className="py-3.5 border-b flex flex-row items-center justify-between">
                <CardTitle className="text-md flex items-center gap-2">
                  <Terminal className="h-4 w-4" />
                  Interactive Console Shell
                </CardTitle>
                <Badge variant={localConnected === "connected" ? "success" : "destructive"}>
                  {localConnected === "connected" ? "Agent Reachable" : "Agent Offline"}
                </Badge>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col p-0 overflow-hidden bg-zinc-950 font-mono text-zinc-300 text-xs">
                <div className="flex-1 p-4 overflow-y-auto space-y-3.5 min-h-0">
                  <div className="text-zinc-500">
                    {"// Welcome to the Agent-Comm Control Terminal."}<br />
                    {"// Commands are end-to-end encrypted via ECIES X25519."}<br />
                    {"// Supported commands: ping, stats, help"}
                  </div>

                  {consoleMessages.map((msg) => (
                    <div key={msg.id} className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className={msg.isIncoming ? "text-blue-400" : "text-emerald-400 font-bold"}>
                          {msg.isIncoming ? "◀ [AGENT]" : "▶ [OWNER]"}
                        </span>
                        <span className="text-[10px] text-zinc-600">
                          {formatDateTime(msg.createdAt)}
                        </span>
                      </div>
                      <div className="pl-4 whitespace-pre-wrap select-text selection:bg-zinc-700">
                        {msg.content}
                      </div>
                    </div>
                  ))}
                  <div ref={terminalEndRef} />
                </div>

                <form onSubmit={handleSendConsole} className="border-t border-zinc-800 p-2 bg-zinc-900/50 flex gap-2">
                  <Input
                    value={consoleInput}
                    onChange={(e) => setConsoleInput(e.target.value)}
                    placeholder={isOwnerTrusted ? "Type 'stats' or 'ping' and press Enter..." : "Establish mutual trust above to unlock control console."}
                    className="flex-1 h-9 bg-zinc-950 border-zinc-800 focus:border-zinc-700 text-zinc-100 placeholder:text-zinc-600 rounded text-xs"
                    disabled={!isOwnerTrusted || isSendingConsole}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    className="h-9 px-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                    disabled={!isOwnerTrusted || !consoleInput.trim() || isSendingConsole}
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}