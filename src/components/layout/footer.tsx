export function Footer() {
  return (
    <footer className="border-t bg-background py-4">
      <div className="container text-center text-xs text-muted-foreground">
        <img
          src="/beian-icon.png"
          alt="公安备案"
          style={{ height: 16, verticalAlign: "-3px", marginRight: 4 }}
        />
        <a
          href="https://beian.mps.gov.cn/#/query/webSearch?code=41010502007774"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground transition-colors"
        >
          豫公网安备41010502007774号
        </a>
        <span style={{ margin: "0 8px" }}>|</span>
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
        >
          豫ICP备2026025305号-1
        </a>
      </div>
    </footer>
  );
}