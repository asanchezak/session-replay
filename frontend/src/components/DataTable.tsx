import type { ReactNode } from "react";

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

export default function DataTable<T>({
  columns, data, keyExtractor, emptyState, onRowClick,
}: DataTableProps<T>) {
  if (data.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" role="table">
        <thead>
          <tr className="border-b border-[#2D3148]">
            {columns.map((col) => (
              <th
                key={col.key}
                className="text-left text-[#9AA0B0] font-normal text-xs py-3 px-3 first:pl-0 last:pr-0"
                scope="col"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr
              key={keyExtractor(item)}
              onClick={() => onRowClick?.(item)}
              className={`border-b border-[#2D3148] hover:bg-[#242836] transition-colors ${onRowClick ? "cursor-pointer" : ""}`}
            >
              {columns.map((col) => (
                <td key={col.key} className="py-3 px-3 first:pl-0 last:pr-0 text-[#E8EAED]">
                  {col.render(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
