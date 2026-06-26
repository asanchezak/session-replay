import { useEffect, useState } from "react";
import type { ReactNode, KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

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
  /** Rows per page; classic Prev/Next pagination appears once data exceeds it. */
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

export default function DataTable<T>({
  columns, data, keyExtractor, emptyState, onRowClick, pageSize = DEFAULT_PAGE_SIZE,
}: DataTableProps<T>) {
  const [page, setPage] = useState(0);

  const total = data.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Snap back into range when the dataset shrinks/changes (e.g. after a delete or refetch).
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1));
  }, [pageCount]);

  if (data.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  const paginated = total > pageSize;
  const start = page * pageSize;
  const visible = data.slice(start, start + pageSize);

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
      {paginated && (
        <div className="flex items-center justify-between gap-3 py-3 px-3 text-text-gray text-xs border-t border-border">
          <span>
            {start + 1}–{Math.min(start + pageSize, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <span>Page {page + 1} of {pageCount}</span>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-text-secondary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Previous page"
            >
              <ChevronLeft size={13} /> Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-text-secondary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Next page"
            >
              Next <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
