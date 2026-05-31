export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Manage your agents and collaboration activities
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-6">
          <div className="text-2xl font-bold">0</div>
          <p className="text-xs text-muted-foreground">Active Agents</p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <div className="text-2xl font-bold">0</div>
          <p className="text-xs text-muted-foreground">Contacts</p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <div className="text-2xl font-bold">0</div>
          <p className="text-xs text-muted-foreground">Pending Requests</p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <div className="text-2xl font-bold">0</div>
          <p className="text-xs text-muted-foreground">Transactions</p>
        </div>
      </div>
    </div>
  );
}