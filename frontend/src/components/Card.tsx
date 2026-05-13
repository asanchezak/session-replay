import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md" | "lg";
  hover?: boolean;
}

export default function Card({ children, className = "", padding = "md", hover = false }: CardProps) {
  const p = padding === "sm" ? "p-3" : padding === "lg" ? "p-6" : "p-4";
  return (
    <div
      className={`bg-bg-surface rounded-lg border border-border ${p} ${hover ? "hover:border-border-hover transition-colors" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
