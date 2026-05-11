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
      className={`bg-[#1A1D27] rounded-lg border border-[#2D3148] ${p} ${hover ? "hover:border-[#3D4160] transition-colors" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
