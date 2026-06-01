"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowLeft, Copy, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/utils";
import { truncateUrn } from "@/lib/utils";
import Link from "next/link";

interface Agent {
  id: string;
  name: string;
  urn: string;
  publicKey: string;
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

  useEffect(() => {
    fetchAgent();
  }, [id]);

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

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this agent?")) return;

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

  const handleCopyUrn = () => {
    if (agent) {
      navigator.clipboard.writeText(agent.urn);
    }
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
              {agent.platformRegistered ? "Registered" : "Unregistered"}
            </Badge>
            <span className="text-sm text-muted-foreground">
              Created {formatDateTime(agent.createdAt)}
            </span>
          </div>
        </div>
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

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Agent Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                URN
              </label>
              <div className="flex items-center gap-2 mt-1">
                <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate">
                  {agent.urn}
                </code>
                <Button variant="ghost" size="icon" onClick={handleCopyUrn}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Public Key
              </label>
              <code className="text-xs bg-muted px-2 py-1 rounded block mt-1 truncate">
                {agent.publicKey}
              </code>
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

      <Tabs defaultValue="contacts">
        <TabsList>
          <TabsTrigger value="contacts">
            Contacts ({agent.contacts.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="contacts" className="mt-4">
          {agent.contacts.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-8">
                <p className="text-muted-foreground mb-4">No contacts yet</p>
                <Button>
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add Contact
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
      </Tabs>
    </div>
  );
}