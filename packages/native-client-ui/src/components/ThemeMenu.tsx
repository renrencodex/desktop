"use client";

import { Palette } from "lucide-react";
import { useRef } from "react";

import { getThemeDefinition, isThemeId, THEME_DEFINITIONS, type ThemeId } from "../lib/themes";
import { useThemeStore } from "../stores/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function ThemeMenu() {
  const themeId = useThemeStore((state) => state.themeId);
  const setTheme = useThemeStore((state) => state.setTheme);
  const currentTheme = getThemeDefinition(themeId);
  const pendingTheme = useRef<ThemeId | null>(null);
  const menuOpen = useRef(false);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        menuOpen.current = open;
        // Reopening cancels the previous closing cycle's selection.
        if (open) pendingTheme.current = null;
      }}
      onOpenChangeComplete={(open) => {
        if (open || menuOpen.current) return;
        const selected = pendingTheme.current;
        pendingTheme.current = null;
        // Keep the closing popup's palette and geometry stable; native theme sync starts afterwards.
        if (selected && selected !== useThemeStore.getState().themeId) setTheme(selected);
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="cm-icon-button"
            title={`选择主题（当前：${currentTheme.name}）`}
            aria-label={`选择主题，当前为${currentTheme.name}`}
          />
        }
      >
        <Palette size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="cm-theme-menu w-52">
        <DropdownMenuRadioGroup
          value={themeId}
          onValueChange={(value) => {
            if (isThemeId(value)) pendingTheme.current = value;
          }}
        >
          {THEME_DEFINITIONS.map((theme) => (
            <DropdownMenuRadioItem
              key={theme.id}
              value={theme.id}
              label={`${theme.name}，${theme.description}`}
              closeOnClick
              className="gap-2 py-1.5"
            >
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-700"
                style={{ backgroundColor: theme.surface }}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: theme.accent }} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] leading-4 text-zinc-200">{theme.name}</span>
                <span className="block text-[10px] text-zinc-500">{theme.description}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
