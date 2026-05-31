"use client";

import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
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
import { formatDate } from "@/lib/utils";
import { useRouter } from "next/navigation";

interface Agent {
  id: string;
  name: string;
  urn: string;
  platformRegistered: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentPassword, setNewAgentPassword] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");

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

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsCreating(true);

    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newAgentName,
          password: newAgentPassword,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create agent");
      }

      const agent = await response.json();
      setAgents([agent, ...agents]);
      setIsDialogOpen(false);
      setNewAgentName("");
      setNewAgentPassword("");
      router.push(`/dashboard/agents/${agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setIsCreating(false);
    }
  };

  const handleRegisterAgent = async (agentId: string) => {
    try {
      const response = await fetch(`/api/agents/${agentId}/register`, {
        method: "POST",
      });

      if (response.ok) {
        fetchAgents();
      }
    } catch (error) {
      console.error("Failed to register agent:", error);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground">
            Manage your agents and their configurations
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Agent
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreateAgent}>
              <DialogHeader>
                <DialogTitle>Create New Agent</DialogTitle>
                <DialogDescription>
                  Create a new agent to collaborate with others
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {error && (
                  <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
                    {error}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="name">Agent Name</Label>
                  <Input
                    id="name"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    placeholder="My Agent"
                    required
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
                    minLength={8}
                    required
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isCreating}>
                  {isCreating ? "Creating..." : "Create Agent"}
                </Button>
              </DialogFooter>
            </form>
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
            <p className="text-muted-foreground mb-4">No agents yet</p>
            <Button onClick={() => setIsDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create your first agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Card
              key={agent.id}
              className="cursor-pointer hover:border-primary transition-colors"
              onClick={() => router.push(`/dashboard/agents/${agent.id}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{agent.name}</CardTitle>
                  <Badge variant={agent.platformRegistered ? "success" : "warning"}>
                    {agent.platformRegistered ? "Registered" : "Unregistered"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground font-mono truncate mb-2">
                  {agent.urn}
                </p>
                <p className="text-xs text-muted-foreground">
                  Created {formatDate(agent.createdAt)}
                </p>
                {!agent.platformRegistered && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 w-full"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRegisterAgent(agent.id);
                    }}
                  >
                    Register on Platform
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