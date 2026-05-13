import type { ReactNode, KeyboardEvent } from "react";

export interface Column<T> {
  key: string;
  label: string;
  render: (item: T) => ReactNode;
  sortable?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  emptyState?: ReactNode;
  onRowClick?: (item: T) => void;
}

const VISIBLE_LIMIT = 100;

export default function DataTable<T>({
  columns, data, keyExtractor, emptyState, onRowClick,
}: DataTableProps<T>) {
  if (data.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  const showAll = data.length <= VISIBLE_LIMIT;
  const visible = data.slice(0, VISIBLE_LIMIT);
  const hiddenCount = data.length - VISIBLE_LIMIT;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" role="table">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th
                key={col.key}
                className="text-left text-text-secondary font-normal text-xs py-3 px-3 first:pl-0 last:pr-0"
                scope="col"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((item) => (
            <tr
              key={keyExtractor(item)}
              onClick={() => onRowClick?.(item)}
              onKeyDown={(e: KeyboardEvent) => {
                if (onRowClick && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onRowClick(item);
                }
              }}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? "button" : undefined}
              className={`border-b border-border hover:bg-bg-elevated transition-colors ${onRowClick ? "cursor-pointer" : ""}`}
            >
              {columns.map((col) => (
                <td key={col.key} className="py-3 px-3 first:pl-0 last:pr-0 text-text-primary">
                  {col.render(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!showAll && (
        <div className="py-3 px-3 text-text-gray text-xs text-center border-t border-border">
          Showing {VISIBLE_LIMIT} of {data.length} rows
        </div>
      )}
    </div>
  );
}
