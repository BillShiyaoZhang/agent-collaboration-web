"use client";

import { useState, useEffect } from "react";
import { CreditCard, ArrowUpRight, ArrowDownRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/utils";
import { truncateUrn } from "@/lib/utils";

interface Agent {
  id: string;
  name: string;
  urn: string;
}

interface Transaction {
  id: string;
  fromUrn: string;
  toUrn: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  agent: {
    id: string;
    name: string;
    urn: string;
  };
}

interface Contact {
  id: string;
  contactUrn: string;
  alias: string | null;
}

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");
  const [newTransaction, setNewTransaction] = useState({
    agentId: "",
    toUrn: "",
    amount: "",
    currency: "TOKEN",
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [txResponse, agentsResponse, contactsResponse] = await Promise.all([
        fetch("/api/transactions"),
        fetch("/api/agents"),
        fetch("/api/contacts"),
      ]);

      if (txResponse.ok) setTransactions(await txResponse.json());
      if (agentsResponse.ok) setAgents(await agentsResponse.json());
      if (contactsResponse.ok) setContacts(await contactsResponse.json());
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsCreating(true);

    try {
      const agent = agents.find((a) => a.id === newTransaction.agentId);
      if (!agent) throw new Error("Agent not found");

      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newTransaction,
          fromUrn: agent.urn,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create transaction");
      }

      setIsDialogOpen(false);
      setNewTransaction({ agentId: "", toUrn: "", amount: "", currency: "TOKEN" });
      fetchData();
      // Redirect to HITL to approve
      window.location.href = "/dashboard/hitl";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create transaction");
    } finally {
      setIsCreating(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return { variant: "warning" as const, label: "Pending" };
      case "confirmed":
        return { variant: "success" as const, label: "Confirmed" };
      case "failed":
        return { variant: "destructive" as const, label: "Failed" };
      default:
        return { variant: "secondary" as const, label: status };
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Transactions</h1>
          <p className="text-muted-foreground">
            Manage token transfers between agents
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <CreditCard className="mr-2 h-4 w-4" />
              New Transaction
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreateTransaction}>
              <DialogHeader>
                <DialogTitle>Create Transaction</DialogTitle>
                <DialogDescription>
                  Transfer tokens to another agent
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {error && (
                  <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
                    {error}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="agentId">From Agent</Label>
                  <Select
                    value={newTransaction.agentId}
                    onValueChange={(value) =>
                      setNewTransaction({ ...newTransaction, agentId: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="toUrn">To Contact</Label>
                  <Select
                    value={newTransaction.toUrn}
                    onValueChange={(value) =>
                      setNewTransaction({ ...newTransaction, toUrn: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select contact" />
                    </SelectTrigger>
                    <SelectContent>
                      {contacts.map((contact) => (
                        <SelectItem key={contact.id} value={contact.contactUrn}>
                          {contact.alias || truncateUrn(contact.contactUrn)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="amount">Amount</Label>
                  <Input
                    id="amount"
                    type="text"
                    value={newTransaction.amount}
                    onChange={(e) =>
                      setNewTransaction({ ...newTransaction, amount: e.target.value })
                    }
                    placeholder="100"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Input
                    id="currency"
                    value={newTransaction.currency}
                    onChange={(e) =>
                      setNewTransaction({
                        ...newTransaction,
                        currency: e.target.value,
                      })
                    }
                    placeholder="TOKEN"
                    disabled
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
                  {isCreating ? "Creating..." : "Create Transaction"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search transactions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">
          Loading transactions...
        </div>
      ) : transactions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <CreditCard className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground mb-4">No transactions yet</p>
            <Button onClick={() => setIsDialogOpen(true)}>
              <CreditCard className="mr-2 h-4 w-4" />
              Create your first transaction
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {transactions
                .filter(
                  (tx) =>
                    tx.fromUrn.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    tx.toUrn.toLowerCase().includes(searchQuery.toLowerCase())
                )
                .map((transaction) => {
                  const statusBadge = getStatusBadge(transaction.status);
                  return (
                    <div
                      key={transaction.id}
                      className="flex items-center justify-between p-4"
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className={`h-10 w-10 rounded-full flex items-center justify-center ${
                            transaction.status === "pending"
                              ? "bg-yellow-100"
                              : "bg-green-100"
                          }`}
                        >
                          <ArrowUpRight
                            className={`h-5 w-5 ${
                              transaction.status === "pending"
                                ? "text-yellow-600"
                                : "text-green-600"
                            }`}
                          />
                        </div>
                        <div>
                          <div className="font-medium">
                            {truncateUrn(transaction.fromUrn)} →{" "}
                            {truncateUrn(transaction.toUrn)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {transaction.agent.name} • {formatDateTime(transaction.createdAt)}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium">
                          {transaction.amount} {transaction.currency}
                        </div>
                        <Badge variant={statusBadge.variant} className="mt-1">
                          {statusBadge.label}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}