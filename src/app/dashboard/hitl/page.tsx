"use client";

import { useState, useEffect } from "react";
import { Shield, Check, X, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";

interface HITLRequest {
  id: string;
  requestType: string;
  payload: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  agent: {
    id: string;
    name: string;
    urn: string;
  };
}

export default function HITLPage() {
  const [requests, setRequests] = useState<HITLRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchRequests();
    // Poll for new requests every 10 seconds
    const interval = setInterval(fetchRequests, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchRequests = async () => {
    try {
      const response = await fetch("/api/hitl");
      if (response.ok) {
        const data = await response.json();
        setRequests(data);
      }
    } catch (error) {
      console.error("Failed to fetch HITL requests:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResolve = async (id: string, action: "approve" | "reject") => {
    try {
      const response = await fetch(`/api/hitl/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (response.ok) {
        fetchRequests();
      }
    } catch (error) {
      console.error(`Failed to ${action} request:`, error);
    }
  };

  const getRequestTypeBadge = (type: string) => {
    switch (type) {
      case "message":
        return { label: "Message", variant: "default" as const };
      case "service_call":
        return { label: "Service Call", variant: "warning" as const };
      case "transaction":
        return { label: "Transaction", variant: "destructive" as const };
      default:
        return { label: type, variant: "secondary" as const };
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return { label: "Pending", variant: "warning" as const, icon: Clock };
      case "approved":
        return { label: "Approved", variant: "success" as const, icon: Check };
      case "rejected":
        return { label: "Rejected", variant: "destructive" as const, icon: X };
      default:
        return { label: status, variant: "secondary" as const, icon: Clock };
    }
  };

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">HITL Requests</h1>
        <p className="text-muted-foreground">
          Review and approve agent actions requiring human authorization
        </p>
      </div>

      {pendingCount > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-center gap-3">
          <Shield className="h-5 w-5 text-yellow-600" />
          <span className="text-sm text-yellow-800">
            You have <strong>{pendingCount}</strong> pending request
            {pendingCount > 1 ? "s" : ""} awaiting your approval
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">
          Loading requests...
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Shield className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No HITL requests</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => {
            const typeBadge = getRequestTypeBadge(request.requestType);
            const statusBadge = getStatusBadge(request.status);
            const payload = JSON.parse(request.payload);

            return (
              <Card key={request.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-lg">
                        {request.agent.name}
                      </CardTitle>
                      <Badge variant={typeBadge.variant}>{typeBadge.label}</Badge>
                      <Badge
                        variant={statusBadge.variant}
                        className="flex items-center gap-1"
                      >
                        <statusBadge.icon className="h-3 w-3" />
                        {statusBadge.label}
                      </Badge>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {formatDateTime(request.createdAt)}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="bg-muted rounded-lg p-4 mb-4">
                    <pre className="text-xs overflow-auto">
                      {JSON.stringify(payload, null, 2)}
                    </pre>
                  </div>

                  {request.status === "pending" && (
                    <div className="flex gap-3">
                      <Button
                        onClick={() => handleResolve(request.id, "approve")}
                        className="flex-1"
                      >
                        <Check className="mr-2 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => handleResolve(request.id, "reject")}
                        className="flex-1"
                      >
                        <X className="mr-2 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  )}

                  {request.status !== "pending" && request.resolvedAt && (
                    <p className="text-sm text-muted-foreground text-center">
                      Resolved {formatDateTime(request.resolvedAt)}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}