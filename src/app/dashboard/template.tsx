export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return <div className="page-enter flex h-full min-h-0 flex-col">{children}</div>;
}
