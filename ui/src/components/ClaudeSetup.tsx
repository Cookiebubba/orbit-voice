// Help for someone without Claude Code: the official install command for this computer (with
// Copy), the sign-in step, and a link to Anthropic's setup page. Orbit never runs the installer;
// it only shows the command. Used by the main page's notice and Settings → Second brain.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { desktop, isMac } from "../desktop";
import { CLAUDE_SETUP_URL, claudeInstall } from "../talk.js";

/** This computer's platform, as process.platform names it. */
const platform =
  desktop?.platform ?? (isMac ? "darwin" : typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent || "") ? "win32" : "linux");

/** Copy text: the clipboard API, or (where it's refused) a hidden selection and copy. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  area.remove();
  return ok;
}

/** The install command in a code box, with Copy. */
export function InstallCommand({ className }: { className?: string }) {
  const { where, command } = claudeInstall(platform);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const copy = async () => {
    setCopied((await copyText(command)) ? "yes" : "no");
    setTimeout(() => setCopied(null), 1800);
  };
  return (
    <div className={cn("w-full text-left", className)}>
      <div className="mb-1 text-[11.5px] text-muted">In {where}:</div>
      <div className="flex items-center gap-1 rounded-lg border border-line bg-soft py-1 pr-1 pl-2.5">
        <code className="min-w-0 flex-1 py-0.5 font-mono text-[11.5px] leading-snug [overflow-wrap:anywhere] text-fg select-text">{command}</code>
        <button
          onClick={copy}
          aria-label="Copy the install command"
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-ink transition-colors hover:bg-black/[0.06] hover:text-fg"
        >
          {copied === "yes" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied === "yes" ? "Copied" : copied === "no" ? "Select it" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** "Then run claude once…", with claude set as code. */
export function SignInStep({ className }: { className?: string }) {
  return (
    <p className={cn("text-[12px] leading-snug text-muted", className)}>
      Then run <code className="font-mono text-[11.5px] text-ink">claude</code> once in a terminal and sign in with your Claude account.
    </p>
  );
}

/** Not signed in: the same short line. */
export function NotSignedInLine({ className }: { className?: string }) {
  return (
    <p className={cn("text-[12.5px] leading-snug text-amber-700", className)}>
      Claude Code isn't signed in. Run <code className="font-mono text-[11.5px]">claude</code> once in a terminal and sign in with your Claude account.
    </p>
  );
}

/** Anthropic's setup page, opened in the browser (the app sends https links there). */
export function SetupGuideLink({ className, children = "Setup guide" }: { className?: string; children?: React.ReactNode }) {
  return (
    <a href={CLAUDE_SETUP_URL} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}
