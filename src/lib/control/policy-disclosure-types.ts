export type PolicyDisclosure =
  | { status: "legacy"; paused: boolean; can_use_workbench: boolean; web_console_readable: true; agent_gateway_readable: null }
  | { status: "signed"; platform_id: string; mode: "private" | "compliance"; epoch: number;
      policy_hash: string; gateway_key_id: string; confirmed: boolean; paused: boolean; can_use_workbench: boolean;
      web_console_readable: true; agent_gateway_readable: boolean };
