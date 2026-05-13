import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface RightDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: ReactNode;
}

export default function RightDrawer({ open, onClose, title, children }: RightDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) {
      document.addEventListener("keydown", handleEscape);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close overlay" />
      <div
        ref={drawerRef}
        className="absolute right-0 top-0 bottom-0 w-[400px] bg-[#1A1D27] border-l border-[#2D3148] shadow-lg flex flex-col"
        style={{ animation: "slideInRight 200ms ease-out" }}
        role="dialog"
        aria-modal="true"
        aria-label={title || "Details"}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2D3148]">
          <h2 className="text-sm font-medium text-[#E8EAED]">{title || "Details"}</h2>
          <button
            onClick={onClose}
            className="text-[#6B7280] hover:text-[#E8EAED] transition-colors"
            aria-label="Close drawer"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {children || (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <p className="text-[#6B7280] text-sm">Select an item to inspect</p>
              <p className="text-[#4B5160] text-xs mt-1">
                Step details, event payloads, and screenshots will appear here.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
