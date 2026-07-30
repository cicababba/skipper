"use client";

import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { useT } from "@/lib/app-i18n";
import { useToast, VISIBLE_TOASTS, type ToastVariant } from "@/lib/toast-context";

const BORDER: Record<ToastVariant, string> = {
  info: "border-accent/30",
  success: "border-success/30",
  error: "border-danger/30",
};

function defaultIcon(variant: ToastVariant) {
  if (variant === "success") return <CheckCircle2 size={14} className="text-success" />;
  if (variant === "error") return <AlertCircle size={14} className="text-danger" />;
  return <Info size={14} className="text-accent" />;
}

export function ToastHost() {
  const { t } = useT();
  const { toasts, dismiss } = useToast();

  const visible = toasts.slice(0, VISIBLE_TOASTS);
  if (visible.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[100] flex flex-col items-end gap-2"
    >
      {[...visible].reverse().map((item) => (
        <div
          key={item.id}
          className={`w-80 rounded-xl border ${BORDER[item.variant]} bg-card shadow-2xl p-4 animate-pop-in`}
        >
          <div className={`flex items-center gap-2 ${item.message ? "mb-1" : "mb-3"}`}>
            {item.icon ?? defaultIcon(item.variant)}
            <p className="text-sm font-medium">{item.title}</p>
          </div>
          {item.message && (
            <p className="text-[12px] text-muted/70 leading-relaxed mb-3">{item.message}</p>
          )}
          <div className="flex items-center gap-2">
            {item.action && (
              <button
                onClick={() => {
                  item.action?.onClick();
                  dismiss(item.id);
                }}
                className="px-3 py-1.5 rounded-lg bg-accent text-background text-xs font-medium hover:bg-accent-hover transition-colors"
              >
                {item.action.label}
              </button>
            )}
            <button
              onClick={() => {
                item.onDismiss?.();
                dismiss(item.id);
              }}
              className="px-3 py-1.5 rounded-lg text-xs text-muted/70 hover:text-foreground transition-colors"
            >
              {item.dismissLabel ?? t.common.toast.dismiss}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
