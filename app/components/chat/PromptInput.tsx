"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";

/**
 * The prompt box.
 *
 * Adapted from the shadcn/ui `PromptInput` pattern -- the same composition
 * (context provider, autosizing textarea, an actions slot) without the
 * dependency. This project has no shadcn, no Radix Tooltip and no `cn`, so
 * pulling the original in verbatim would mean adding a component library and a
 * primitives tree to style one control. The parts that matter are the behaviour,
 * and that is what is reproduced here.
 *
 * Colours are the project's own tokens -- `accent`, `edge`, `surface`, `body`,
 * `heading` -- so this control looks like the rest of the app and follows a
 * palette change with it. Nothing here hardcodes a colour.
 *
 * Tooltips are a plain `title` attribute rather than a Radix popover. It is the
 * one part of the original that needed a dependency to work at all, and a native
 * tooltip is keyboard- and screen-reader-accessible without one.
 */

type PromptInputContextValue = {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
};

const PromptInputContext = createContext<PromptInputContextValue | null>(null);

function usePromptInput(): PromptInputContextValue {
  const context = useContext(PromptInputContext);
  if (!context) {
    throw new Error("usePromptInput must be used within a PromptInput");
  }
  return context;
}

export function PromptInput({
  className = "",
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  disabled,
  children,
}: {
  className?: string;
  isLoading?: boolean;
  maxHeight?: number | string;
  value?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  // Uncontrolled fallback, so the component works without a parent holding state.
  const [internalValue, setInternalValue] = useState(value ?? "");

  return (
    <PromptInputContext.Provider
      value={{
        isLoading,
        value: value ?? internalValue,
        setValue: onValueChange ?? setInternalValue,
        maxHeight,
        onSubmit,
        disabled,
      }}
    >
      <div
        className={`rounded-3xl border border-edge bg-surface p-2 shadow-sm focus-within:border-accent ${className}`}
      >
        {children}
      </div>
    </PromptInputContext.Provider>
  );
}

export function PromptInputTextarea({
  className = "",
  onKeyDown,
  disableAutosize = false,
  ...props
}: {
  disableAutosize?: boolean;
} & React.ComponentProps<"textarea">) {
  const { value, setValue, maxHeight, onSubmit, disabled } = usePromptInput();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (disableAutosize) return;
    const el = textareaRef.current;
    if (!el) return;

    // Reset before measuring: `scrollHeight` only shrinks if the element is
    // allowed to, so without this the box grows and never comes back.
    el.style.height = "auto";
    el.style.height =
      typeof maxHeight === "number"
        ? `${Math.min(el.scrollHeight, maxHeight)}px`
        : `min(${el.scrollHeight}px, ${maxHeight})`;
  }, [value, maxHeight, disableAutosize]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        // Enter sends, shift+enter breaks the line.
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit?.();
        }
        onKeyDown?.(event);
      }}
      rows={1}
      disabled={disabled}
      className={`min-h-[44px] w-full resize-none border-none bg-transparent px-3 py-2 text-sm text-heading outline-none placeholder:text-body disabled:opacity-60 ${className}`}
      {...props}
    />
  );
}

export function PromptInputActions({
  children,
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`flex items-center gap-2 ${className}`} {...props}>
      {children}
    </div>
  );
}

export function PromptInputAction({
  tooltip,
  children,
}: {
  tooltip: string;
  children: React.ReactNode;
}) {
  return <span title={tooltip}>{children}</span>;
}

/**
 * The send button.
 *
 * The project's `accent` for the resting state and hover, matching every other
 * primary action in the app rather than introducing a second button style on the
 * one screen people will use most.
 */
export function PromptInputSubmit({
  disabled,
  isLoading,
  label = "Send",
}: {
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
    >
      {isLoading ? "Working…" : label}
    </button>
  );
}
