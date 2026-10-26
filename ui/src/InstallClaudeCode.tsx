// Claude Code isn't on this computer: Anthropic's one-line installer for this system to copy (Orbit
// never runs it itself), their install guide, and a check again. Used by the main page's notice and
// by Settings (Voice engine, Second brain).
import { useState } from "react";
import { CLAUDE_CODE_GUIDE, claudeInstallCommand } from "./talk.js";

/**
 * Puts text on the clipboard from a click: the Clipboard API, else a hidden field's copy (Orbit's
 * windows aren't granted the clipboard permission; a copy from a user's click needs none).
 */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.appendChild(t);
  t.select();
  try {
    document.execCommand("copy");
  } finally {
    t.remove();
  }
}

const pill = "rounded-full bg-soft px-3 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-black/[0.08] hover:text-fg";

/** The command, then Copy install command · Install guide · Check again. */
export function InstallClaudeCode({ platform, onCheck, center = false }: { platform: string; onCheck: () => void; center?: boolean }) {
  const command = claudeInstallCommand(platform);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className={`flex flex-col gap-2 ${center ? "items-center" : "items-start"}`}>
      <code className="max-w-full select-text break-all rounded-lg bg-soft px-2.5 py-1.5 font-mono text-[11.5px] text-ink">{command}</code>
      <div className={`flex flex-wrap gap-2 ${center ? "justify-center" : ""}`}>
        <button onClick={() => void copy()} className={pill}>
          {copied ? "Copied" : "Copy install command"}
        </button>
        <a href={CLAUDE_CODE_GUIDE} target="_blank" rel="noreferrer" className={pill}>
          Install guide
        </a>
        <button onClick={onCheck} className={pill}>
          Check again
        </button>
      </div>
    </div>
  );
}
