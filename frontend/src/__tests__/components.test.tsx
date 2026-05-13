/**
 * Component tests for the shared UI primitives.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Save } from "lucide-react";

import Banner from "../../src/components/Banner";
import Card from "../../src/components/Card";
import EmptyState from "../../src/components/EmptyState";
import DataTable from "../../src/components/DataTable";
import StatusBadge from "../../src/components/StatusBadge";

describe("Banner", () => {
  it.each(["info", "success", "warning", "error"] as const)("renders %s variant", (type) => {
    render(<Banner type={type} title={`${type}-title`}>{type} body</Banner>);
    expect(screen.getByText(`${type}-title`)).toBeInTheDocument();
    expect(screen.getByText(`${type} body`)).toBeInTheDocument();
  });

  it("renders an action region when provided", () => {
    render(
      <Banner type="info" title="t" action={<button>Do it</button>}>
        body
      </Banner>,
    );
    expect(screen.getByRole("button", { name: "Do it" })).toBeInTheDocument();
  });
});

describe("Card", () => {
  it("renders children", () => {
    render(<Card>hello</Card>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it.each([
    ["sm", "p-3"],
    ["md", "p-4"],
    ["lg", "p-6"],
  ] as const)("padding=%s applies %s class", (p, cls) => {
    const { container } = render(<Card padding={p}>x</Card>);
    expect(container.firstChild).toHaveClass(cls);
  });
});

describe("EmptyState", () => {
  it("renders title, description, icon, and actions", () => {
    render(
      <EmptyState
        icon={<Save data-testid="save-icon" />}
        title="Nothing here"
        description="Try adjusting filters"
        actions={<button>Reset</button>}
      />,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Try adjusting filters")).toBeInTheDocument();
    expect(screen.getByTestId("save-icon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("omits actions when not provided", () => {
    render(<EmptyState title="t" description="d" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("DataTable", () => {
  type Row = { id: string; name: string };
  const cols = [
    { key: "name", label: "Name", render: (r: Row) => r.name },
  ];

  it("renders rows", () => {
    render(
      <DataTable<Row>
        columns={cols}
        data={[{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }]}
        keyExtractor={(r) => r.id}
      />,
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("invokes onRowClick on row click", () => {
    const fn = vi.fn();
    render(
      <DataTable<Row>
        columns={cols}
        data={[{ id: "a", name: "Alice" }]}
        keyExtractor={(r) => r.id}
        onRowClick={fn}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    expect(fn).toHaveBeenCalledWith({ id: "a", name: "Alice" });
  });

  it("renders emptyState when data is empty", () => {
    render(
      <DataTable<Row>
        columns={cols}
        data={[]}
        keyExtractor={(r) => r.id}
        emptyState={<div>No data</div>}
      />,
    );
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it.fails("F-C-08: clickable row is keyboard-navigable", () => {
    const fn = vi.fn();
    render(
      <DataTable<Row>
        columns={cols}
        data={[{ id: "a", name: "Alice" }]}
        keyExtractor={(r) => r.id}
        onRowClick={fn}
      />,
    );
    // Row should be focusable and Enter should trigger the handler.
    const row = screen.getByText("Alice").closest("tr")!;
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(fn).toHaveBeenCalled();
  });
});

describe("StatusBadge", () => {
  it.each([
    ["idle", "Idle"],
    ["running", "Running"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["waiting_for_user", "Waiting"],
  ] as const)("run status %s renders label %s", (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByLabelText(`Status: ${label}`)).toBeInTheDocument();
  });

  it.each([
    ["draft", "Draft"],
    ["active", "Active"],
    ["archived", "Archived"],
  ] as const)("workflow status %s renders label %s", (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByLabelText(`Status: ${label}`)).toBeInTheDocument();
  });
});
