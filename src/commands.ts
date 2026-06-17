export type ReviewerCommand = "review" | "summary" | "help";

export interface SlashCommand {
  command: string;
  description: string;
}

export const AVAILABLE_COMMANDS: SlashCommand[] = [
  { command: "/review", description: "Posts a full code review of the pull request" },
  { command: "/robin", description: "Alias for /review" },
  { command: "/summary", description: "Posts a summary of the changes in the pull request" },
  { command: "/help", description: "Shows available commands" },
];

const PERMISSION_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

export function parseSlashCommand(commentBody: string): ReviewerCommand | undefined {
  const firstLine = commentBody
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return undefined;

  const match = firstLine.match(/^\/(review|robin|summary|help)(?:\s|$)/i);
  if (!match) return undefined;

  const cmd = match[1].toLowerCase();
  return (cmd === "robin" ? "review" : cmd) as ReviewerCommand;
}

export function hasRequiredPermission(permission: string, minimumPermission: string): boolean {
  const userRank = PERMISSION_RANK[permission.toLowerCase()] ?? 0;
  const requiredRank = PERMISSION_RANK[minimumPermission.toLowerCase()] ?? PERMISSION_RANK.write;

  return userRank >= requiredRank;
}
