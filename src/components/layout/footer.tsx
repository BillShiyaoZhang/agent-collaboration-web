export function Footer() {
  return (
    <footer className="border-t bg-background py-4">
      <div className="container text-center text-xs text-muted-foreground">
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