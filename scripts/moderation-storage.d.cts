export function seal(secret: string | undefined, userId: string, agentId: string, kind: string, id: string, body: unknown): string;
export function unseal(secret: string | undefined, userId: string, agentId: string, kind: string, id: string, value: string): any;
