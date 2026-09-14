import Image from "next/image";

export function Footer() {
  return <footer className="shrink-0 border-t bg-card/60 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] leading-4 text-muted-foreground">
      <a href="https://beian.mps.gov.cn/#/query/webSearch?code=41010502007774" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 transition-colors hover:text-foreground"><Image src="/beian-icon.png" alt="" width={12} height={12} unoptimized />豫公网安备41010502007774号</a>
      <span aria-hidden="true" className="hidden sm:inline">·</span>
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground">豫ICP备2026025305号-1</a>
    </div>
  </footer>;
}
