"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./ui/dialog";

export interface CommandPaletteItem {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  keywords?: string;
  enabled?: boolean;
  run: () => void;
}

export function CommandPalette({ commands }: { commands: CommandPaletteItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const openPalette = useCallback(() => {
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      openPalette();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPalette]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return commands.filter((command) => {
      if (command.enabled === false) return false;
      if (!needle) return true;
      return `${command.title} ${command.category} ${command.keywords ?? ""}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [commands, query]);

  const run = (command: CommandPaletteItem) => {
    setOpen(false);
    command.run();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? openPalette() : setOpen(false))}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="cm-command-trigger mx-auto hidden h-7 w-[min(13rem,48vw)] shrink-0 items-center gap-2 rounded-[var(--cm-button-radius)] border border-zinc-800/70 bg-zinc-900/20 px-2.5 text-xs text-zinc-500 transition-colors hover:border-zinc-700/70 hover:bg-zinc-800/35 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--cm-accent)] sm:inline-flex"
            title="命令面板"
            aria-label="打开命令面板"
          />
        }
      >
        <Search size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">命令面板</span>
        <kbd
          aria-hidden="true"
          className="shrink-0 rounded border border-zinc-800/80 px-1.5 py-0.5 text-[10px] leading-none text-zinc-600"
        >
          Ctrl+K
        </kbd>
      </DialogTrigger>
      <DialogContent
        className="top-[18%] block max-w-xl translate-y-0 overflow-hidden border-zinc-700 bg-zinc-900 p-0 text-zinc-100 sm:max-w-xl sm:translate-y-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <DialogDescription className="sr-only">搜索并执行工作台操作</DialogDescription>
        <label className="flex h-11 items-center gap-2 border-b border-zinc-800 px-3">
          <Search size={15} className="shrink-0 text-zinc-500" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const command = filtered[activeIndex];
                if (command) run(command);
              }
            }}
            placeholder="输入命令，例如“终端”或“侧栏”"
            className="cm-command-input h-8 min-w-0 flex-1 rounded-[var(--cm-button-radius)] border border-zinc-700 bg-zinc-950 px-2.5 text-sm outline-none transition-colors duration-150 placeholder:text-zinc-600"
          />
          <kbd className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">
            Esc
          </kbd>
        </label>
        <div className="max-h-80 overflow-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-zinc-500">没有匹配的命令</p>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                type="button"
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => run(command)}
                className={`flex w-full items-center gap-3 rounded px-2.5 py-2 text-left text-xs ${
                  index === activeIndex
                    ? "bg-[var(--cm-accent-muted)] text-zinc-100"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{command.title}</span>
                <span className="text-[10px] text-zinc-600">{command.category}</span>
                {command.shortcut && (
                  <kbd className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">
                    {command.shortcut}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
