/** A deliberately small shell grammar. Unknown syntax/commands still ask for approval. */
export function isReadOnlyCommand(command: string): boolean {
  const source = command.trim().replace(/\s+2>\/dev\/null(?=\s|$)/g, "");
  // No expansion, substitution, redirects, comments, or executable shell constructs.
  if (!source || /[$`\\<>\n\r(){}*?#]/.test(source)) return false;
  const segments: string[][] = [[]];
  const token = /\s*(?:'([^']*)'|"([^"]*)"|(&&|\|\||[;|])|([^\s"';&|]+))/gy;
  let end = 0;
  while (end < source.length) {
    token.lastIndex = end;
    const match = token.exec(source);
    if (!match) return false;
    end = token.lastIndex;
    if (match[3]) {
      if (!segments.at(-1)!.length) return false;
      segments.push([]);
    } else {
      // Quoted tokens must stand alone; reject concatenated shell words.
      if (end < source.length && !/[\s;&|]/.test(source[end])) return false;
      segments.at(-1)!.push(match[1] ?? match[2] ?? match[4]);
    }
  }
  return segments.every(isReadOnlyInvocation);
}

function isReadOnlyInvocation(words: string[]): boolean {
  const [program, ...args] = words;
  if (!program) return false;
  if (program === "pwd") return args.every(arg => /^-[LP]$/.test(arg));
  if (program === "ls") return args.every(arg => !arg.startsWith("-") || /^-[laAdhtrS1]+$/.test(arg) || arg === "--");
  if (program === "cat") return args.every(arg => !arg.startsWith("-") || arg === "--");
  if (program === "head" || program === "tail") {
    return args.every(arg => !arg.startsWith("-") || /^-\d+$/.test(arg) || ["-n", "-c", "--"].includes(arg)) &&
      args.every((arg, i) => !["-n", "-c"].includes(arg) || /^\d+$/.test(args[i + 1] ?? ""));
  }
  if (program !== "git") return false;
  if (args[0] === "-C") {
    if (!args[1] || args[1].startsWith("-")) return false;
    args.splice(0, 2);
  }
  const subcommand = args.shift();
  if (subcommand === "remote") return args.length === 0 || (args.length === 1 && ["-v", "--verbose"].includes(args[0]));
  if (subcommand === "branch") return args.length === 1 && ["-vv", "-v", "-a", "-avv", "--show-current"].includes(args[0]);
  if (subcommand === "submodule") return args.length === 1 && args[0] === "status";
  if (subcommand === "merge-base") return args[0] === "--is-ancestor" && args.length === 3 && args.slice(1).every(arg => !arg.startsWith("-"));
  const flags: Record<string, RegExp> = {
    status: /^(?:--short|--branch|--porcelain(?:=v[12])?|-sb|--untracked-files(?:=(?:no|normal|all))?)$/,
    log: /^(?:--oneline|--decorate|--graph|--all|--left-right|-\d+|--max-count=\d+|--format=[%a-zA-Z0-9 :._-]+)$/,
    diff: /^(?:--stat|--numstat|--shortstat|--check|--name-only|--name-status|--cached|--submodule=log|--no-ext-diff|--no-textconv)$/,
    "rev-parse": /^(?:--show-toplevel|--git-dir|--short|--verify)$/,
    "rev-list": /^(?:--left-right|--count|--max-count=\d+)$/,
    "ls-tree": /^(?:--name-only|-r|-d)$/,
    "cat-file": /^-[te]$/
  };
  return Boolean(subcommand && flags[subcommand]) && args.every(arg => arg === "--" || !arg.startsWith("-") || flags[subcommand!].test(arg));
}

export type TerminalApprovalDecision = boolean | { approved: boolean; scope?: "once" | "task" };

/** What a "yes, for the whole task" answer was actually about. */
export type ApprovalGrantKind = "privileged" | "outward-action" | "none";

/**
 * Grants live only inside one orchestrator; denial never grants future access.
 *
 * The two grants are kept separate on purpose. Saying "yes, follow these 20 accounts for the rest
 * of the task" must not also hand the agent a shell for the rest of the task - that would be a
 * privilege escalation through an unrelated question.
 */
export class TaskApprovalScope {
  private granted = false;
  private outwardGranted = false;

  allows(toolName: string): boolean {
    return this.granted && (toolName === "run_terminal_command" || toolName === "workspace_file");
  }

  /** Only ever true for repeat outward actions; irreversible ones ask every single time. */
  allowsOutwardAction(): boolean {
    return this.outwardGranted;
  }

  resolve(decision: TerminalApprovalDecision, kind: ApprovalGrantKind = "privileged"): boolean {
    const approved = typeof decision === "boolean" ? decision : decision.approved === true;
    if (approved && typeof decision !== "boolean" && decision.scope === "task") {
      if (kind === "outward-action") this.outwardGranted = true;
      else if (kind === "privileged") this.granted = true;
    }
    return approved;
  }
}

/** Broad approval settings never answer an irreversible action for the user. */
export function canAutoApprove(autoApprove: boolean, kind?: string): boolean {
  return autoApprove && kind !== "irreversible" && kind !== "financial";
}
