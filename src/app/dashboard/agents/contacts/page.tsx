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
  const [newContact, setNewContact] = useState({
    agentId: "",
    contactUrn: "",
    trustTier: "stranger",
    alias: "",
  });
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchContacts();
  }, []);

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
        agentId: "",
        contactUrn: "",
        trustTier: "stranger",
        alias: "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create contact");
    } finally {
      setIsCreating(false);
    }
  };

  const getTrustTierBadgeVariant = (tier: string) => {
    switch (tier) {
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
                  <Label htmlFor="contactUrn">Contact URN</Label>
                  <Input
                    id="contactUrn"
                    value={newContact.contactUrn}
                    onChange={(e) =>
                      setNewContact({ ...newContact, contactUrn: e.target.value })
                    }
                    placeholder="urn:agent:..."
                    required
                  />
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