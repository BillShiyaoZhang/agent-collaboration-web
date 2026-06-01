"use client";

import { useState, useEffect } from "react";
import { Plus, Globe, Link as LinkIcon, RefreshCw, Key, Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate } from "@/lib/utils";
import { useRouter } from "next/navigation";

interface Agent {
  id: string;
  name: string;
  urn: string;
  localUrl: string | null;
  encryptedPrivateKey: string | null;
  platformRegistered: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"bind" | "create">("bind");
  
  // Form fields
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentPassword, setNewAgentPassword] = useState("");
  const [bindUrn, setBindUrn] = useState("");
  const [bindLocalUrl, setBindLocalUrl] = useState("http://localhost:8000");
  const [bindPublicKey, setBindPublicKey] = useState("");
  
  // Status states
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");
  const [createdAgent, setCreatedAgent] = useState<any | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectionError, setDetectionError] = useState("");

  useEffect(() => {
    fetchAgents();
  }, []);

  const fetchAgents = async () => {
    try {
      const response = await fetch("/api/agents");
      if (response.ok) {
        const data = await response.json();
        setAgents(data);
      }
    } catch (error) {
      console.error("Failed to fetch agents:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAutoDetect = async () => {
    if (!bindLocalUrl) {
      setDetectionError("Please enter a local endpoint URL first");
      return;
    }
    setIsDetecting(true);
    setDetectionError("");
    setError("");
    try {
      const url = bindLocalUrl.endsWith("/") ? `${bindLocalUrl}info` : `${bindLocalUrl}/info`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout

      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const data = await response.json();
      if (!data.urn) {
        throw new Error("Invalid response format: missing URN");
      }

      setBindUrn(data.urn);
      if (data.ed25519_public_key) {
        setBindPublicKey(data.ed25519_public_key);
      }
      if (!newAgentName) {
        setNewAgentName("Local Agent (" + data.urn.substring(data.urn.length - 6) + ")");
      }
    } catch (err) {
      console.warn("Local agent detection failed:", err);
      setDetectionError("Detection failed. Make sure the local agent is running and listening.");
    } finally {
      setIsDetecting(false);
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsCreating(true);

    try {
      const payload = activeTab === "bind" 
        ? {
            mode: "bind",
            name: newAgentName,
            urn: bindUrn,
            localUrl: bindLocalUrl,
            publicKey: bindPublicKey
          }
        : {
            mode: "create",
            name: newAgentName,
            password: newAgentPassword,
            localUrl: bindLocalUrl
          };

      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to save agent");
      }

      const agent = await response.json();
      setAgents([agent, ...agents]);
      
      if (activeTab === "create") {
        setCreatedAgent(agent);
      } else {
        setIsDialogOpen(false);
        resetForm();
        router.push(`/dashboard/agents/${agent.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save agent");
    } finally {
      setIsCreating(false);
    }
  };

  const handleRegisterOrSyncAgent = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    setSyncingId(agentId);
    try {
      const response = await fetch(`/api/agents/${agentId}/register`, {
        method: "POST",
      });

      if (response.ok) {
        fetchAgents();
      } else {
        const data = await response.json();
        alert(data.error || "Failed to sync agent platform status");
      }
    } catch (error) {
      console.error("Failed to sync agent:", error);
    } finally {
      setSyncingId(null);
    }
  };

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const downloadConfig = (agent: any) => {
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

  const resetForm = () => {
    setNewAgentName("");
    setNewAgentPassword("");
    setBindUrn("");
    setBindLocalUrl("http://localhost:8000");
    setBindPublicKey("");
    setCreatedAgent(null);
    setError("");
    setDetectionError("");
    setIsDetecting(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground">
            Manage and bind your local running agents
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) resetForm();
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add / Bind Agent
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[480px]">
            {createdAgent ? (
              <div className="space-y-4 py-2">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Check className="h-5 w-5 text-green-500" />
                    Agent Created Successfully!
                  </DialogTitle>
                  <DialogDescription>
                    Download configuration or copy credentials to configure and run your local agent program.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 pt-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Agent URN</Label>
                    <div className="flex gap-2">
                      <Input readOnly value={createdAgent.urn} className="font-mono text-xs" />
                      <Button variant="outline" size="sm" onClick={() => handleCopy(createdAgent.urn, "urn")}>
                        {copiedField === "urn" ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Public Key</Label>
                    <div className="flex gap-2">
                      <Input readOnly value={createdAgent.publicKey} className="font-mono text-xs" />
                      <Button variant="outline" size="sm" onClick={() => handleCopy(createdAgent.publicKey, "pub")}>
                        {copiedField === "pub" ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Private Key (Hex)</Label>
                    <div className="flex gap-2">
                      <Input readOnly type="password" value={createdAgent.encryptedPrivateKey || ""} className="font-mono text-xs" />
                      <Button variant="outline" size="sm" onClick={() => handleCopy(createdAgent.encryptedPrivateKey || "", "priv")}>
                        {copiedField === "priv" ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <span className="text-[10px] text-yellow-600 font-medium">
                      ⚠️ Warning: This private key is not saved plaintext on our servers and cannot be shown again.
                    </span>
                  </div>
                </div>

                <div className="bg-muted rounded-lg p-3 mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-xs font-semibold flex items-center gap-1">
                      <Key className="h-3 w-3" /> Local Env Configuration
                    </Label>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => handleCopy(
                      `AGENT_URN=${createdAgent.urn}\nAGENT_PRIVATE_KEY=${createdAgent.encryptedPrivateKey}\nAGENT_PLATFORM_URL=${window.location.origin}`,
                      "env"
                    )}>
                      {copiedField === "env" ? "Copied" : "Copy Env"}
                    </Button>
                  </div>
                  <pre className="text-[10px] font-mono leading-tight bg-background border rounded p-2 overflow-x-auto">
{`AGENT_URN=${createdAgent.urn}
AGENT_PRIVATE_KEY=${createdAgent.encryptedPrivateKey}
AGENT_PLATFORM_URL=http://localhost:8080`}
                  </pre>
                </div>

                <div className="flex gap-2 justify-end pt-4">
                  <Button variant="outline" className="flex-1" onClick={() => downloadConfig(createdAgent)}>
                    <Download className="mr-2 h-4 w-4" /> Download Config
                  </Button>
                  <Button className="flex-1" onClick={() => {
                    setIsDialogOpen(false);
                    resetForm();
                    router.push(`/dashboard/agents/${createdAgent.id}`);
                  }}>
                    Go to Agent Detail
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateAgent}>
                <DialogHeader>
                  <DialogTitle>Add / Bind Agent</DialogTitle>
                  <DialogDescription>
                    Link an existing agent or generate credentials for a new local agent.
                  </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="bind" onValueChange={(val) => setActiveTab(val as "bind" | "create")} className="py-4">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="bind">Bind Local Agent</TabsTrigger>
                    <TabsTrigger value="create">Generate Credentials</TabsTrigger>
                  </TabsList>

                  {error && (
                    <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md mt-4">
                      {error}
                    </div>
                  )}

                  <TabsContent value="bind" className="space-y-4 pt-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Agent Friendly Name</Label>
                      <Input
                        id="name"
                        value={newAgentName}
                        onChange={(e) => setNewAgentName(e.target.value)}
                        placeholder="My Local Agent"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="urn">Agent URN</Label>
                      <Input
                        id="urn"
                        value={bindUrn}
                        onChange={(e) => setBindUrn(e.target.value)}
                        placeholder="urn:agent:..."
                        required
                      />
                      <p className="text-[11px] text-muted-foreground">
                        The URN of your agent registered on the platform.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="localUrl">Local Endpoint URL</Label>
                      <div className="flex gap-2">
                        <Input
                          id="localUrl"
                          value={bindLocalUrl}
                          onChange={(e) => setBindLocalUrl(e.target.value)}
                          placeholder="http://localhost:8000"
                          className="flex-1"
                        />
                        <Button 
                          type="button" 
                          variant="secondary" 
                          size="sm"
                          onClick={handleAutoDetect} 
                          disabled={isDetecting}
                          className="shrink-0"
                        >
                          {isDetecting ? "Detecting..." : "Auto-detect"}
                        </Button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        The HTTP URL where the agent runs on your computer.
                      </p>
                      {detectionError && (
                        <p className="text-[11px] text-destructive font-medium">
                          ⚠️ {detectionError}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="publicKey">Public Key (Optional)</Label>
                      <Input
                        id="publicKey"
                        value={bindPublicKey}
                        onChange={(e) => setBindPublicKey(e.target.value)}
                        placeholder="Hex-encoded Ed25519 public key"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Optional. If left blank, we will try to resolve it from the registry.
                      </p>
                    </div>
                  </TabsContent>

                  <TabsContent value="create" className="space-y-4 pt-4">
                    <div className="space-y-2">
                      <Label htmlFor="name-gen">Agent Name</Label>
                      <Input
                        id="name-gen"
                        value={newAgentName}
                        onChange={(e) => setNewAgentName(e.target.value)}
                        placeholder="My New Agent"
                        required={activeTab === "create"}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="localUrl-gen">Local Endpoint URL (Optional)</Label>
                      <Input
                        id="localUrl-gen"
                        value={bindLocalUrl}
                        onChange={(e) => setBindLocalUrl(e.target.value)}
                        placeholder="http://localhost:8000"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="password">Encryption Password</Label>
                      <Input
                        id="password"
                        type="password"
                        value={newAgentPassword}
                        onChange={(e) => setNewAgentPassword(e.target.value)}
                        placeholder="Min 8 characters"
                        required={activeTab === "create"}
                        minLength={8}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Used locally to derive encryption keys. Min 8 characters.
                      </p>
                    </div>
                  </TabsContent>
                </Tabs>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isCreating}>
                    {isCreating ? "Adding..." : activeTab === "bind" ? "Bind Agent" : "Generate Credentials"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">
          Loading agents...
        </div>
      ) : agents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No agents bound yet</p>
            <Button onClick={() => setIsDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Bind your first agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Card
              key={agent.id}
              className="cursor-pointer hover:border-primary transition-colors flex flex-col justify-between"
              onClick={() => router.push(`/dashboard/agents/${agent.id}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-lg font-bold truncate flex-1">{agent.name}</CardTitle>
                  <Badge variant={agent.platformRegistered ? "success" : "warning"} className="shrink-0">
                    {agent.platformRegistered ? "Registered" : "Unregistered"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col justify-between pt-2">
                <div>
                  <p className="text-xs text-muted-foreground font-mono truncate mb-2" title={agent.urn}>
                    {agent.urn}
                  </p>
                  {agent.localUrl && (
                    <p className="text-xs flex items-center gap-1 text-muted-foreground mb-2">
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="truncate">{agent.localUrl}</span>
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Created {formatDate(agent.createdAt)}
                  </p>
                </div>
                
                {!agent.platformRegistered && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 w-full"
                    disabled={syncingId === agent.id}
                    onClick={(e) => handleRegisterOrSyncAgent(e, agent.id)}
                  >
                    <RefreshCw className={`mr-2 h-3.5 w-3.5 ${syncingId === agent.id ? "animate-spin" : ""}`} />
                    {agent.encryptedPrivateKey === null ? "Sync Platform Status" : "Register on Platform"}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}