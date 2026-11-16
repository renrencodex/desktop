"use client";

import { Check } from "lucide-react";
import type { MachineImage } from "@cloud-machine/client-contracts";
import { DEFAULT_MACHINE_IMAGE_ID } from "@cloud-machine/client-contracts";

import { OsLogo } from "./OsLogo";

export { DEFAULT_MACHINE_IMAGE_ID };

export function MachineImageSelect(props: {
  images: readonly MachineImage[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby="machine-image-label"
      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {props.images.map((image) => {
        const selected = image.id === props.value;
        return (
          <label
            key={image.id}
            className={`group relative flex cursor-pointer flex-col rounded-[var(--cm-card-radius)] border p-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[var(--cm-accent)] ${
              selected
                ? "border-[var(--cm-accent)] bg-[var(--cm-accent-muted)]"
                : "border-zinc-700 bg-zinc-950 hover:border-zinc-600 hover:bg-zinc-900"
            }`}
          >
            <input
              type="radio"
              name="imageId"
              value={image.id}
              checked={selected}
              required
              className="sr-only"
              onChange={() => props.onValueChange(image.id)}
            />

            <span className="flex items-start justify-between gap-2">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--cm-card-radius)] border transition-colors ${
                  selected
                    ? "border-[var(--cm-accent)]/40 bg-[var(--cm-accent-muted)] text-[var(--cm-accent)]"
                    : "border-zinc-800 bg-zinc-900 text-zinc-500"
                }`}
              >
                <OsLogo osId={image.osId} label={image.label} size={14} />
              </span>
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors ${
                  selected
                    ? "bg-[var(--cm-accent)] text-[var(--cm-accent-fg)]"
                    : "border border-zinc-700 text-transparent"
                }`}
              >
                <Check size={12} strokeWidth={2.5} />
              </span>
            </span>

            <span className="mt-2 block text-xs font-medium text-zinc-200">{image.label}</span>
            <span className="mt-0.5 line-clamp-2 block text-[10px] text-zinc-500">
              {image.description}
            </span>
          </label>
        );
      })}
    </div>
  );
}
