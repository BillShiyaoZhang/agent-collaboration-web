import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Repository = "deploy" | "web" | "platform" | "sdk";
type RouteContext = { params: Promise<{ repo: string; path: string[] }> };

const repositoryPaths: Record<Repository, string> = {
  deploy: "../docs",
  web: "docs",
  platform: "../agent-comm-platform/docs",
  sdk: "../agent-comm-platform/agent-comm/docs",
};

function published(repo: Repository, file: string): boolean {
  if (file === "README.md") return true;
  if (repo === "deploy") {
    if (/^(users|agents|developers|architecture|operations|maintenance)\//.test(file)) return true;
    return ["testing/TEST_STRATEGY.md", "testing/TEST_EXECUTION_GUIDE.md", "testing/TWO_AGENT_HITL_RUNBOOK.md"].includes(file);
  }
  if (repo === "web") return /^(architecture|operations)\//.test(file);
  if (repo === "platform") return /^(architecture|guides)\//.test(file);
  if (file === "architecture/CAPABILITY_SKILL_MAP.md") return false;
  return /^(architecture|guides)\//.test(file);
}

function sourceRoot(repo: Repository): string {
  return process.env.DOCS_SOURCE_ROOT
    ? path.resolve(process.env.DOCS_SOURCE_ROOT, repo)
    : path.resolve(process.cwd(), repositoryPaths[repo]);
}

function fileFor(repo: string, segments: string[]): string | null {
  if (!Object.hasOwn(repositoryPaths, repo) || !Array.isArray(segments) || segments.length === 0) return null;
  if (segments.some(segment => !/^[\w.-]+$/.test(segment) || segment === "." || segment === "..")) return null;
  const file = segments.join("/");
  if (!file.endsWith(".md") || !published(repo as Repository, file)) return null;
  const base = sourceRoot(repo as Repository);
  const resolved = path.resolve(base, ...segments);
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

async function serve(context: RouteContext, head = false) {
  const { repo, path: segments } = await context.params;
  const filename = fileFor(repo, segments);
  if (!filename) return new NextResponse(null, { status: 404 });
  try {
    const base = await realpath(sourceRoot(repo as Repository));
    const resolved = await realpath(filename);
    if (!resolved.startsWith(base + path.sep)) return new NextResponse(null, { status: 404 });
    const markdown = await readFile(resolved, "utf8");
    return new NextResponse(head ? null : markdown, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

export async function GET(_request: Request, context: RouteContext) { return serve(context); }
export async function HEAD(_request: Request, context: RouteContext) { return serve(context, true); }
