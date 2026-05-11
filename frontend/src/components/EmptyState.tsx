import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
}

export default function EmptyState({ icon, title, description, actions }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      {icon && <div className="mb-4 text-[#6B7280]">{icon}</div>}
      <h3 className="text-[#E8EAED] font-medium text-base mb-2">{title}</h3>
      <p className="text-[#9AA0B0] text-sm max-w-md mb-6">{description}</p>
      {actions && <div className="flex gap-3">{actions}</div>}
    </div>
  );
}
