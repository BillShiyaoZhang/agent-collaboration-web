"use client";

import { useState, useEffect } from "react";
import { UserPlus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";
import { truncateUrn } from "@/lib/utils";

interface Contact {
  id: string;
  contactUrn: string;
  trustTier: string;
  alias: string | null;
  createdAt: string;
  agent: {
    id: string;
    name: string;
    urn: string;
  };
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [myAgents, setMyAgents] = useState<any[]>([]);
  const [newContact, setNewContact] = useState({
    agentId: "",
    contactUrn: "",
    trustTier: "stranger",
    alias: "",
    publicKey: "",
  });
  const [isCreating, setIsCreating] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveSuccess, setResolveSuccess] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetchContacts();
    fetchAgents();
  }, []);

  const fetchAgents = async () => {
    try {
      const response = await fetch("/api/agents");
      if (response.ok) {
        const data = await response.json();
        setMyAgents(data);
        if (data.length > 0) {
          setNewContact(prev => ({ ...prev, agentId: data[0].id }));
        }
      }
    } catch (error) {
      console.error("Failed to fetch agents:", error);
    }
  };

  const handleResolveUrn = async () => {
    if (!newContact.contactUrn) {
      setError("Please enter a contact URN first");
      return;
    }
    setResolving(true);
    setError("");
    setResolveSuccess("");
    try {
      const response = await fetch(`/api/agents/discover?q=${encodeURIComponent(newContact.contactUrn)}`);
      if (!response.ok) {
        throw new Error("Failed to resolve URN from platform");
      }
      const data = await response.json();
      if (data && data.length > 0) {
        const agentData = data[0];
        // Convert ed25519_pubkey from base64 to hex
        let pubKeyHex = "";
        if (agentData.ed25519_pubkey) {
          const raw = window.atob(agentData.ed25519_pubkey);
          pubKeyHex = Array.from(raw).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
        }
        setNewContact(prev => ({
          ...prev,
          alias: prev.alias || ("Agent (" + agentData.urn.substring(agentData.urn.length - 6) + ")"),
          publicKey: pubKeyHex,
        }));
        setResolveSuccess(`Resolved: Peer ID is ${agentData.peer_id}`);
      } else {
        throw new Error("URN not found on platform registry");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve URN from platform");
    } finally {
      setResolving(false);
    }
  };

  const fetchContacts = async () => {
    try {
      const response = await fetch("/api/contacts");
      if (response.ok) {
        const data = await response.json();
        setContacts(data);
      }
    } catch (error) {
      console.error("Failed to fetch contacts:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateContact = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setResolveSuccess("");
    setIsCreating(true);

    try {
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newContact),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create contact");
      }

      const contact = await response.json();
      setContacts([contact, ...contacts]);
      setIsDialogOpen(false);
      setNewContact({
        agentId: myAgents.length > 0 ? myAgents[0].id : "",
        contactUrn: "",
        trustTier: "stranger",
        alias: "",
        publicKey: "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create contact");
    } finally {
      setIsCreating(false);
    }
  };

  const getTrustTierBadgeVariant = (tier: string) => {
    switch (tier) {
      case "self":
        return "destructive";
      case "family":
        return "success";
      case "friend":
        return "default";
      default:
        return "secondary";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Contacts</h1>
          <p className="text-muted-foreground">
            Manage your agent contacts and trust levels
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlus className="mr-2 h-4 w-4" />
              Add Contact
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreateContact}>
              <DialogHeader>
                <DialogTitle>Add New Contact</DialogTitle>
                <DialogDescription>
                  Add a trusted agent to your contact list
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {error && (
                  <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
                    {error}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="agentId">Save under your Local Agent (Owner)</Label>
                  <Select
                    value={newContact.agentId}
                    onValueChange={(value) =>
                      setNewContact({ ...newContact, agentId: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select one of your local agents" />
                    </SelectTrigger>
                    <SelectContent>
                      {myAgents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name} ({truncateUrn(a.urn)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">
                    Specifies which of your own local agents will communicate with this contact.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactUrn">Contact URN</Label>
                  <div className="flex gap-2">
                    <Input
                      id="contactUrn"
                      value={newContact.contactUrn}
                      onChange={(e) =>
                        setNewContact({ ...newContact, contactUrn: e.target.value })
                      }
                      placeholder="urn:hermes:agent:..."
                      className="flex-1"
                      required
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleResolveUrn}
                      disabled={resolving}
                      className="shrink-0"
                    >
                      {resolving ? "Resolving..." : "Resolve"}
                    </Button>
                  </div>
                  {resolveSuccess && (
                    <p className="text-[11px] text-green-600 font-medium">
                      ✅ {resolveSuccess}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trustTier">Trust Tier</Label>
                  <Select
                    value={newContact.trustTier}
                    onValueChange={(value) =>
                      setNewContact({ ...newContact, trustTier: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="self">Me (Self-control)</SelectItem>
                      <SelectItem value="family">Family</SelectItem>
                      <SelectItem value="friend">Friend</SelectItem>
                      <SelectItem value="stranger">Stranger</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="alias">Alias (Optional)</Label>
                  <Input
                    id="alias"
                    value={newContact.alias}
                    onChange={(e) =>
                      setNewContact({ ...newContact, alias: e.target.value })
                    }
                    placeholder="My Friend Agent"
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
                  {isCreating ? "Adding..." : "Add Contact"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search contacts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">
          Loading contacts...
        </div>
      ) : contacts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No contacts yet</p>
            <Button onClick={() => setIsDialogOpen(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              Add your first contact
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {contacts
            .filter(
              (contact) =>
                contact.alias?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                contact.contactUrn.toLowerCase().includes(searchQuery.toLowerCase())
            )
            .map((contact) => (
              <Card key={contact.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <span className="text-sm font-medium text-primary">
                        {contact.alias?.[0] || contact.contactUrn[0]}
                      </span>
                    </div>
                    <div>
                      <div className="font-medium">
                        {contact.alias || truncateUrn(contact.contactUrn)}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {contact.contactUrn}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <Badge variant={getTrustTierBadgeVariant(contact.trustTier)}>
                      {contact.trustTier}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(contact.createdAt)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}