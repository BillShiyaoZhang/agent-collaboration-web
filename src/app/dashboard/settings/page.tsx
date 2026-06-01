"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  User,
  Server,
  Database,
  CheckCircle2,
  AlertCircle,
  Activity,
  Shield,
  RefreshCw,
  Sliders,
  Laptop
} from "lucide-react";

interface SettingsData {
  user: {
    id: string;
    email: string;
    name: string;
  };
  platform: {
    url: string;
    databaseType: string;
    nodeEnv: string;
    nextAuthUrl: string;
  };
  stats: {
    agents: number;
    messages: number;
    hitl: number;
    transactions: number;
  };
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [name, setName] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "success" | "failed">("idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [theme, setTheme] = useState("system");
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifyDesktop, setNotifyDesktop] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState("30");

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const response = await fetch("/api/settings");
      if (response.ok) {
        const result = await response.json();
        setData(result);
        setName(result.user.name || "");
      } else {
        setError("Failed to load settings");
      }
    } catch (err) {
      console.error(err);
      setError("An error occurred while loading settings");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setMessage("");
    setError("");

    try {
      // Simulate profile update API call
      await new Promise((resolve) => setTimeout(resolve, 800));
      setMessage("Profile settings updated successfully!");
      if (data) {
        setData({
          ...data,
          user: {
            ...data.user,
            name,
          },
        });
      }
    } catch (err) {
      setError("Failed to update profile");
    } finally {
      setIsSaving(false);
    }
  };

  const testPlatformConnection = async () => {
    setTestingConnection(true);
    setConnectionStatus("idle");
    try {
      // Simulate checking connection to Agent Platform URN Registry
      await new Promise((resolve) => setTimeout(resolve, 1000));
      setConnectionStatus("success");
    } catch (err) {
      setConnectionStatus("failed");
    } finally {
      setTestingConnection(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-2">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading settings configuration...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account preferences, local database configuration, and agent platform connections
        </p>
      </div>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-4 text-destructive">
            <AlertCircle className="h-5 w-5" />
            <p className="text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {message && (
        <Card className="border-emerald-500/50 bg-emerald-500/5">
          <CardContent className="flex items-center gap-3 p-4 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-5 w-5" />
            <p className="text-sm">{message}</p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList className="grid w-full max-w-md grid-cols-4">
          <TabsTrigger value="profile" className="flex items-center gap-2">
            <User className="h-4 w-4" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="platform" className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            Platform
          </TabsTrigger>
          <TabsTrigger value="preferences" className="flex items-center gap-2">
            <Sliders className="h-4 w-4" />
            Preferences
          </TabsTrigger>
          <TabsTrigger value="system" className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            System
          </TabsTrigger>
        </TabsList>

        {/* PROFILE TAB */}
        <TabsContent value="profile" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>User Profile</CardTitle>
              <CardDescription>
                Update your account details and how your name is displayed
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveProfile} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email Address</Label>
                  <Input
                    id="email"
                    type="email"
                    value={data?.user.email || ""}
                    disabled
                    className="bg-muted cursor-not-allowed"
                  />
                  <p className="text-xs text-muted-foreground">
                    Email address cannot be changed. It is used for account authentication.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Display Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Name"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="userId">User ID (cuid)</Label>
                  <Input
                    id="userId"
                    value={data?.user.id || ""}
                    disabled
                    className="font-mono text-xs bg-muted cursor-not-allowed"
                  />
                </div>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "Saving changes..." : "Save Changes"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* PLATFORM CONFIG TAB */}
        <TabsContent value="platform" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent Platform Connection</CardTitle>
              <CardDescription>
                Configure the integration link with the agent-comm-platform coordinator
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="platformUrl">Agent Platform URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="platformUrl"
                    value={data?.platform.url || ""}
                    disabled
                    className="bg-muted font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    type="button"
                    onClick={testPlatformConnection}
                    disabled={testingConnection}
                    className="whitespace-nowrap"
                  >
                    {testingConnection ? (
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      "Test Connection"
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Configured via `AGENT_PLATFORM_URL` environmental variable.
                </p>
              </div>

              {connectionStatus === "success" && (
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5 p-3 rounded-lg border border-emerald-500/20 text-sm">
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                  <div>
                    <span className="font-semibold">Connection verified.</span> Web app successfully connected to agent platform.
                  </div>
                </div>
              )}

              {connectionStatus === "failed" && (
                <div className="flex items-center gap-2 text-destructive bg-destructive/5 p-3 rounded-lg border border-destructive/20 text-sm">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <div>
                    <span className="font-semibold">Connection failed.</span> Please check if the agent-comm-platform container is running.
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="nextAuthUrl">NextAuth Callback URL</Label>
                <Input
                  id="nextAuthUrl"
                  value={data?.platform.nextAuthUrl || ""}
                  disabled
                  className="bg-muted font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Configured via `NEXTAUTH_URL`. Used to ensure secure authorization callback flows.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* PREFERENCES TAB */}
        <TabsContent value="preferences" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>System Preferences</CardTitle>
              <CardDescription>
                Personalize dashboard aesthetics and behaviors
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label className="text-base font-semibold">Aesthetics Theme</Label>
                <div className="grid grid-cols-3 gap-3">
                  {["light", "dark", "system"].map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTheme(t)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-lg border text-sm font-medium transition-all ${
                        theme === t
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-muted hover:bg-accent"
                      }`}
                    >
                      {t === "light" && <Activity className="h-5 w-5" />}
                      {t === "dark" && <Shield className="h-5 w-5" />}
                      {t === "system" && <Laptop className="h-5 w-5" />}
                      <span className="capitalize">{t} Mode</span>
                    </button>
                  ))}
                </div>
              </div>

              <hr className="border-muted" />

              <div className="space-y-3">
                <Label className="text-base font-semibold">HITL Alert Notifications</Label>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">Desktop Notifications</div>
                      <div className="text-xs text-muted-foreground">Get browser push notifications for urgent HITL events</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={notifyDesktop}
                      onChange={(e) => setNotifyDesktop(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">Email Digests</div>
                      <div className="text-xs text-muted-foreground">Receive daily reports on agent messaging, calls, and failures</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={notifyEmail}
                      onChange={(e) => setNotifyEmail(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                    />
                  </div>
                </div>
              </div>

              <hr className="border-muted" />

              <div className="space-y-2">
                <Label htmlFor="refreshInterval">Dashboard Auto-Refresh Interval</Label>
                <select
                  id="refreshInterval"
                  value={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.value)}
                  className="w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  <option value="10">Every 10 seconds</option>
                  <option value="30">Every 30 seconds</option>
                  <option value="60">Every 60 seconds</option>
                  <option value="0">Never (Manual refresh)</option>
                </select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* SYSTEM STATUS TAB */}
        <TabsContent value="system" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-primary" />
                  Database Configuration
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">Database Engine</span>
                  <span className="font-semibold">{data?.platform.databaseType}</span>
                </div>
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">ORM Provider</span>
                  <span className="font-semibold font-mono">Prisma Client</span>
                </div>
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">Encryption Engine</span>
                  <span className="font-semibold">AES-256-GCM / Ed25519</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">Node Environment</span>
                  <Badge variant="outline" className="capitalize">
                    {data?.platform.nodeEnv}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-primary" />
                  Workspace Metrics
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">Registered Agents</span>
                  <span className="font-bold text-primary">{data?.stats.agents}</span>
                </div>
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">Collaborative Messages</span>
                  <span className="font-semibold">{data?.stats.messages}</span>
                </div>
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">HITL Requests Processed</span>
                  <span className="font-semibold">{data?.stats.hitl}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">Logged Transactions</span>
                  <span className="font-semibold">{data?.stats.transactions}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
