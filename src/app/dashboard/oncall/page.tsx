"use client";

import { useState, useEffect } from "react";
import { Phone, Search, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  alias: string | null;
  trustTier: string;
}

interface Service {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  requiresHitl: boolean;
  exposure: string;
}

export default function OnCallPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [serviceArgs, setServiceArgs] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isCalling, setIsCalling] = useState(false);

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

  const fetchServices = async (targetUrn: string) => {
    try {
      const response = await fetch(
        `/api/oncall?targetUrn=${encodeURIComponent(targetUrn)}`
      );
      if (response.ok) {
        const data = await response.json();
        setServices(data);
      }
    } catch (error) {
      console.error("Failed to fetch services:", error);
    }
  };

  const handleSelectContact = (contact: Contact) => {
    setSelectedContact(contact);
    setSelectedService(null);
    fetchServices(contact.contactUrn);
  };

  const handleCallService = async () => {
    if (!selectedContact || !selectedService) return;

    setIsCalling(true);
    try {
      const args = serviceArgs ? JSON.parse(serviceArgs) : {};
      const response = await fetch("/api/oncall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedContact.id,
          targetUrn: selectedContact.contactUrn,
          serviceName: selectedService.name,
          args,
        }),
      });

      if (response.ok) {
        setIsDialogOpen(false);
        setServiceArgs("");
        setSelectedService(null);
        // Redirect to HITL page to approve the request
        window.location.href = "/dashboard/hitl";
      }
    } catch (error) {
      console.error("Failed to call service:", error);
    } finally {
      setIsCalling(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Services</h1>
        <p className="text-muted-foreground">
          Discover and invoke services from your contacts
        </p>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">
          Loading contacts...
        </div>
      ) : contacts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Phone className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              No contacts yet. Add contacts to discover their services.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Contacts List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Select a Contact</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {contacts.map((contact) => (
                  <button
                    key={contact.id}
                    onClick={() => handleSelectContact(contact)}
                    className={`w-full flex items-center justify-between p-4 text-left transition-colors ${
                      selectedContact?.id === contact.id
                        ? "bg-primary/10"
                        : "hover:bg-muted"
                    }`}
                  >
                    <div>
                      <div className="font-medium">
                        {contact.alias || truncateUrn(contact.contactUrn)}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {truncateUrn(contact.contactUrn, 30)}
                      </div>
                    </div>
                    <Badge variant="outline">{contact.trustTier}</Badge>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Services List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {selectedContact
                  ? `Services from ${
                      selectedContact.alias ||
                      truncateUrn(selectedContact.contactUrn)
                    }`
                  : "Services"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!selectedContact ? (
                <p className="text-center text-muted-foreground py-8">
                  Select a contact to view their services
                </p>
              ) : services.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No services available from this contact
                </p>
              ) : (
                <div className="space-y-3">
                  {services.map((service) => (
                    <Dialog
                      key={service.name}
                      open={isDialogOpen && selectedService?.name === service.name}
                      onOpenChange={(open) => {
                        setIsDialogOpen(open);
                        if (open) setSelectedService(service);
                        else setSelectedService(null);
                      }}
                    >
                      <DialogTrigger asChild>
                        <button className="w-full flex items-center justify-between p-4 rounded-lg border hover:bg-muted transition-colors text-left">
                          <div>
                            <div className="font-medium flex items-center gap-2">
                              {service.name}
                              {service.requiresHitl && (
                                <Badge variant="warning" className="text-xs">
                                  HITL
                                </Badge>
                              )}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {service.description}
                            </div>
                          </div>
                          <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>{service.name}</DialogTitle>
                          <DialogDescription>
                            {service.description}
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                          <div className="bg-muted rounded-lg p-3 text-xs">
                            <div className="font-medium mb-2">Input Schema:</div>
                            <pre className="overflow-auto">
                              {JSON.stringify(service.inputSchema, null, 2)}
                            </pre>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="args">Arguments (JSON)</Label>
                            <Textarea
                              id="args"
                              value={serviceArgs}
                              onChange={(e) => setServiceArgs(e.target.value)}
                              placeholder='{"path": "/example.txt"}'
                              rows={4}
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            variant="outline"
                            onClick={() => {
                              setIsDialogOpen(false);
                              setSelectedService(null);
                              setServiceArgs("");
                            }}
                          >
                            Cancel
                          </Button>
                          <Button onClick={handleCallService} disabled={isCalling}>
                            {isCalling ? "Calling..." : "Call Service"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}